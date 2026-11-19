import type { FastifyInstance } from "fastify";
import { ChamberToggleBodySchema, UpdateOwnProfileBodySchema, type MeResponse } from "@chamberai/shared";
import { isAdmin, requireDoctor, requireUser, toDoctorProfile, type DoctorRow } from "../auth";
import { q1 } from "../db";
import { uuidParam } from "../lib/request";
import {
  ackAlert,
  getVisitDetail,
  listOpenAlerts,
  listOwnVisits,
  markPasswordChanged,
  markSeen,
  searchByCode,
  setChamberOpen,
  updateOwnProfile,
} from "../services/doctor";

/**
 * ডাক্তারের API।
 * - প্রত্যেক ডাক্তারের আলাদা লগইন; টোকেন থেকেই কে লগইন করেছেন তা নির্ধারিত হয় —
 *   কেউ অন্যের ড্যাশবোর্ডে ঢুকতে পারেন না।
 * - নিজের তালিকা = শুধু নিজের রোগী। কোড-সার্চ = সব ডাক্তারের রোগী (অডিট লগসহ)।
 */
export async function doctorRoutes(app: FastifyInstance) {
  // যেকোনো লগইন-করা ইউজার (ডাক্তার বা অ্যাডমিন) — লগইনের পর কোথায় যাবেন ঠিক করতে
  app.get("/api/me", { preHandler: requireUser }, async (req): Promise<MeResponse> => {
    const user = req.user!;
    const doctor = await q1<DoctorRow>("select * from public.doctors where id = $1", [user.userId]);
    return {
      userId: user.userId,
      email: user.email,
      isAdmin: await isAdmin(user.userId),
      doctor: doctor ? toDoctorProfile(doctor) : null,
    };
  });

  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireDoctor);

    scoped.post("/api/doctor/me/password-changed", async (req) => {
      await markPasswordChanged(req.doctor!);
      return { ok: true };
    });

    scoped.patch("/api/doctor/me/profile", async (req) => {
      await updateOwnProfile(req.doctor!, UpdateOwnProfileBodySchema.parse(req.body));
      return { ok: true };
    });

    scoped.post("/api/doctor/me/chamber", async (req) => {
      const body = ChamberToggleBodySchema.parse(req.body);
      await setChamberOpen(req.doctor!, body.isOpen);
      return { ok: true, isOpen: body.isOpen };
    });

    scoped.get<{ Querystring: { date?: string } }>("/api/doctor/visits", async (req) => {
      return listOwnVisits(req.doctor!, req.query.date);
    });

    scoped.get<{ Querystring: { code?: string; date?: string } }>("/api/doctor/search", async (req) => {
      return searchByCode(req.doctor!, req.query.code ?? "", req.query.date);
    });

    scoped.get<{ Params: { id: string } }>("/api/doctor/visits/:id", async (req) => {
      return getVisitDetail(req.doctor!, uuidParam(req.params.id));
    });

    scoped.post<{ Params: { id: string } }>("/api/doctor/visits/:id/seen", async (req) => {
      await markSeen(req.doctor!, uuidParam(req.params.id));
      return { ok: true };
    });

    scoped.get("/api/doctor/alerts", async (req) => {
      return listOpenAlerts(req.doctor!);
    });

    scoped.post<{ Params: { id: string } }>("/api/doctor/alerts/:id/ack", async (req) => {
      await ackAlert(req.doctor!, uuidParam(req.params.id));
      return { ok: true };
    });
  });
}
