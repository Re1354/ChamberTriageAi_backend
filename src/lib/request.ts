import type { FastifyRequest } from "fastify";
import { env } from "../config";
import { HttpError } from "../errors";
import { sha256 } from "./crypto";

export function ipHash(req: FastifyRequest): string {
  return sha256(`${env.IP_HASH_SALT}:${req.ip}`).slice(0, 32);
}

export function sessionSecretHeader(req: FastifyRequest): string {
  const v = req.headers["x-session-secret"];
  const s = Array.isArray(v) ? v[0] : v;
  if (!s || s.length < 20 || s.length > 200) {
    throw new HttpError(401, "invalid_session", "সেশন পাওয়া যায়নি। অনুগ্রহ করে QR আবার স্ক্যান করুন।");
  }
  return s;
}

export function uuidParam(value: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new HttpError(400, "invalid_id", "আইডি সঠিক নয়।");
  return value;
}
