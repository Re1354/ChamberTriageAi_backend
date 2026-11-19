import type { Category } from "@chamberai/shared";

/**
 * প্রশ্ন-ব্যাংক।
 * ⚠️ এগুলো উদাহরণ — একজন মেডিসিন বিশেষজ্ঞ যাচাই না করা পর্যন্ত আসল রোগীর ওপর ব্যবহার করবেন না।
 * নতুন প্রশ্ন যোগ করতে শুধু এই ফাইল বদলান; `fills` = কোন SOCRATES-স্লট এই প্রশ্নে পূরণ হয়।
 * `audioUrl`: টিমের কারো গলায় রেকর্ড করে apps/web/public/audio/<id>.mp3 রাখলে এখানে "/audio/<id>.mp3" দিন।
 */
export interface BankQuestion {
  id: string;
  category: Category | "intro";
  fills: string[];
  textBn: string;
  hintBn?: string;
  audioUrl?: string | null;
}

export const FIRST_QUESTION: BankQuestion = {
  id: "intro_q1",
  category: "intro",
  fills: ["chief_complaint", "duration"],
  textBn: "আপনার মূল সমস্যাটা কী, আর কতদিন ধরে হচ্ছে? নিজের ভাষায় বলুন।",
  hintBn: "যেমন: “৪ দিন ধরে বুকে চাপ লাগছে, হাঁটলে বাড়ে”",
};

/** মোট সর্বোচ্চ কয়টি প্রশ্নের উত্তর নেওয়া হবে (প্রথম প্রশ্ন + স্পষ্টীকরণসহ) */
export const MAX_ANSWERED_QUESTIONS = 4;

