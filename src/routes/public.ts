import type { FastifyInstance } from "fastify";
import { RespondBodySchema, StartVisitBodySchema, UploadUrlBodySchema } from "@chamberai/shared";
import { enforceRateLimit } from "../lib/rateLimit";
import { ipHash, sessionSecretHeader, uuidParam } from "../lib/request";
import { createUploadUrl, getDoctorPublic, getVisitState, respond, startVisit } from "../services/visits";

/** রোগীর দিকের API — লগইন লাগে না; প্রতিটি ভিজিট নিজস্ব গোপন session key দিয়ে সুরক্ষিত */
export async function publicRoutes(app: FastifyInstance) {
  app.get<{ Params: { slug: string } }>("/api/public/doctors/:slug", async (req) => {
    return getDoctorPublic(req.params.slug);
  });

  app.post("/api/visits/start", async (req) => {
    const body = StartVisitBodySchema.parse(req.body);
    return startVisit(body, ipHash(req));
  });

  app.get<{ Params: { id: string } }>("/api/visits/:id/state", async (req) => {
    return getVisitState(uuidParam(req.params.id), sessionSecretHeader(req));
  });

  app.post<{ Params: { id: string } }>("/api/visits/:id/respond", async (req) => {
    const visitId = uuidParam(req.params.id);
    await enforceRateLimit(`respond:${visitId}`, 3600, 60);
    const body = RespondBodySchema.parse(req.body);
    return respond(visitId, sessionSecretHeader(req), body);
  });

  app.post<{ Params: { id: string } }>("/api/visits/:id/upload-url", async (req) => {
    const visitId = uuidParam(req.params.id);
    await enforceRateLimit(`upload:${visitId}`, 3600, 30);
    const body = UploadUrlBodySchema.parse(req.body);
    return createUploadUrl(visitId, sessionSecretHeader(req), body);
  });
}
