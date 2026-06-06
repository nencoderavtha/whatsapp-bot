import { PrismaClient } from "@prisma/client";

// Single shared Prisma client across the app (bot + admin server).
export const prisma = new PrismaClient();
