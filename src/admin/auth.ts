import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { prisma } from "../db.js";

// Augment Express Request so TypeScript knows req.restaurantId / req.isFounder exist.
declare global {
  namespace Express {
    interface Request {
      restaurantId: number;
      isFounder?: boolean;
    }
  }
}

const COOKIE = "session";
const FOUNDER_COOKIE = "founder-session";
const TTL_S = 24 * 60 * 60; // 24 hours

interface TokenPayload {
  restaurantId: number;
  isMaster?: boolean;
}

interface FounderPayload {
  role: "founder";
}

function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: TTL_S });
}

function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, config.jwtSecret) as TokenPayload;
}

function setCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: TTL_S * 1000,
  });
}

function setFounderCookie(res: Response, token: string) {
  res.cookie(FOUNDER_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: TTL_S * 1000,
    path: "/",
  });
}

// ── Founder auth ──────────────────────────────────────────────────────────

export async function founderLoginHandler(req: Request, res: Response): Promise<void> {
  const { password } = req.body as { password?: string };
  const founderPw = process.env.FOUNDER_PASSWORD ?? config.adminPassword;
  if (!password || !founderPw || password !== founderPw) {
    res.status(401).json({ error: "invalid founder password" });
    return;
  }
  const token = jwt.sign({ role: "founder" } as FounderPayload, config.jwtSecret, { expiresIn: TTL_S });
  setFounderCookie(res, token);
  res.json({ ok: true });
}

export function founderLogoutHandler(_req: Request, res: Response): void {
  res.clearCookie(FOUNDER_COOKIE, { path: "/" });
  res.json({ ok: true });
}

export function founderMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[FOUNDER_COOKIE] ?? req.header("x-founder-token");
  if (!token) {
    res.status(401).json({ error: "founder session required" });
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret) as FounderPayload;
    if (payload.role !== "founder") throw new Error("not founder");
    req.isFounder = true;
    next();
  } catch {
    res.clearCookie(FOUNDER_COOKIE, { path: "/" });
    res.status(401).json({ error: "founder session expired" });
  }
}

// POST /api/auth/login
export async function loginHandler(req: Request, res: Response): Promise<void> {
  const { password, restaurantId: bodyRestaurantId } = req.body as {
    password?: string;
    restaurantId?: number;
  };

  if (!password) {
    res.status(400).json({ error: "password required" });
    return;
  }

  let restaurantId: number;
  let isMaster = false;

  // Master env password — can optionally specify which restaurantId to scope to.
  if (config.adminPassword && password === config.adminPassword) {
    isMaster = true;
    if (bodyRestaurantId) {
      restaurantId = Number(bodyRestaurantId);
    } else {
      const r = await prisma.botConfig.findFirst({ where: { isActive: true } });
      if (!r) {
        res.status(500).json({ error: "no active restaurant found" });
        return;
      }
      restaurantId = r.id;
    }
  } else {
    // Per-restaurant password stored in BotConfig.
    const r = await prisma.botConfig.findFirst({
      where: { dashboardPassword: password, isActive: true },
    });
    if (!r) {
      res.status(401).json({ error: "invalid password" });
      return;
    }
    restaurantId = r.id;
  }

  const token = signToken({ restaurantId, isMaster });
  setCookie(res, token);

  const restaurant = await prisma.botConfig.findUnique({ where: { id: restaurantId } });
  res.json({ ok: true, restaurantId, restaurantName: restaurant?.restaurantName });
}

// POST /api/auth/logout
export function logoutHandler(_req: Request, res: Response): void {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}

// GET /api/auth/me
export async function meHandler(req: Request, res: Response): Promise<void> {
  // authMiddleware runs first so req.restaurantId is set.
  const restaurant = await prisma.botConfig.findUnique({ where: { id: req.restaurantId } });
  res.json({ restaurantId: req.restaurantId, restaurantName: restaurant?.restaurantName });
}

// Middleware — validates session cookie or x-session-token header.
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE] ?? req.header("x-session-token");
  if (!token) {
    res.status(401).json({ error: "not authenticated — POST /api/auth/login first" });
    return;
  }
  try {
    const payload = verifyToken(token);
    req.restaurantId = payload.restaurantId;
    next();
  } catch {
    res.clearCookie(COOKIE);
    res.status(401).json({ error: "session expired — please log in again" });
  }
}
