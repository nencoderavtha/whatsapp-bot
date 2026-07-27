import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { DEFAULT_RESTAURANT_ID } from "../tenancy.js";

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

export async function loginHandler(req: Request, res: Response): Promise<void> {
  const { username, password, restaurantId: bodyRestaurantId } = req.body as {
    username?: string;
    password?: string;
    restaurantId?: number;
  };

  if (!password) {
    res.status(400).json({ error: "password required" });
    return;
  }

  let restaurantId = DEFAULT_RESTAURANT_ID;
  let isMaster = false;

  try {
    if (config.adminPassword && password === config.adminPassword) {
      isMaster = true;
      restaurantId = bodyRestaurantId ? Number(bodyRestaurantId) : 1;
    } else {
      if (!username) {
        res.status(401).json({ error: "username required" });
        return;
      }
      const r = await prisma.restaurantConfig.findFirst({
        where: { loginUsername: username, dashboardPassword: password, isActive: true },
      });
      if (!r) {
        res.status(401).json({ error: "invalid credentials" });
        return;
      }
      restaurantId = r.id;
    }

    const token = signToken({ restaurantId, isMaster });
    setCookie(res, token);

    const restaurant = await prisma.restaurantConfig.findUnique({ where: { id: restaurantId } });
    res.json({ ok: true, restaurantId, restaurantName: restaurant?.restaurantName });
  } catch (e) {
    console.error("[auth] login DB error:", e);
    res.status(503).json({ error: "Service temporarily unavailable — please try again in a moment" });
  }
}

export function logoutHandler(_req: Request, res: Response): void {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}

export async function meHandler(req: Request, res: Response): Promise<void> {
  try {
    const restaurant = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
    res.json({ restaurantId: DEFAULT_RESTAURANT_ID, restaurantName: restaurant?.restaurantName });
  } catch (e) {
    console.error("[auth] me DB error:", e);
    res.status(503).json({ error: "Service temporarily unavailable" });
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE] ?? req.header("x-session-token");
  if (!token) {
    res.status(401).json({ error: "not authenticated — POST /api/auth/login first" });
    return;
  }
  try {
    const payload = verifyToken(token);
    req.restaurantId = payload.restaurantId ?? DEFAULT_RESTAURANT_ID;
    next();
  } catch {
    res.clearCookie(COOKIE);
    res.status(401).json({ error: "session expired — please log in again" });
  }
}
