/** @format */

// src/config/database.ts
/** @format */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrisma() {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

  // ⬇️ แทน prisma.$use(...) ด้วย Client Extension
  const prisma = base.$extends({
    name: "soft-active-filter",
    query: {
      user: {
        findMany({ args, query }) {
          args.where ??= {};
          if ((args.where as any).isActive === undefined) {
            (args.where as any).isActive = true;
          }
          return query(args);
        },
        findFirst({ args, query }) {
          args.where ??= {};
          if ((args.where as any).isActive === undefined) {
            (args.where as any).isActive = true;
          }
          return query(args);
        },
      },
    },
  });

  return prisma;
}

export const prisma = globalForPrisma.prisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma; // ป้องกันสร้างหลาย instance ตอน hot-reload
}
