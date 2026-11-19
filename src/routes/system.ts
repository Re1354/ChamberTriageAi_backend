import type { FastifyInstance } from "fastify";
import { aiConfigured, env } from "../config";
import { q } from "../db";
import { HttpError } from "../errors";
import { safeEqualStr } from "../lib/crypto";
import { getInterviewGraph } from "../graph/interviewGraph";
import { summaryGraphMermaid } from "../graph/summaryGraph";
import { getMetrics, runCleanup } from "../services/maintenance";

export async function systemRoutes(app: FastifyInstance) {
  app.get("/", async () => ({ name: "chamberai-api", ok: true }));

  // cron-job.org: চেম্বার-সময়ে প্রতি ১০ মিনিটে (সার্ভার জাগিয়ে রাখা); ?db=1 দিলে Supabase-ও সক্রিয় থাকে
  app.get<{ Querystring: { db?: string } }>("/health", async (req) => {
    if (req.query.db) await q("select 1");
    return { ok: true, time: new Date().toISOString(), mockLlm: env.MOCK_LLM, aiEnabled: aiConfigured };
  });

  app.post("/api/cron/cleanup", async (req) => {
    const h = req.headers["x-cron-secret"];
    const secret = Array.isArray(h) ? h[0] : h;
    if (!secret || !safeEqualStr(secret, env.CRON_SECRET)) throw new HttpError(401, "unauthorized", "অনুমতি নেই।");
    return runCleanup();
  });

  app.get("/api/metrics", async () => getMetrics());

  // /docs পেজের জন্য: দুই এজেন্টের লাইভ গ্রাফ (Mermaid)
  app.get("/api/graphs", async () => {
    const interview = await getInterviewGraph();
    return {
      interview: (await interview.getGraphAsync()).drawMermaid(),
      summary: summaryGraphMermaid(),
    };
  });
}
