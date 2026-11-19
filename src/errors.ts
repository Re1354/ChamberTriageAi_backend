import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly messageBn: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(`${code}: ${messageBn}`);
  }
}

export const notFound = (what = "তথ্য") => new HttpError(404, "not_found", `${what} পাওয়া যায়নি।`);
export const forbidden = (msg = "এই কাজের অনুমতি নেই।") => new HttpError(403, "forbidden", msg);
export const unauthorized = () =>
  new HttpError(401, "unauthorized", "লগইন সেশন শেষ হয়েছে। অনুগ্রহ করে আবার লগইন করুন।");
export const tooMany = (msg = "অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।") =>
  new HttpError(429, "rate_limited", msg);

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) {
    return reply.status(err.status).send({ code: err.code, message: err.messageBn, ...err.extra });
  }
  if (err instanceof ZodError) {
    return reply.status(400).send({
      code: "invalid_input",
      message: "পাঠানো তথ্য সঠিক নয়।",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const fe = err as FastifyError;
  if (fe.statusCode && fe.statusCode < 500) {
    return reply.status(fe.statusCode).send({ code: fe.code ?? "bad_request", message: "অনুরোধটি সঠিক নয়।" });
  }
  req.log.error({ err }, "unhandled error");
  return reply.status(500).send({ code: "server_error", message: "সার্ভারে একটি সমস্যা হয়েছে। আবার চেষ্টা করুন।" });
}
