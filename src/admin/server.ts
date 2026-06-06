import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { getMenu } from "../services/menu.js";
import { listOrders, setOrderStatus } from "../services/order.js";
import { eventBus, notifyAdminOfEvent } from "../services/events.js";

process.env.IS_ADMIN_SERVER = "true";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Very small password gate. Send password as `x-admin-password` header or ?pw=.
function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const pw = req.header("x-admin-password") ?? (req.query.pw as string);
  if (pw !== config.adminPassword) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

export function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  const api = express.Router();
  api.use(auth);

  // --- Categories ---
  api.get("/categories", async (_req, res) => {
    res.json(await prisma.category.findMany({ orderBy: { sortOrder: "asc" } }));
  });
  api.post("/categories", async (req, res) => {
    const { name, sortOrder } = req.body;
    const category = await prisma.category.create({ data: { name, sortOrder: sortOrder ?? 0 } });
    await notifyAdminOfEvent("menu_updated", { type: "category_created", category });
    res.json(category);
  });
  api.delete("/categories/:id", async (req, res) => {
    const id = Number(req.params.id);
    await prisma.category.delete({ where: { id } });
    await notifyAdminOfEvent("menu_updated", { type: "category_deleted", id });
    res.json({ ok: true });
  });

  // --- Menu items ---
  api.get("/menu", async (_req, res) => {
    res.json(await getMenu({ includeUnavailable: true }));
  });
  api.post("/items", async (req, res) => {
    const { name, description, price, categoryId, isVeg, spiceLevel, available } = req.body;
    const item = await prisma.menuItem.create({
      data: {
        name,
        description,
        price: Number(price),
        categoryId: Number(categoryId),
        isVeg: !!isVeg,
        spiceLevel,
        available: available ?? true,
      },
    });
    await notifyAdminOfEvent("menu_updated", { type: "item_created", item });
    res.json(item);
  });
  api.put("/items/:id", async (req, res) => {
    const { name, description, price, categoryId, isVeg, spiceLevel, available } = req.body;
    const id = Number(req.params.id);
    const data: any = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (price !== undefined) data.price = Number(price);
    if (categoryId !== undefined) data.categoryId = Number(categoryId);
    if (isVeg !== undefined) data.isVeg = !!isVeg;
    if (spiceLevel !== undefined) data.spiceLevel = spiceLevel;
    if (available !== undefined) data.available = !!available;
    const item = await prisma.menuItem.update({ where: { id }, data });
    await notifyAdminOfEvent("menu_updated", { type: "item_updated", item });
    res.json(item);
  });
  api.delete("/items/:id", async (req, res) => {
    const id = Number(req.params.id);
    await prisma.menuItem.delete({ where: { id } });
    await notifyAdminOfEvent("menu_updated", { type: "item_deleted", id });
    res.json({ ok: true });
  });

  // --- Orders ---
  api.get("/orders", async (req, res) => {
    res.json(await listOrders(req.query.status as string | undefined));
  });
  api.put("/orders/:id/status", async (req, res) => {
    res.json(await setOrderStatus(Number(req.params.id), req.body.status));
  });

  // --- Customers ---
  api.get("/customers", async (_req, res) => {
    res.json(
      await prisma.customer.findMany({
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { orders: true } } },
        take: 200,
      }),
    );
  });
  api.get("/customers/:id/messages", async (req, res) => {
    res.json(
      await prisma.message.findMany({
        where: { customerId: Number(req.params.id) },
        orderBy: { createdAt: "asc" },
      }),
    );
  });
  api.put("/customers/:id", async (req, res) => {
    const { name, address, notes } = req.body;
    const customer = await prisma.customer.update({
      where: { id: Number(req.params.id) },
      data: { name, address, notes },
    });
    await notifyAdminOfEvent("customer_updated", customer);
    res.json(customer);
  });

  // --- Real-time Events (SSE & Internal Webhook) ---
  api.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const onEvent = (event: any) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    eventBus.on("event", onEvent);

    req.on("close", () => {
      eventBus.off("event", onEvent);
    });
  });

  api.post("/internal/events", (req, res) => {
    const { type, data } = req.body;
    eventBus.emit("event", { type, data });
    res.json({ ok: true });
  });

  // Lightweight check so the UI can validate the password.
  api.get("/ping", (_req, res) => res.json({ ok: true }));

  app.use("/api", api);
  return app;
}

// Run standalone: `npm run admin`
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  buildAdminApp().listen(config.adminPort, () => {
    console.log(`🛠️  Admin portal: http://localhost:${config.adminPort}`);
  });
}