export const BANK: Record<Category, BankQuestion[]> = {
  cardio: [
    {
      id: "cardio_q1",
      category: "cardio",
      fills: ["character", "exertional"],
      textBn: "ব্যথাটা কেমন লাগে — ভারী চাপ ধরার মতো, জ্বালাপোড়া, নাকি খোঁচা দেওয়ার মতো? হাঁটলে বা সিঁড়ি ভাঙলে কি বাড়ে?",
    },
    {
      id: "cardio_q2",
      category: "cardio",
      fills: ["radiation", "associated"],
      textBn: "ব্যথাটা কি বাম হাত, চোয়াল বা পিঠের দিকে যায়? সাথে ঘাম, শ্বাসকষ্ট, বুক ধড়ফড় বা মাথা ঘোরা হয়?",
    },
    {
      id: "cardio_q3",
      category: "cardio",
      fills: ["time_course", "relieving"],
      textBn: "একবার ব্যথা উঠলে কতক্ষণ থাকে? বিশ্রাম নিলে বা কোনো ওষুধে কি কমে?",
    },
  ],
  gastro: [
    {
      id: "gastro_q1",
      category: "gastro",
      fills: ["site", "character"],
      textBn: "পেটের ঠিক কোন জায়গায় সমস্যা — উপরে মাঝখানে, ডানে, বামে, নাকি নিচে? ব্যথাটা কেমন — জ্বালাপোড়া, মোচড়ানো, নাকি চাপ ধরা?",
    },
    {
      id: "gastro_q2",
      category: "gastro",
      fills: ["relation_food", "associated"],
      textBn: "খাবার খেলে কি বাড়ে, নাকি কমে? সাথে বমি, বমি ভাব, পাতলা পায়খানা বা কোষ্ঠকাঠিন্য আছে?",
    },
    {
      id: "gastro_q3",
      category: "gastro",
      fills: ["alarm_gi"],
      textBn: "বমির সাথে রক্ত গেছে, বা পায়খানা কালো আলকাতরার মতো হয়েছে কি? ওজন কি কমে যাচ্ছে?",
    },
  ],
  neuro: [
    {
      id: "neuro_q1",
      category: "neuro",
      fills: ["onset", "character"],
      textBn: "সমস্যাটা কি হঠাৎ শুরু হয়েছে, নাকি ধীরে ধীরে? মাথাব্যথা হলে কেমন — দপদপে, চাপ ধরা, নাকি এক পাশে?",
    },
    {
      id: "neuro_q2",
      category: "neuro",
      fills: ["associated"],
      textBn: "সাথে কি বমি, চোখে ঝাপসা দেখা, শরীরের এক পাশ অবশ লাগা, কথা জড়িয়ে যাওয়া বা জ্বর আছে?",
    },
    {
      id: "neuro_q3",
      category: "neuro",
      fills: ["time_course", "triggers"],
      textBn: "দিনের কোন সময় বেশি হয়? আলো, শব্দ, ঘুম কম হওয়া বা অন্য কিছুতে কি বাড়ে বা কমে?",
    },
  ],
  resp: [
    {
      id: "resp_q1",
      category: "resp",
      fills: ["character", "sputum"],
      textBn: "কাশি কি শুকনো, নাকি কফ ওঠে? কফ উঠলে কী রঙের — আর কফে কি রক্ত আসে?",
    },
    {
      id: "resp_q2",
      category: "resp",
      fills: ["breathlessness", "exertional"],
      textBn: "শ্বাসকষ্ট হয় কি? হাঁটলে হয়, নাকি বসে থাকলেও হয়? রাতে শ্বাসকষ্টে কি ঘুম ভাঙে?",
    },
    {
      id: "resp_q3",
      category: "resp",
      fills: ["associated"],
      textBn: "সাথে জ্বর, বুকে ব্যথা, বুকে সাঁ সাঁ শব্দ বা ওজন কমা আছে কি?",
    },
  ],
  fever: [
    {
      id: "fever_q1",
      category: "fever",
      fills: ["pattern", "severity"],
      textBn: "জ্বর মাপলে কত পর্যন্ত ওঠে? সারাক্ষণ থাকে, নাকি আসা-যাওয়া করে? কাঁপুনি দিয়ে আসে কি?",
    },
    {
      id: "fever_q2",
      category: "fever",
      fills: ["associated"],
      textBn: "সাথে কি মাথাব্যথা, শরীর ব্যথা, গায়ে র‍্যাশ, কাশি, প্রস্রাবে জ্বালা বা পাতলা পায়খানা আছে?",
    },
    {
      id: "fever_q3",
      category: "fever",
      fills: ["warning"],
      textBn: "মাড়ি বা নাক দিয়ে রক্ত, বারবার বমি, পেটে তীব্র ব্যথা বা খুব দুর্বল লাগা — এর কোনোটা হয়েছে কি?",
    },
  ],
  msk: [
    {
      id: "msk_q1",
      category: "msk",
      fills: ["site", "onset"],
      textBn: "কোন জয়েন্ট বা জায়গায় ব্যথা? কোনো আঘাত বা পড়ে যাওয়ার পর শুরু হয়েছে কি?",
    },
    {
      id: "msk_q2",
      category: "msk",
      fills: ["character", "timing"],
      textBn: "সকালে ঘুম থেকে উঠে জয়েন্ট শক্ত লাগে কি, কতক্ষণ? নড়াচড়া করলে ব্যথা বাড়ে, নাকি কমে?",
    },
    {
      id: "msk_q3",
      category: "msk",
      fills: ["associated"],
      textBn: "জায়গাটা ফোলা, লাল বা গরম হয়েছে কি? হাত-পায়ে ঝিনঝিন বা অবশ ভাব আছে?",
    },
  ],
  general: [
    {
      id: "general_q1",
      category: "general",
      fills: ["character", "exacerbating"],
      textBn: "সমস্যাটা আরেকটু বুঝিয়ে বলুন — কখন বেশি হয়, কিসে বাড়ে বা কমে?",
    },
    {
      id: "general_q2",
      category: "general",
      fills: ["associated"],
      textBn: "এর সাথে আর কোনো সমস্যা আছে কি — যেমন জ্বর, ওজন কমা, ঘুম বা খাওয়ার সমস্যা?",
    },
  ],
};

const ALL = new Map<string, BankQuestion>([
  [FIRST_QUESTION.id, FIRST_QUESTION],
  ...Object.values(BANK)
    .flat()
    .map((q) => [q.id, q] as [string, BankQuestion]),
]);

export function getQuestion(id: string): BankQuestion | undefined {
  return ALL.get(id);
}

export function slotNamesFor(category: Category): string[] {
  return Array.from(new Set(BANK[category].flatMap((q) => q.fills)));
}

export type SlotMap = Record<string, { value: string | null; evidence?: string; confidence?: number } | undefined>;

/** প্রশ্ন-ব্যাংক থেকে পরের প্রশ্ন: যে প্রশ্নের অন্তত একটা স্লট এখনো খালি এবং আগে জিজ্ঞেস করা হয়নি */
export function nextBankQuestion(
  category: Category,
  askedIds: string[],
  slots: SlotMap,
  suggestedId?: string | null,
): BankQuestion | null {
  const list = BANK[category] ?? BANK.general;
  if (suggestedId) {
    const s = list.find((q) => q.id === suggestedId && !askedIds.includes(q.id));
    if (s) return s;
  }
  for (const q of list) {
    if (askedIds.includes(q.id)) continue;
    const hasEmpty = q.fills.some((f) => !slots[f] || slots[f]?.value == null || slots[f]?.value === "");
    if (hasEmpty) return q;
  }
  return null;
}
