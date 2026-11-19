import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { env } from "../config";
import { recordUsage, type LlmPurpose } from "./quota";

export class QuotaExhaustedError extends Error {
  constructor(public readonly model: string) {
    super(`Daily quota exhausted for ${model}`);
    this.name = "QuotaExhaustedError";
  }
}

export type LlmPart = { text: string } | { inlineData: { mimeType: string; data: string } };

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  client ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return client;
}

// কিছু মডেল/ভার্সন JSON Schema সাপোর্ট না করলে একবার 400 পেয়ে প্রম্পট-নির্ভর মোডে চলে যাই
let jsonSchemaSupported = true;
const schemaCache = new WeakMap<object, Record<string, unknown>>();

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const cached = schemaCache.get(schema);
  if (cached) return cached;
  const js = z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) as Record<string, unknown>;
  delete js.$schema;
  schemaCache.set(schema, js);
  return js;
}

export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error("No JSON object in model output");
  }
}

function statusOf(err: unknown): number | null {
  const e = err as { status?: unknown; code?: unknown };
  if (typeof e?.status === "number") return e.status;
  if (typeof e?.code === "number") return e.code;
  const m = /\b(4\d\d|5\d\d)\b/.exec(String((err as Error)?.message ?? ""));
  return m ? Number(m[1]) : null;
}

function isDailyQuota(err: unknown): boolean {
  return /per\s?day|perday|requests per day|daily/i.test(String((err as Error)?.message ?? ""));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GenerateJsonOptions<T> {
  model: string;
  purpose: LlmPurpose;
  system: string;
  parts: LlmPart[];
  schema: z.ZodType<T>;
  temperature?: number;
  visitId?: string | null;
  doctorId?: string | null;
  maxAttempts?: number;
}

export interface GenerateJsonResult<T> {
  data: T;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

/**
 * JSON-আউটপুট কল: Zod দিয়ে যাচাই, RPM-এর 429-এ ব্যাকঅফ, দৈনিক কোটা শেষ হলে QuotaExhaustedError,
 * প্রতিটি কল llm_usage-এ লগ (কোটা গোনা ও /docs মেট্রিক্সের জন্য)।
 */
export async function generateJson<T>(o: GenerateJsonOptions<T>): Promise<GenerateJsonResult<T>> {
  const jsonSchema = jsonSchemaOf(o.schema as z.ZodType);
  const maxAttempts = o.maxAttempts ?? 3;
  let parts: LlmPart[] = [...o.parts];
  let lastErr: unknown = null;
  let parseRetries = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let latencyMs = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const started = Date.now();
    try {
      const res = await getClient().models.generateContent({
        model: o.model,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: o.system,
          temperature: o.temperature ?? 0.2,
          responseMimeType: "application/json",
          ...(jsonSchemaSupported ? { responseJsonSchema: jsonSchema } : {}),
        },
      });
      const ms = Date.now() - started;
      const ti = res.usageMetadata?.promptTokenCount ?? 0;
      const to = res.usageMetadata?.candidatesTokenCount ?? 0;
      tokensIn += ti;
      tokensOut += to;
      latencyMs += ms;
      await recordUsage({
        model: o.model,
        purpose: o.purpose,
        ok: true,
        tokensIn: ti,
        tokensOut: to,
        latencyMs: ms,
        visitId: o.visitId,
        doctorId: o.doctorId,
      });

      let candidate: unknown;
      try {
        candidate = extractJson(res.text ?? "");
      } catch (e) {
        candidate = null;
        lastErr = e;
      }
      const parsed = o.schema.safeParse(candidate);
      if (parsed.success) return { data: parsed.data, model: o.model, tokensIn, tokensOut, latencyMs };

      if (parseRetries >= 1) break;
      parseRetries += 1;
      const why = parsed.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      lastErr = new Error(`Model output did not match schema: ${why}`);
      parts = [...o.parts, { text: `Your previous output did not match the JSON schema (${why}). Return ONLY valid JSON for the schema.` }];
    } catch (err) {
      const ms = Date.now() - started;
      const status = statusOf(err);
      await recordUsage({
        model: o.model,
        purpose: o.purpose,
        ok: false,
        errorCode: status ? String(status) : "error",
        latencyMs: ms,
        visitId: o.visitId,
        doctorId: o.doctorId,
      });
      lastErr = err;
      if (status === 400 && jsonSchemaSupported && /schema|json/i.test(String((err as Error)?.message))) {
        jsonSchemaSupported = false;
        continue;
      }
      if (status === 429) {
        if (isDailyQuota(err)) throw new QuotaExhaustedError(o.model);
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      if (status !== null && status >= 500) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("LLM call failed");
}

/** নলেজ-বেস এমবেডিং (একসাথে অনেক টেক্সট এক রিকোয়েস্টে) */
export async function embedTexts(texts: string[], dimensions = 768): Promise<number[][]> {
  if (!env.EMBEDDING_MODEL) throw new Error("EMBEDDING_MODEL is not set");
  const res = await getClient().models.embedContent({
    model: env.EMBEDDING_MODEL,
    contents: texts,
    config: { outputDimensionality: dimensions },
  });
  await recordUsage({ model: env.EMBEDDING_MODEL, purpose: "embed", ok: true });
  return (res.embeddings ?? []).map((e) => e.values ?? []);
}
