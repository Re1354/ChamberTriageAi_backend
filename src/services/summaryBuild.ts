import {
  COMORBIDITIES,
  SummaryLlmSchema,
  truncate,
  type AiMode,
  type Evidence,
  type LabValue,
  type Medicine,
  type Sex,
  type SummaryItem,
  type SummaryLlm,
  type UploadKind,
} from "@chamberai/shared";
import { env } from "../config";
import { q, q1 } from "../db";
import { evaluateRedFlags, type RedFlagHit } from "../clinical/redFlags";
import { generateJson, type LlmPart } from "../llm/gemini";
import { SUMMARY_SYSTEM } from "../llm/prompts";
import { maskPii } from "../lib/pii";
import { storage } from "../supabase";
import type { StoredInterviewState } from "../graph/state";

export interface SummaryInput {
  visitId: string;
  doctorId: string;
  mode: AiMode;
  ageYears: number | null;
  sex: Sex | null;
  state: StoredInterviewState;
  messages: { id: string; role: "assistant" | "patient"; questionId: string | null; text: string }[];
  uploads: { id: string; kind: UploadKind; path: string; contentType: string | null }[];
}

const SLOT_LABELS: Record<string, string> = {
  site: "Site",
  onset: "Onset",
  character: "Character",
  radiation: "Radiation",
  associated: "Associated symptoms",
  time_course: "Time course",
  exertional: "Worse on exertion",
  exacerbating: "Aggravating factors",
  relieving: "Relieving factors",
  severity: "Severity",
  relation_food: "Relation to food",
  alarm_gi: "GI alarm features",
  sputum: "Sputum",
  breathlessness: "Breathlessness",
  pattern: "Fever pattern",
  warning: "Warning signs",
  timing: "Timing / morning stiffness",
  triggers: "Triggers",
};
const SLOT_ORDER = Object.keys(SLOT_LABELS);

// ---------------------------------------------------------------------------
// নিয়মভিত্তিক সামারি (AI ছাড়া / কোটা শেষ / MOCK)
// ---------------------------------------------------------------------------
export function buildRulesSummary(input: SummaryInput): SummaryLlm {
  const patientMsgs = input.messages.filter((m) => m.role === "patient");
  const first = patientMsgs[0];
  const cc = input.state.chiefComplaint;

  const chiefComplaint: SummaryItem = {
    text: cc?.en || cc?.bn || first?.text || "Not stated",
    evidence: first ? [{ source: "message", refId: first.id, quote: truncate(first.text, 80) }] : [],
  };

  const hpi: SummaryItem[] = Object.entries(input.state.slots)
    .sort(([a], [b]) => (SLOT_ORDER.indexOf(a) + 100) % 100 - (SLOT_ORDER.indexOf(b) + 100) % 100)
    .slice(0, 5)
    .map(([k, v]) => ({
      text: `${SLOT_LABELS[k] ?? k}: ${v.value}`,
      evidence: v.messageId ? [{ source: "message" as const, refId: v.messageId, quote: v.evidence || null }] : [],
    }));

  const comorbidities: SummaryItem[] = input.state.comorbidities.map((id) => ({
    text: COMORBIDITIES.find((c) => c.id === id)?.en ?? id,
    evidence: [{ source: "checkbox", refId: `comorbidity:${id}`, quote: null }],
  }));

  const medications: Medicine[] = input.state.medicationsMentioned.map((m) => ({
    brand: m,
    generic: null,
    strength: null,
    dosageForm: null,
    uploadId: null,
    genericSource: "patient",
  }));

  const dataGaps: string[] = [];
  if (input.uploads.length) dataGaps.push("ছবিগুলো AI দিয়ে পড়া হয়নি — নিচে ছবি দেখুন।");
  if (input.state.endedEarly) dataGaps.push("জরুরি লক্ষণের কারণে ইন্টারভিউ আগেই শেষ করা হয়েছে।");
  if (!patientMsgs.length) dataGaps.push("রোগী কোনো প্রশ্নের উত্তর দেননি।");

  return SummaryLlmSchema.parse({
    chiefComplaint,
    duration: cc?.durationDays ? `${cc.durationDays} day(s)` : null,
    hpi,
    redFlags: [],
    comorbidities,
    medications,
    labs: [],
    consider: [],
    patientQuotes: patientMsgs.slice(0, 2).map((m) => truncate(m.text, 140)),
    dataGaps,
  });
}

// ---------------------------------------------------------------------------
// AI সামারি — ছবি + সব তথ্য একটি কলেই (ফ্রি কোটা বাঁচাতে)
// ---------------------------------------------------------------------------
async function downloadBase64(path: string): Promise<string | null> {
  const { data, error } = await storage().download(path);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer()).toString("base64");
}

const imageCache = new WeakMap<SummaryInput, Map<string, string | null>>();

