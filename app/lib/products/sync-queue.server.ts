import type { PrismaClient } from "@prisma/client";
import { productsForInventoryItem, syncProduct, type AdminGraphql } from "./sync.server";

/**
 * Product webhooks arrive in bursts: a bulk edit of HS codes sends a
 * products/update and an inventory_items/update for every variant, often
 * several per product within seconds. Handling them all at once overloads a
 * small server and makes overlapping syncs of the same product collide.
 *
 * So webhooks only queue work and return immediately. One worker per server
 * resolves inventory items to products, merges duplicates, waits briefly so a
 * burst collapses into one sync per product, then syncs one product at a time.
 * Anything lost on a restart is caught by the next webhook or a full resync.
 */

type Job = { kind: "product" | "inventory_item"; gid: string; attempts: number; notBefore: number };

const DEBOUNCE_MS = 3000;
const MAX_ATTEMPTS = 3;
const RECENT_MS = 10_000; // a product synced this recently is not synced again

type ShopQueue = {
  db: PrismaClient;
  graphql: AdminGraphql;
  jobs: Map<string, Job>; // key kind:gid → deduplicated
  running: boolean;
  recent: Map<string, number>; // product gid → time of last sync
};

const queues = new Map<string, ShopQueue>();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type QueueOptions = { debounceMs?: number; retryDelayMs?: number; recentMs?: number };
let opts: Required<QueueOptions> = { debounceMs: DEBOUNCE_MS, retryDelayMs: 5000, recentMs: RECENT_MS };
/** Test hook. */
export function configureSyncQueue(o: QueueOptions) { opts = { ...opts, ...o }; }

export function enqueueSync(db: PrismaClient, graphql: AdminGraphql, shop: string, kind: Job["kind"], gid: string) {
  let q = queues.get(shop);
  if (!q) { q = { db, graphql, jobs: new Map(), running: false, recent: new Map() }; queues.set(shop, q); }
  q.db = db; q.graphql = graphql; // keep the latest session's client
  const key = `${kind}:${gid}`;
  if (!q.jobs.has(key)) q.jobs.set(key, { kind, gid, attempts: 0, notBefore: 0 });
  if (!q.running) void run(shop, q);
}

/** Resolves when the shop's queue is empty (tests and graceful shutdown). */
export async function drainSyncQueue(shop: string) {
  while (queues.get(shop)?.running) await wait(20);
}

async function run(shop: string, q: ShopQueue) {
  q.running = true;
  try {
    await wait(opts.debounceMs); // let the burst arrive
    while (q.jobs.size) {
      const now = Date.now();
      const due = [...q.jobs.entries()].filter(([, j]) => j.notBefore <= now);
      if (!due.length) {
        await wait(Math.max(20, Math.min(...[...q.jobs.values()].map((j) => j.notBefore)) - now));
        continue;
      }
      // Inventory items first, so their products join the queue and dedupe.
      const [key, job] = due.find(([, j]) => j.kind === "inventory_item") ?? due[0];
      q.jobs.delete(key);
      try {
        if (job.kind === "inventory_item") {
          for (const p of await productsForInventoryItem(q.graphql, job.gid)) {
            if (!q.jobs.has(`product:${p}`)) q.jobs.set(`product:${p}`, { kind: "product", gid: p, attempts: 0, notBefore: 0 });
          }
        } else {
          const last = q.recent.get(job.gid);
          if (last && now - last < opts.recentMs && job.notBefore === 0) {
            // Synced moments ago, but this webhook may carry a newer edit:
            // sync it once more when the window ends, without holding up others.
            q.jobs.set(key, { ...job, notBefore: last + opts.recentMs });
            continue;
          }
          await syncProduct(q.db, q.graphql, shop, job.gid);
          q.recent.set(job.gid, Date.now());
        }
      } catch (e) {
        job.attempts++;
        if (job.attempts < MAX_ATTEMPTS) {
          console.warn(`[setu] ${job.kind} sync failed for ${shop} ${job.gid} (attempt ${job.attempts}), retrying`, e);
          if (!q.jobs.has(key)) q.jobs.set(key, { ...job, notBefore: Date.now() + opts.retryDelayMs });
        } else {
          console.error(`[setu] ${job.kind} sync gave up for ${shop} ${job.gid}`, e);
        }
      }
      // Forget old "recent" entries so the map stays small.
      if (q.recent.size > 500) for (const [g, t] of q.recent) if (Date.now() - t > opts.recentMs) q.recent.delete(g);
    }
  } finally {
    q.running = false;
    if (q.jobs.size) void run(shop, q); // work arrived while finishing
  }
}
