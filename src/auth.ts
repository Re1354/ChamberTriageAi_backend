import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { DoctorProfile } from "@chamberai/shared";
import { env } from "./config";
import { q1 } from "./db";
import { forbidden, unauthorized } from "./errors";

const jwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
const hsKey = env.SUPABASE_JWT_SECRET ? new TextEncoder().encode(env.SUPABASE_JWT_SECRET) : null;

export interface AuthUser {
  userId: string;
  email: string | null;
}

export interface DoctorRow {
  id: string;
  email: string;
  full_name: string;
  specialty: string | null;
  chamber_name: string | null;
  chamber_address: string | null;
  slug: string;
  is_open: boolean;
  is_active: boolean;
  daily_ai_limit: number;
  must_change_password: boolean;
  created_at: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    doctor?: DoctorRow;
  }
}

/** Supabase access token যাচাই — নতুন প্রজেক্টে JWKS (ES256/RS256), পুরনোতে HS256 secret */
export async function verifyAccessToken(token: string): Promise<AuthUser> {
  let payload: JWTPayload | null = null;
  if (hsKey) {
    try {
      payload = (await jwtVerify(token, hsKey, { audience: "authenticated" })).payload;
    } catch {
      payload = null;
    }
  }
  if (!payload) {
    try {
      payload = (await jwtVerify(token, jwks, { audience: "authenticated" })).payload;
    } catch {
      throw unauthorized();
    }
  }
  if (!payload.sub) throw unauthorized();
  return { userId: payload.sub, email: typeof payload.email === "string" ? payload.email : null };
}

function bearer(req: FastifyRequest): string {
  const raw = req.headers.authorization;
  const h = Array.isArray(raw) ? raw[0] : raw;
  if (!h || !h.startsWith("Bearer ")) throw unauthorized();
  return h.slice("Bearer ".length).trim();
}

export async function requireUser(req: FastifyRequest): Promise<void> {
  req.user = await verifyAccessToken(bearer(req));
}

export async function requireDoctor(req: FastifyRequest): Promise<void> {
  await requireUser(req);
  const doctor = await q1<DoctorRow>("select * from public.doctors where id = $1", [req.user!.userId]);
  if (!doctor) throw forbidden("এই অ্যাকাউন্টটি কোনো ডাক্তারের প্রোফাইলের সাথে যুক্ত নয়।");
  if (!doctor.is_active) throw forbidden("আপনার অ্যাকাউন্ট নিষ্ক্রিয় করা আছে। অ্যাডমিনের সাথে যোগাযোগ করুন।");
  req.doctor = doctor;
}

export async function isAdmin(userId: string): Promise<boolean> {
  const row = await q1("select 1 from public.admins where user_id = $1", [userId]);
  return !!row;
}

export async function requireAdmin(req: FastifyRequest): Promise<void> {
  await requireUser(req);
  if (!(await isAdmin(req.user!.userId))) throw forbidden("শুধু অ্যাডমিন এই কাজ করতে পারেন।");
}

export function toDoctorProfile(d: DoctorRow): DoctorProfile {
  return {
    id: d.id,
    email: d.email,
    fullName: d.full_name,
    specialty: d.specialty,
    chamberName: d.chamber_name,
    chamberAddress: d.chamber_address,
    slug: d.slug,
    isOpen: d.is_open,
    isActive: d.is_active,
    dailyAiLimit: d.daily_ai_limit,
    mustChangePassword: d.must_change_password,
  };
}