export async function generateAiSummary(input: SummaryInput, previousIssues: string[]) {
  const context = {
    patient: { ageYears: input.ageYears, sex: input.sex },
    category: input.state.category,
    chiefComplaint: input.state.chiefComplaint,
    slots: input.state.slots,
    comorbidities: input.state.comorbidities.map((id) => ({
      refId: `comorbidity:${id}`,
      label: COMORBIDITIES.find((c) => c.id === id)?.en ?? id,
    })),
    ruleBasedRedFlags: input.state.alerts.map((a) => ({ ruleId: a.ruleId, level: a.level, reason: a.reasonBn })),
    medicationsMentioned: input.state.medicationsMentioned,
    transcript: input.messages.map((m) => ({ msg_id: m.id, role: m.role, question_id: m.questionId, text: m.text })),
    uploads: input.uploads.map((u) => ({ upload_id: u.id, kind: u.kind })),
  };

  const parts: LlmPart[] = [{ text: `Interview data:\n${JSON.stringify(context)}` }];
  let cache = imageCache.get(input);
  if (!cache) {
    cache = new Map();
    imageCache.set(input, cache);
  }
  for (const u of input.uploads) {
    if (!cache.has(u.id)) cache.set(u.id, await downloadBase64(u.path));
    const b64 = cache.get(u.id);
    if (!b64) continue;
    parts.push({ text: `Image upload_id=${u.id} kind=${u.kind}:` });
    parts.push({ inlineData: { mimeType: u.contentType ?? "image/jpeg", data: b64 } });
  }
  if (previousIssues.length) {
    parts.push({ text: `Your previous draft had these problems, fix them: ${previousIssues.join("; ")}` });
  }

  return generateJson({
    model: env.MODEL_FINAL,
    purpose: "final",
    system: SUMMARY_SYSTEM,
    parts,
    schema: SummaryLlmSchema,
    temperature: 0.1,
    visitId: input.visitId,
    doctorId: input.doctorId,
  });
}

// ---------------------------------------------------------------------------
// পোস্ট-প্রসেস: ওষুধ নরমালাইজ (KB), ল্যাব ফ্ল্যাগ (কোডে), ল্যাব-ভিত্তিক red flag
// ---------------------------------------------------------------------------
export function labFlag(l: LabValue): LabValue["flag"] {
  if (l.value === null) return "unknown";
  if (l.refHigh !== null && l.value > l.refHigh) return "high";
  if (l.refLow !== null && l.value < l.refLow) return "low";
  if (l.refLow !== null || l.refHigh !== null) return "normal";
  return "unknown";
}

async function lookupDrug(brand: string) {
  const row = await q1<{ generic_name: string; strength: string | null; s: number }>(
    `select generic_name, strength, similarity(brand_name, $1) as s
       from public.kb_drugs
      where brand_name % $1 or brand_name ilike $1
      order by s desc
      limit 1`,
    [brand.trim()],
  );
  return row && row.s >= 0.4 ? row : null;
}

/**
 * টেক্সটে উল্লেখ করা ওষুধের ব্র্যান্ড খোঁজা: kb_drugs.search_text-এর প্রথম শব্দ = ইংরেজি ব্র্যান্ড,
 * দ্বিতীয় শব্দ = বাংলা উচ্চারণ (যেমন "Comet কমেট Metformin 500 mg")।
 * ইংরেজি ব্র্যান্ড পুরো-শব্দ হিসেবে মেলানো হয় (Ace ≠ face), বাংলা নাম সাবস্ট্রিং হিসেবে (বিভক্তি থাকতে পারে)।
 */
async function findMentionedDrugs(text: string) {
  if (!text.trim()) return [];
  return q<{ brand_name: string; generic_name: string }>(
    `select distinct on (lower(d.brand_name)) d.brand_name, d.generic_name
       from public.kb_drugs d
      where (split_part(d.search_text, ' ', 1) ~ '^[A-Za-z][A-Za-z0-9-]{2,}$'
             and $1 ~* ('\\m' || split_part(d.search_text, ' ', 1) || '\\M'))
         or (char_length(split_part(d.search_text, ' ', 2)) >= 3
             and split_part(d.search_text, ' ', 2) !~ '^[A-Za-z0-9]'
             and strpos($1, split_part(d.search_text, ' ', 2)) > 0)
      order by lower(d.brand_name)
      limit 8`,
    [text],
  );
}

