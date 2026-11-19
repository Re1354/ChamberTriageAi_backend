import Fastify from "fastify";
import cors from "@fastify/cors";
import { allowedOrigins, env, isProd } from "./config";
import { pool } from "./db";
import { errorHandler } from "./errors";
import { getInterviewGraph } from "./graph/interviewGraph";
import { adminRoutes } from "./routes/admin";
import { doctorRoutes } from "./routes/doctor";
import { publicRoutes } from "./routes/public";
import { systemRoutes } from "./routes/system";
import { startWorker, stopWorker } from "./services/worker";

function originAllowed(origin: string): boolean {
  return allowedOrigins.some((o) => {
    if (o === "*" || o === origin) return true;
    // "https://*.vercel.app" ধরনের preview-ডোমেইন
    if (o.includes("*.")) {
      const [scheme, host] = o.split("*.");
      return origin.startsWith(scheme!) && origin.endsWith(`.${host}`);
    }
    return false;
  });
}

const app = Fastify({
  logger: { level: isProd ? "info" : "debug" },
  trustProxy: true,
  bodyLimit: 10 * 1024 * 1024, // অডিও (base64) সহ
});

await app.register(cors, {
  origin: (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) =>
    cb(null, !origin || originAllowed(origin)),
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Session-Secret"],
  maxAge: 86400,
});

app.setErrorHandler(errorHandler);
// API-র উত্তর কোনো CDN/প্রক্সি (Vercel) বা ব্রাউজার যেন ক্যাশ না করে
app.addHook("onSend", async (_req, reply, payload) => {
  if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
  return payload;
});
await app.register(systemRoutes);
await app.register(publicRoutes);
await app.register(doctorRoutes);
await app.register(adminRoutes);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  stopWorker();
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: env.PORT, host: env.HOST });

// গ্রাফ ও checkpointer আগেভাগে প্রস্তুত (প্রথম রোগীকে অপেক্ষা করাতে না)
getInterviewGraph()
  .then(() => app.log.info("interview graph ready"))
  .catch((err) => app.log.error({ err }, "interview graph init failed"));

if (env.RUN_WORKER) startWorker(app.log);
