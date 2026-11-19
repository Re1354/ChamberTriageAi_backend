import { PATIENT_MESSAGES_BN, type Category, type RedFlagLevel } from "@chamberai/shared";
import type { SlotMap } from "./questionBank";

/**
 * Red-flag নিয়ম — AI নয়, নির্ধারিত নিয়ম। নিরাপত্তা কখনো AI-কোটার ওপর নির্ভর করবে না।
 * ⚠️ উদাহরণ নিয়ম — একজন ডাক্তার দিয়ে যাচাই করিয়ে নিন। লক্ষ্য: গোল্ডেন সেটে recall ১০০%।
 */
export interface RedFlagContext {
  category: Category | null;
  slots: SlotMap;
  flags: Set<string>;
  comorbidities: Set<string>;
  labs?: { name: string; value: number | null }[];
}

export interface RedFlagHit {
  ruleId: string;
  level: Exclude<RedFlagLevel, "none">;
  reasonBn: string;
  patientMessageBn: string;
}

interface Rule {
  id: string;
  level: Exclude<RedFlagLevel, "none">;
  reasonBn: string;
  patientMessageBn?: string;
  test: (c: RedFlagContext) => boolean;
}

const slotIn = (c: RedFlagContext, name: string, values: string[]) => {
  const v = c.slots[name]?.value?.toLowerCase().trim();
  return !!v && values.some((x) => v.includes(x));
};
const slotTrue = (c: RedFlagContext, name: string) => {
  const v = c.slots[name]?.value?.toLowerCase().trim();
  return v === "true" || v === "yes" || v === "হ্যাঁ";
};
const any = (c: RedFlagContext, ...flags: string[]) => flags.some((f) => c.flags.has(f));
const labBelow = (c: RedFlagContext, re: RegExp, max: number) =>
  (c.labs ?? []).some((l) => re.test(l.name) && l.value != null && l.value < max);

const RULES: Rule[] = [
  {
    id: "RF_CARDIO_EXERTIONAL",
    level: "urgent",
    reasonBn: "পরিশ্রমে বুকে চাপ/ভার — আগে দেখার বিবেচনা করুন",
    test: (c) =>
      c.category === "cardio" &&
      ((slotIn(c, "character", ["pressure", "heaviness", "tightness", "squeez"]) && slotTrue(c, "exertional")) ||
        any(c, "exertional_chest_pressure")),
  },
  {
    id: "RF_CARDIO_ASSOCIATED",
    level: "emergency",
    reasonBn: "বুকে ব্যথার সাথে ঘাম/অজ্ঞান ভাব/বিশ্রামেও শ্বাসকষ্ট",
    test: (c) => c.category === "cardio" && any(c, "sweating", "syncope", "breathless_at_rest"),
  },
  {
    id: "RF_CARDIO_RADIATING",
    level: "urgent",
    reasonBn: "বুকে ব্যথা হাত/চোয়াল/পিঠে ছড়ায়",
    test: (c) => c.category === "cardio" && any(c, "chest_pain_radiating"),
  },
  {
    id: "RF_STROKE",
    level: "emergency",
    reasonBn: "স্ট্রোকের সম্ভাব্য লক্ষণ (এক পাশ অবশ / মুখ বেঁকে যাওয়া / কথা জড়ানো)",
    test: (c) => any(c, "one_sided_weakness", "facial_droop", "speech_difficulty"),
  },
  {
    id: "RF_THUNDERCLAP",
    level: "emergency",
    reasonBn: "হঠাৎ প্রচণ্ড মাথাব্যথা",
    test: (c) => any(c, "sudden_worst_headache"),
  },
  {
    id: "RF_MENINGISM",
    level: "urgent",
    reasonBn: "জ্বরের সাথে ঘাড় শক্ত বা বিভ্রান্তি",
    test: (c) => (any(c, "neck_stiffness") || any(c, "confusion")) && (c.category === "fever" || any(c, "high_fever")),
  },
  {
    id: "RF_GI_BLEED",
    level: "emergency",
    reasonBn: "রক্ত বমি বা কালো পায়খানা",
    test: (c) => any(c, "vomiting_blood", "black_stool"),
  },
  {
    id: "RF_DENGUE_WARNING",
    level: "urgent",
    reasonBn: "জ্বরের সাথে সতর্ক-লক্ষণ (রক্তপাত/বারবার বমি/তীব্র পেটব্যথা/নিস্তেজ)",
    test: (c) =>
      (c.category === "fever" || any(c, "high_fever")) &&
      any(c, "bleeding_gums", "persistent_vomiting", "severe_abdominal_pain", "lethargy"),
  },
  {
    id: "RF_RESP_REST",
    level: "emergency",
    reasonBn: "বিশ্রামেও শ্বাসকষ্ট",
    test: (c) => any(c, "breathless_at_rest"),
  },
  {
    id: "RF_HEMOPTYSIS",
    level: "urgent",
    reasonBn: "কাশির সাথে রক্ত",
    test: (c) => any(c, "coughing_blood"),
  },
  {
    id: "RF_PREGNANCY_BLEED",
    level: "emergency",
    reasonBn: "গর্ভাবস্থায় রক্তপাত বা তীব্র পেটব্যথা",
    test: (c) =>
      (c.comorbidities.has("pregnant") || any(c, "pregnant")) && any(c, "vaginal_bleeding", "severe_abdominal_pain"),
  },
  {
    id: "RF_SYNCOPE",
    level: "urgent",
    reasonBn: "অজ্ঞান হয়ে যাওয়া",
    test: (c) => c.category !== "cardio" && any(c, "syncope"),
  },
  {
    id: "RF_SELF_HARM",
    level: "urgent",
    reasonBn: "নিজের ক্ষতি করার চিন্তা — সহমর্মিতার সাথে দ্রুত কথা বলুন",
    patientMessageBn: "আপনার কথা খুব গুরুত্বপূর্ণ। অনুগ্রহ করে এখনই চেম্বারের সহকারী বা ডাক্তারকে জানান — আপনি একা নন।",
    test: (c) => any(c, "self_harm_thoughts"),
  },
  {
    id: "RF_LAB_LOW_PLATELET",
    level: "urgent",
    reasonBn: "রিপোর্টে প্লাটিলেট ১,০০,০০০-এর নিচে",
    test: (c) => labBelow(c, /platelet|plt/i, 100_000),
  },
];

const RANK: Record<RedFlagLevel, number> = { none: 0, urgent: 1, emergency: 2 };

export function maxLevel(a: RedFlagLevel, b: RedFlagLevel): RedFlagLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

export function evaluateRedFlags(ctx: RedFlagContext): { level: RedFlagLevel; hits: RedFlagHit[] } {
  const hits: RedFlagHit[] = RULES.filter((r) => {
    try {
      return r.test(ctx);
    } catch {
      return false;
    }
  }).map((r) => ({
    ruleId: r.id,
    level: r.level,
    reasonBn: r.reasonBn,
    patientMessageBn: r.patientMessageBn ?? PATIENT_MESSAGES_BN[r.level],
  }));
  const level = hits.reduce<RedFlagLevel>((acc, h) => maxLevel(acc, h.level), "none");
  return { level, hits };
}
