import { bnToEnDigits, truncate, TurnResultSchema, type Category, type SlotFill, type TurnResult } from "@chamberai/shared";
import { detectCategory, keywordFlags } from "../clinical/keywords";

/**
 * MOCK_LLM=true হলে Gemini ছাড়াই নির্ধারিত (deterministic) উত্তর —
 * লোকাল ডেভেলপমেন্ট, লোড টেস্ট ও ফ্রি কোটা বাঁচাতে।
 */
export function parseDurationDays(text: string): number | null {
  const m = /(\d+)\s*(দিন|সপ্তাহ|মাস|বছর|day|week|month|year)/i.exec(bnToEnDigits(text));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit.startsWith("সপ্তাহ") || unit.startsWith("week")) return n * 7;
  if (unit.startsWith("মাস") || unit.startsWith("month")) return n * 30;
  if (unit.startsWith("বছর") || unit.startsWith("year")) return n * 365;
  return n;
}

function find(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? m[0] : null;
}

export function mockTurn(input: {
  questionId: string;
  answerText: string;
  currentCategory: Category | null;
  hasAudio: boolean;
}): TurnResult {
  const text =
    input.answerText ||
    (input.hasAudio ? "(মক ট্রান্সক্রিপ্ট) চার দিন ধরে বুকে চাপ লাগে, হাঁটলে বাড়ে" : "");
  const category = input.currentCategory ?? detectCategory(text) ?? "general";
  const slots: SlotFill[] = [];
  const pressure = find(text, /চাপ|ভার|চাইপা|চেপে/);
  if (pressure) slots.push({ name: "character", value: "pressure", evidence: pressure, confidence: 0.8 });
  const burning = find(text, /জ্বালা/);
  if (burning) slots.push({ name: "character", value: "burning", evidence: burning, confidence: 0.8 });
  const exertion = find(text, /হাঁটলে|সিঁড়ি|পরিশ্রম|কাজ করলে/);
  if (exertion) slots.push({ name: "exertional", value: "true", evidence: exertion, confidence: 0.8 });
  const rest = find(text, /বিশ্রাম|বসে থাকলে|বইসা/);
  if (rest) slots.push({ name: "relieving", value: "rest", evidence: rest, confidence: 0.7 });
  const radiation = find(text, /বাম হাত|চোয়াল|পিঠ/);
  if (radiation) slots.push({ name: "radiation", value: radiation, evidence: radiation, confidence: 0.7 });
  if (!slots.length && text) slots.push({ name: "associated", value: truncate(text, 60), evidence: truncate(text, 60), confidence: 0.4 });

  return TurnResultSchema.parse({
    transcriptBn: input.hasAudio && !input.answerText ? text : null,
    chiefComplaintBn: input.questionId === "intro_q1" ? truncate(text, 140) : null,
    chiefComplaintEn: null,
    category,
    durationDays: input.questionId === "intro_q1" ? parseDurationDays(text) : null,
    slots,
    flags: keywordFlags(text),
    medicationsMentioned: [],
    suggestedNextQuestionId: null,
    needsClarification: text.trim().length < 2,
    clarificationQuestionBn: text.trim().length < 2 ? "দুঃখিত, বুঝতে পারিনি। আরেকবার একটু বুঝিয়ে বলবেন?" : null,
  });
}
