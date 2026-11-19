import { q1 } from "../db";
import { tooMany } from "../errors";

/**
 * Postgres-ভিত্তিক fixed-window রেট লিমিট।
 * একাধিক সার্ভার-ইনস্ট্যান্সেও সঠিক কাজ করে (in-memory নয়)।
 */
export async function hitRateLimit(key: string, windowSeconds: number, max: number): Promise<boolean> {
  const row = await q1<{ ok: boolean }>("select public.hit_rate_limit($1, $2, $3) as ok", [key, windowSeconds, max]);
  return row?.ok ?? false;
}

export async function enforceRateLimit(key: string, windowSeconds: number, max: number, messageBn?: string) {
  if (!(await hitRateLimit(key, windowSeconds, max))) throw tooMany(messageBn);
}
