import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** রোগীর ব্রাউজারে রাখা গোপন session key (DB-তে শুধু hash) */
export function newSessionSecret(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: sha256(raw) };
}

/** ৬ অঙ্কের র‍্যান্ডম রোগী-কোড (১০০০০০–৯৯৯৯৯৯) */
export function newPatientCode(): string {
  return String(randomInt(100_000, 1_000_000));
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
