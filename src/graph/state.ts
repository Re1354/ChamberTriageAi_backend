import { Annotation } from "@langchain/langgraph";
import type { AiMode, Category, Question, RedFlagLevel, Sex, SttSource } from "@chamberai/shared";
import type { RedFlagHit } from "../clinical/redFlags";

export interface SlotValue {
  value: string | null;
  evidence: string;
  confidence: number;
  messageId?: string | null;
}

export interface TranscriptEntry {
  role: "assistant" | "patient";
  questionId: string;
  text: string;
  messageId?: string | null;
}

/** interrupt()-এর resume মান (অডিও এখানে নয় — checkpoint ছোট রাখতে অডিও config দিয়ে যায়) */
export interface AnswerPayload {
  kind: "answer";
  questionId: string;
  text: string;
  sttSource: SttSource;
  messageId: string;
}

export interface ChiefComplaint {
  bn: string | null;
  en: string | null;
  durationDays: number | null;
}

/** ইন্টারভিউ-এজেন্টের interrupt মান — রোগীর ফোনে কোন ধাপ দেখাতে হবে */
export type InterviewInterrupt =
  | { type: "question"; question: Question }
  | { type: "comorbidities" }
  | { type: "photos" };

const unique = (a: string[], b: string[]) => Array.from(new Set([...a, ...b]));

export const InterviewAnnotation = Annotation.Root({
  visitId: Annotation<string>(),
  doctorId: Annotation<string>(),
  mode: Annotation<AiMode>({ reducer: (_a, b) => b, default: () => "standard" }),
  ageYears: Annotation<number | null>({ reducer: (_a, b) => b, default: () => null }),
  sex: Annotation<Sex | null>({ reducer: (_a, b) => b, default: () => null }),
  turn: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  aiTurnsUsed: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  category: Annotation<Category | null>({ reducer: (_a, b) => b, default: () => null }),
  chiefComplaint: Annotation<ChiefComplaint | null>({ reducer: (_a, b) => b, default: () => null }),
  slots: Annotation<Record<string, SlotValue>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  askedIds: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  flags: Annotation<string[]>({ reducer: unique, default: () => [] }),
  medicationsMentioned: Annotation<string[]>({ reducer: unique, default: () => [] }),
  redFlagLevel: Annotation<RedFlagLevel>({ reducer: (_a, b) => b, default: () => "none" }),
  alerts: Annotation<RedFlagHit[]>({
    reducer: (a, b) => [...a, ...b.filter((x) => !a.some((y) => y.ruleId === x.ruleId))],
    default: () => [],
  }),
  pendingQuestion: Annotation<Question | null>({ reducer: (_a, b) => b, default: () => null }),
  suggestedNextId: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  needsClarification: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  clarificationQuestionBn: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  clarified: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  lastAnswer: Annotation<AnswerPayload | null>({ reducer: (_a, b) => b, default: () => null }),
  lastAnswerText: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  interviewDone: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  endedEarly: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  comorbidities: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  uploadIds: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  transcript: Annotation<TranscriptEntry[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});

export type InterviewState = typeof InterviewAnnotation.State;
export type InterviewUpdate = typeof InterviewAnnotation.Update;

/** ইন্টারভিউ শেষে visits.interview_state-এ যা রাখা হয় (সামারি-এজেন্টের ইনপুট) */
export interface StoredInterviewState {
  mode: AiMode;
  category: Category | null;
  chiefComplaint: ChiefComplaint | null;
  slots: Record<string, SlotValue>;
  flags: string[];
  alerts: RedFlagHit[];
  redFlagLevel: RedFlagLevel;
  comorbidities: string[];
  medicationsMentioned: string[];
  uploadIds: string[];
  endedEarly: boolean;
  aiTurnsUsed: number;
}

export function toStoredState(s: InterviewState): StoredInterviewState {
  return {
    mode: s.mode,
    category: s.category,
    chiefComplaint: s.chiefComplaint,
    slots: s.slots,
    flags: s.flags,
    alerts: s.alerts,
    redFlagLevel: s.redFlagLevel,
    comorbidities: s.comorbidities,
    medicationsMentioned: s.medicationsMentioned,
    uploadIds: s.uploadIds,
    endedEarly: s.endedEarly,
    aiTurnsUsed: s.aiTurnsUsed,
  };
}
