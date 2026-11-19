import type { FastifyBaseLogger } from "fastify";
import { env } from "../config";
import { q, q1 } from "../db";
import { summarizeVisit } from "./summary";

/**
 * Postgres-ভিত্তিক job worker (FOR UPDATE SKIP LOCKED)।
 * একাধিক API-ইনস্ট্যান্স চললেও একটা job একবারই চলে; সার্ভার রিস্টার্ট হলেও job হারায় না।
 * বড় স্কেলে একই কোড আলাদা Render "Background Worker"-এ RUN_WORKER=true দিয়ে চালানো যায়।
 */
interface JobRow {
  id: number;
  type: string;
  payload: { visitId?: string };
  attempts: number;
}

let logger: Pick<FastifyBaseLogger, "info" | "error" | "warn"> = console;
let timer: NodeJS.Timeout | null = null;
let running = false;
const MAX_ATTEMPTS = 3;

async function handle(job: JobRow): Promise<void> {
  if (job.type === "summarize" && job.payload.visitId) {
    await summarizeVisit(job.payload.visitId);
    return;
  }
  throw new Error(`Unknown job type ${job.type}`);
}

// কাজ না থাকলে ধীরে ধীরে পোলিং কমানো (৪s → ৩০s) — DB-লোড ও খরচ কমে।
// নতুন job এলে kickWorker() সাথে সাথে চালায়, তাই দেরি হয় না।
const MIN_POLL_MS = 4000;
const MAX_POLL_MS = 30_000;
let pollMs = MIN_POLL_MS;

function schedule(): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void tick().finally(schedule);
  }, pollMs);
  timer.unref?.();
}
let stopped = true;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  let didWork = false;
  try {
    for (let i = 0; i < 10; i++) {
      const job = await q1<JobRow>("select * from public.claim_job($1::text[])", [["summarize"]]);
      if (!job) break;
      didWork = true;
      try {
        await handle(job);
        await q("update public.jobs set status = 'done', finished_at = now(), last_error = null where id = $1", [job.id]);
      } catch (err) {
        const failed = job.attempts >= MAX_ATTEMPTS;
        await q(
          `update public.jobs set status = $2, last_error = $3, locked_at = null,
                  run_after = now() + make_interval(secs => $4)
            where id = $1`,
          [job.id, failed ? "failed" : "queued", String((err as Error)?.stack ?? err).slice(0, 1000), 15 * job.attempts],
        );
        logger.error({ err, jobId: job.id }, "job failed");
      }
    }
  } catch (err) {
    logger.error({ err }, "worker tick failed");
  } finally {
    running = false;
    pollMs = didWork ? MIN_POLL_MS : Math.min(MAX_POLL_MS, Math.round(pollMs * 1.5));
  }
}

export function startWorker(log?: Pick<FastifyBaseLogger, "info" | "error" | "warn">): void {
  if (log) logger = log;
  if (!stopped) return;
  stopped = false;
  pollMs = MIN_POLL_MS;
  void tick().finally(schedule);
  logger.info("summary worker started");
}

export function stopWorker(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** নতুন job এলে সাথে সাথে চালানো (পোলিংয়ের অপেক্ষা না করে) */
export function kickWorker(): void {
  if (!env.RUN_WORKER) return;
  pollMs = MIN_POLL_MS;
  setImmediate(() => void tick());
}
