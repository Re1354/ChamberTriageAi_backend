import { END, interrupt, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { COMORBIDITY_IDS, MAX_UPLOADS_PER_VISIT, truncate, type Question, type TurnResult } from "@chamberai/shared";
import { env } from "../config";
import { ALLOWED_FLAGS, detectCategory, keywordFlags } from "../clinical/keywords";
import {
  BANK,
  FIRST_QUESTION,
  MAX_ANSWERED_QUESTIONS,
  nextBankQuestion,
  type BankQuestion,
} from "../clinical/questionBank";
import { evaluateRedFlags, maxLevel } from "../clinical/redFlags";
import { generateJson, QuotaExhaustedError, type LlmPart } from "../llm/gemini";
import { mockTurn, parseDurationDays } from "../llm/mock";
import { TURN_SYSTEM } from "../llm/prompts";
import { canUseAi } from "../llm/quota";
import { TurnResultSchema } from "@chamberai/shared";
import type { AnswerPayload, InterviewState, InterviewUpdate, SlotValue } from "./state";

export function toQuestion(b: BankQuestion): Question {
  return { id: b.id, textBn: b.textBn, hintBn: b.hintBn ?? null, audioUrl: b.audioUrl ?? null };
}

export function aiAllowedForNextTurn(s: Pick<InterviewState, "mode" | "aiTurnsUsed">): boolean {
  return s.mode === "standard" || (s.mode === "lean" && s.aiTurnsUsed < 2);
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** শুরু: প্রথম প্রশ্ন (মূল সমস্যা ও সময়কাল) */
export function startNode(_s: InterviewState): InterviewUpdate {
  return { pendingQuestion: toQuestion(FIRST_QUESTION), turn: 0 };
}

/** রোগীর উত্তরের জন্য থামা (human-in-the-loop) */
export function askNode(s: InterviewState): InterviewUpdate {
  const q = s.pendingQuestion!;
  // ⚠️ interrupt()-এর আগে কোনো side-effect নয় — resume হলে নোড আবার শুরু থেকে চলে
  const answer = interrupt({ type: "question", question: q }) as AnswerPayload;
  return {
    lastAnswer: answer,
    askedIds: [...s.askedIds, q.id],
    transcript: [{ role: "assistant", questionId: q.id, text: q.textBn }],
  };
}

async function runTurnLlm(
  s: InterviewState,
  q: Question,
  answerText: string,
  audio: { b64: string; mimeType: string } | undefined,
): Promise<TurnResult> {
  if (env.MOCK_LLM) {
    return mockTurn({ questionId: q.id, answerText, currentCategory: s.category, hasAudio: !!audio });
  }
  const bank =
    s.category && q.id !== FIRST_QUESTION.id
      ? BANK[s.category].map((b) => ({ id: b.id, fills: b.fills }))
      : Object.values(BANK)
          .flat()
          .map((b) => ({ id: b.id, fills: b.fills }));
  const context = {
    question: { id: q.id, text: q.textBn },
    currentCategory: s.category,
    knownSlots: Object.fromEntries(Object.entries(s.slots).map(([k, v]) => [k, v.value])),
    askedQuestionIds: s.askedIds,
    questionBank: bank,
    patient: { ageYears: s.ageYears, sex: s.sex },
  };
  const parts: LlmPart[] = [
    { text: `Context:\n${JSON.stringify(context)}` },
    { text: `<patient_answer>${answerText || "(see audio)"}</patient_answer>` },
  ];
  if (audio) parts.push({ inlineData: { mimeType: audio.mimeType, data: audio.b64 } });
  const res = await generateJson({
    model: env.MODEL_TURN,
    purpose: "turn",
    system: TURN_SYSTEM,
    parts,
    schema: TurnResultSchema,
    visitId: s.visitId,
    doctorId: s.doctorId,
  });
  return res.data;
}

/** উত্তর বোঝা: AI (মোড/কোটা অনুযায়ী) + সবসময় কীওয়ার্ড-নিয়ম */
export async function processNode(s: InterviewState, config: LangGraphRunnableConfig): Promise<InterviewUpdate> {
  const ans = s.lastAnswer!;
  const q = s.pendingQuestion!;
  const audio = config.configurable?.audio as { b64: string; mimeType: string } | undefined;
  let text = (ans.text ?? "").trim();
  const update: InterviewUpdate = { turn: s.turn + 1 };

  let result: TurnResult | null = null;
  if (aiAllowedForNextTurn(s) && (text || audio) && (env.MOCK_LLM || (await canUseAi("turn")))) {
    try {
      result = await runTurnLlm(s, q, text, audio);
      update.aiTurnsUsed = s.aiTurnsUsed + 1;
    } catch (err) {
      if (err instanceof QuotaExhaustedError) update.mode = "economy";
      else console.warn("[interview] turn LLM failed, falling back to rules:", (err as Error).message);
    }
  }

  const isFirst = q.id === FIRST_QUESTION.id;
  if (result) {
    if (!text && result.transcriptBn) text = result.transcriptBn.trim();
    if ((!s.category || isFirst) && result.category) update.category = result.category;
    const slots: Record<string, SlotValue> = {};
    for (const sl of result.slots) {
      if (sl.value === null || sl.value === "") continue;
      slots[sl.name] = { value: sl.value, evidence: sl.evidence, confidence: sl.confidence, messageId: ans.messageId };
    }
    update.slots = slots;
    update.flags = result.flags.filter((f) => ALLOWED_FLAGS.includes(f));
    update.medicationsMentioned = result.medicationsMentioned;
    if (isFirst || !s.chiefComplaint) {
      update.chiefComplaint = {
        bn: result.chiefComplaintBn ?? (text ? truncate(text, 160) : null),
        en: result.chiefComplaintEn,
        durationDays: result.durationDays ?? parseDurationDays(text),
      };
    }
    update.suggestedNextId = result.suggestedNextQuestionId;
    update.needsClarification = result.needsClarification && !s.clarified;
    update.clarificationQuestionBn = result.clarificationQuestionBn;
  } else {
    update.suggestedNextId = null;
    update.needsClarification = false;
    if (isFirst || !s.chiefComplaint) {
      update.chiefComplaint = {
        bn: text ? truncate(text, 160) : null,
        en: null,
        durationDays: parseDurationDays(text),
      };
    }
  }

  if (!s.category && !update.category) update.category = detectCategory(text) ?? (isFirst ? "general" : null);

  // update.flags-এ আগে শুধু string[] বসানো হয় (Overwrite নয়), তাই cast নিরাপদ
  update.flags = [...((update.flags as string[] | undefined) ?? []), ...keywordFlags(text)];
  update.lastAnswerText = text;
  update.transcript = [
    { role: "patient", questionId: q.id, text: text || "(অডিও উত্তর — লেখা পাওয়া যায়নি)", messageId: ans.messageId },
  ];
  return update;
}

/** বিপদচিহ্ন — নির্ধারিত নিয়ম */
export function redFlagNode(s: InterviewState): InterviewUpdate {
  const res = evaluateRedFlags({
    category: s.category,
    slots: s.slots,
    flags: new Set(s.flags),
    comorbidities: new Set(s.comorbidities),
  });
  return { redFlagLevel: maxLevel(s.redFlagLevel, res.level), alerts: res.hits };
}

/** পরের প্রশ্ন বাছাই — প্রশ্ন-ব্যাংক থেকে (AI নতুন প্রশ্ন বানায় না, শুধু স্পষ্টীকরণ ছাড়া) */
export function planNode(s: InterviewState): InterviewUpdate {
  if (s.redFlagLevel === "emergency") return { interviewDone: true, endedEarly: true, pendingQuestion: null };

  const answered = s.turn;
  if (s.needsClarification && !s.clarified && s.clarificationQuestionBn && answered < MAX_ANSWERED_QUESTIONS) {
    return {
      pendingQuestion: { id: `clarify_${answered}`, textBn: s.clarificationQuestionBn, hintBn: null, audioUrl: null },
      clarified: true,
      needsClarification: false,
    };
  }
  if (answered >= MAX_ANSWERED_QUESTIONS) return { interviewDone: true, pendingQuestion: null };

  const next = nextBankQuestion(s.category ?? "general", s.askedIds, s.slots, s.suggestedNextId);
  if (!next) return { interviewDone: true, pendingQuestion: null };
  return { pendingQuestion: toQuestion(next) };
}

export function routeAfterPlan(s: InterviewState): "ask" | "comorbid" | typeof END {
  if (s.endedEarly) return END;
  if (s.interviewDone) return "comorbid";
  return "ask";
}

/** কোমর্বিডিটি — চেকবক্স (AI লাগে না) */
export function comorbidNode(s: InterviewState): InterviewUpdate {
  const raw = interrupt({ type: "comorbidities" }) as unknown;
  const items = (Array.isArray(raw) ? raw : []).filter((i): i is string => typeof i === "string" && COMORBIDITY_IDS.includes(i));
  const res = evaluateRedFlags({
    category: s.category,
    slots: s.slots,
    flags: new Set(s.flags),
    comorbidities: new Set(items),
  });
  return { comorbidities: items, redFlagLevel: maxLevel(s.redFlagLevel, res.level), alerts: res.hits };
}

export function routeAfterComorbid(s: InterviewState): "photos" | typeof END {
  return s.redFlagLevel === "emergency" ? END : "photos";
}

/** ছবি — রোগী আপলোড শেষ করলে upload id-গুলো আসে */
export function photosNode(_s: InterviewState): InterviewUpdate {
  const raw = interrupt({ type: "photos" }) as unknown;
  const ids = (Array.isArray(raw) ? raw : []).filter((i): i is string => typeof i === "string").slice(0, MAX_UPLOADS_PER_VISIT);
  return { uploadIds: ids, interviewDone: true };
}
