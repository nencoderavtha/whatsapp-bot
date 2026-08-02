import { PrismaClient } from "@prisma/client";
import { invalidateCustomer } from "./services/customer-cache.js";

// Single shared Prisma client across the app (bot + admin server).
const base = new PrismaClient();

/**
 * Every write to Customer drops that customer from the shared cache.
 *
 * Doing this here rather than at the call sites is the point. There are nine
 * places that update a customer across five files, and a single one that forgot
 * to invalidate would leave a stale delivery address in Redis — the customer is
 * then quoted for, and their food sent to, an address they already changed.
 * A write path added later is covered without anyone remembering.
 *
 * Invalidation runs after the write succeeds and never blocks it: failing to
 * clear a cache entry must not fail an order. The entry expires on its own.
 */
export const prisma = base.$extends({
  query: {
    customer: {
      async $allOperations({ operation, args, query }) {
        const result = await query(args);

        if (
          operation === "create" ||
          operation === "update" ||
          operation === "upsert" ||
          operation === "delete" ||
          operation === "updateMany" ||
          operation === "deleteMany"
        ) {
          const w: any = (args as any)?.where ?? {};
          const r: any = result;
          const phone = r?.phone ?? w?.phone;
          const id = r?.id ?? w?.id;
          if (phone || id !== undefined) {
            void invalidateCustomer({ phone, id });
          }
        }

        return result;
      },
    },
  },
}) as unknown as PrismaClient;
