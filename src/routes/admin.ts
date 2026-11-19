import type { FastifyInstance } from "fastify";
import { CreateDoctorBodySchema, ResetPasswordBodySchema, UpdateDoctorBodySchema } from "@chamberai/shared";
import { requireAdmin } from "../auth";
import { uuidParam } from "../lib/request";
import { createDoctor, listDoctors, resetDoctorPassword, updateDoctor, usage } from "../services/admin";

export async function adminRoutes(app: FastifyInstance) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireAdmin);

    scoped.get("/api/admin/doctors", async () => listDoctors());

    scoped.post("/api/admin/doctors", async (req) => {
      const body = CreateDoctorBodySchema.parse(req.body);
      return createDoctor(req.user!.userId, body);
    });

    scoped.post<{ Params: { id: string } }>("/api/admin/doctors/:id/reset-password", async (req) => {
      const body = ResetPasswordBodySchema.parse(req.body);
      await resetDoctorPassword(req.user!.userId, uuidParam(req.params.id), body.password);
      return { ok: true };
    });

    scoped.patch<{ Params: { id: string } }>("/api/admin/doctors/:id", async (req) => {
      const body = UpdateDoctorBodySchema.parse(req.body);
      await updateDoctor(req.user!.userId, uuidParam(req.params.id), body);
      return { ok: true };
    });

    scoped.get("/api/admin/usage", async () => usage());
  });
}
