import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

/**
 * Neon (and other serverless Postgres) closes idle connections when the
 * database sleeps. The next query on such a connection fails once with
 * "Server has closed the connection" and Prisma drops that connection. Each
 * pooled connection can be stale, so retry until a fresh one is used (at most
 * MAX_ATTEMPTS, above the pool size) so customers never see an error after a
 * quiet period.
 */
const MAX_ATTEMPTS = 12;
const RETRYABLE = /server has closed the connection|connection (?:terminated|closed|reset)|ECONNRESET|P1017/i;

export function isConnectionClosed(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  return !!err && (err.code === "P1017" || RETRYABLE.test(String(err.message ?? "")));
}

function createClient(): PrismaClient {
  const base = new PrismaClient();
  return base.$extends({
    name: "retry-closed-connection",
    query: {
      async $allOperations({ args, query }) {
        for (let attempt = 1; ; attempt++) {
          try {
            return await query(args);
          } catch (e) {
            if (!isConnectionClosed(e) || attempt >= MAX_ATTEMPTS) throw e;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      },
    },
  }) as unknown as PrismaClient; // same model API; typed as PrismaClient for the rest of the app
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createClient();
  }
}

const prisma = global.prismaGlobal ?? createClient();

export default prisma;