export async function postprocess(
  input: SummaryInput,
  draft: SummaryLlm,
  generatedBy: "ai" | "rules",
): Promise<{ card: SummaryLlm; labAlerts: RedFlagHit[] }> {
  const medications: Medicine[] = [];
  for (const m of draft.medications) {
    const med: Medicine = { ...m };
    if (med.generic && med.genericSource === "unknown") med.genericSource = med.uploadId ? "label" : "patient";
    if (!med.generic && med.brand) {
      const hit = await lookupDrug(med.brand).catch(() => null);
      if (hit) {
        med.generic = hit.generic_name;
        med.genericSource = "kb";
        med.strength ??= hit.strength;
      }
    }
    medications.push(med);
  }

  // রোগী নিজের কথায় যে ব্র্যান্ড বলেছেন (যেমন "কমেট খাই") — নলেজ বেস থেকে মিলিয়ে যোগ করা।
  // AI না থাকলেও (no_ai/economy মোড) ডাক্তার ওষুধের তালিকা পান। AI যেটা আগেই ধরেছে সেটা আবার যোগ হয় না।
  const patientText = input.messages
    .filter((m) => m.role === "patient")
    .map((m) => m.text)
    .join("\n");
  for (const hit of await findMentionedDrugs(patientText).catch(() => [])) {
    const dup = medications.some(
      (m) =>
        m.brand?.toLowerCase() === hit.brand_name.toLowerCase() ||
        (!!m.generic && m.generic.toLowerCase() === hit.generic_name.toLowerCase() && !m.brand),
    );
    if (!dup) {
      medications.push({
        brand: hit.brand_name,
        generic: hit.generic_name,
        strength: null,
        dosageForm: null,
        uploadId: null,
        genericSource: "kb",
      });
    }
  }

  const labs = draft.labs.map((l) => ({ ...l, flag: labFlag(l) }));

  const res = evaluateRedFlags({
    category: input.state.category,
    slots: input.state.slots,
    flags: new Set(input.state.flags),
    comorbidities: new Set(input.state.comorbidities),
    labs: labs.map((l) => ({ name: l.name, value: l.value })),
  });
  const known = new Set(input.state.alerts.map((a) => a.ruleId));
  const labAlerts = res.hits.filter((h) => !known.has(h.ruleId));

  // নিয়মভিত্তিক red flag-ই প্রামাণ্য; AI-র বাড়তি red flag শুধু রোগীর কথার প্রমাণ থাকলে
  const ruleFlags: SummaryItem[] = [...input.state.alerts, ...labAlerts].map((a) => ({ text: a.reasonBn, evidence: [] }));
  const aiFlags = generatedBy === "ai" ? draft.redFlags.filter((r) => r.evidence.some((e) => e.source === "message")) : [];

  const card: SummaryLlm = {
    ...draft,
    medications,
    labs,
    redFlags: [...ruleFlags, ...aiFlags],
    hpi: draft.hpi.slice(0, 5),
    consider: draft.consider.slice(0, 3),
    patientQuotes: draft.patientQuotes.slice(0, 2).map(maskPii),
  };
  return { card, labAlerts };
}

// ---------------------------------------------------------------------------
// যাচাই: প্রতিটি তথ্যের উৎস আছে কিনা, কোনো রোগ-নির্ণয় ঘোষণা নেই তো
// ---------------------------------------------------------------------------
const DIAGNOSIS_ASSERTION = /\b(diagnosed with|confirmed (?:diagnosis|case)|is suffering from|definitely has|this is (?:an? )?(?:MI|myocardial infarction|stroke))\b/i;

export function verifyCard(input: SummaryInput, card: SummaryLlm): string[] {
  const issues: string[] = [];
  const msgIds = new Set(input.messages.map((m) => m.id));
  const uploadIds = new Set(input.uploads.map((u) => u.id));
  const checkboxIds = new Set(input.state.comorbidities.map((c) => `comorbidity:${c}`));
  const valid = (e: Evidence) =>
    e.source === "message" ? msgIds.has(e.refId) : e.source === "upload" ? uploadIds.has(e.refId) : checkboxIds.has(e.refId);

  const requireEvidence = (label: string, item: SummaryItem) => {
    if (!item.evidence.length) issues.push(`${label}: missing evidence`);
    for (const e of item.evidence) if (!valid(e)) issues.push(`${label}: unknown refId ${e.refId}`);
  };

  if (input.messages.some((m) => m.role === "patient")) requireEvidence("chiefComplaint", card.chiefComplaint);
  card.hpi.forEach((h, i) => requireEvidence(`hpi[${i}]`, h));
  card.comorbidities.forEach((c, i) => requireEvidence(`comorbidities[${i}]`, c));
  card.consider.forEach((c, i) => {
    if (DIAGNOSIS_ASSERTION.test(c.text)) issues.push(`consider[${i}]: states a diagnosis as fact`);
    for (const e of c.evidence) if (!valid(e)) issues.push(`consider[${i}]: unknown refId ${e.refId}`);
  });
  card.labs.forEach((l, i) => {
    if (!l.uploadId || !uploadIds.has(l.uploadId)) issues.push(`labs[${i}]: unknown uploadId`);
  });
  card.medications.forEach((m, i) => {
    if (m.uploadId && !uploadIds.has(m.uploadId)) issues.push(`medications[${i}]: unknown uploadId`);
  });
  return issues;
}
