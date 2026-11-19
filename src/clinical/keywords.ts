import { bnToEnDigits, type Category } from "@chamberai/shared";

/**
 * কীওয়ার্ড-ভিত্তিক বোঝা — AI কোটা শেষ হলেও (economy/no_ai মোড) ব্রাঞ্চ বাছাই ও বিপদচিহ্ন ধরা পড়ে।
 * নোট: বাংলায় JS-এর \b কাজ করে না, তাই সীমা-চিহ্ন ছাড়াই প্যাটার্ন।
 */
const CATEGORY_RULES: { category: Category; re: RegExp }[] = [
  { category: "gastro", re: /বুক\s?জ্বালা|অম্বল|টক\s?ঢেকুর|heartburn/i },
  { category: "cardio", re: /বুক|ধড়ফড়|ধরফর|হার্ট|হৃদ|chest|palpitation/i },
  { category: "resp", re: /কাশি|শ্বাস|হাঁপানি|কফ|দম\s?বন্ধ|টান|cough|breath/i },
  { category: "fever", re: /জ্বর|গা\s?গরম|fever/i },
  { category: "neuro", re: /মাথা|অবশ|খিঁচুনি|ঝিমঝিম|চোখে\s?অন্ধকার|headache|dizz|numb/i },
  { category: "gastro", re: /পেট|বমি|পায়খানা|ডায়রিয়া|গ্যাস্ট্রিক|গ্যাস|হজম|stomach|abdomen|vomit|diarr/i },
  { category: "msk", re: /কোমর|পিঠ|ঘাড়|হাঁটু|গিরা|জয়েন্ট|কাঁধ|মাজা|back\s?pain|joint|knee/i },
];

export function detectCategory(text: string): Category | null {
  for (const r of CATEGORY_RULES) if (r.re.test(text)) return r.category;
  return null;
}

const FLAG_RULES: { flag: string; re: RegExp }[] = [
  { flag: "sweating", re: /ঘাম|sweat/i },
  { flag: "syncope", re: /অজ্ঞান|জ্ঞান\s?হারা|মাথা\s?ঘুরে\s?পড়ে|faint/i },
  {
    flag: "breathless_at_rest",
    re: /বসে\s?থাকলেও\s?শ্বাস|শুয়ে\s?থাকলেও\s?শ্বাস|শ্বাস\s?নিতে\s?পারছি\s?না|কথা\s?বলতে\s?কষ্ট/,
  },
  { flag: "one_sided_weakness", re: /এক\s?পাশ.{0,15}(অবশ|দুর্বল|ভারী)|(হাত|পা).{0,10}অবশ\s?হয়ে/ },
  { flag: "facial_droop", re: /মুখ.{0,6}বেঁকে|মুখ\s?বাঁকা/ },
  { flag: "speech_difficulty", re: /কথা.{0,6}জড়িয়ে|কথা\s?বলতে\s?পারছে?\s?না/ },
  {
    flag: "sudden_worst_headache",
    re: /হঠাৎ.{0,25}(প্রচণ্ড|ভয়ানক|সবচেয়ে\s?খারাপ).{0,15}মাথা|জীবনের\s?সবচেয়ে\s?খারাপ\s?মাথা/,
  },
  { flag: "vomiting_blood", re: /রক্ত\s?বমি|বমি.{0,10}রক্ত/ },
  { flag: "black_stool", re: /কালো\s?পায়খানা|আলকাতরা/ },
  { flag: "coughing_blood", re: /কাশি.{0,12}রক্ত|কফে\s?রক্ত|রক্ত\s?কাশি/ },
  { flag: "bleeding_gums", re: /(মাড়ি|নাক)\s?দিয়ে\s?রক্ত/ },
  { flag: "persistent_vomiting", re: /বারবার\s?বমি|অনবরত\s?বমি|খেলেই\s?বমি/ },
  { flag: "severe_abdominal_pain", re: /পেটে\s?(প্রচণ্ড|তীব্র|অসহ্য)\s?ব্যথা/ },
  { flag: "lethargy", re: /খুব\s?দুর্বল|নিস্তেজ|ঝিমিয়ে/ },
  { flag: "neck_stiffness", re: /ঘাড়\s?শক্ত|ঘাড়\s?বাঁকাতে\s?পারি\s?না/ },
  { flag: "confusion", re: /এলোমেলো\s?কথা|বিভ্রান্ত|কিছু\s?বুঝতে\s?পারছে\s?না/ },
  { flag: "high_fever", re: /10[3-6](\.\d)?\s?(ডিগ্রি|°|f)?|অনেক\s?জ্বর|খুব\s?জ্বর/i },
  { flag: "self_harm_thoughts", re: /আত্মহত্যা|নিজেকে\s?শেষ|মরে\s?যেতে\s?ইচ্ছা|বাঁচতে\s?ইচ্ছা\s?করে\s?না/ },
  { flag: "vaginal_bleeding", re: /(যোনি|মাসিকের\s?রাস্তা).{0,10}রক্ত|রক্তস্রাব/ },
  { flag: "chest_pain_radiating", re: /(বাম\s?হাত|চোয়াল|পিঠ).{0,15}(যায়|ছড়ায়|নামে)/ },
  {
    flag: "exertional_chest_pressure",
    re: /বুক.{0,30}(চাপ|ভার|চাইপা|চেপে).{0,40}(হাঁটলে|সিঁড়ি|পরিশ্রম|কাজ\s?করলে)|(হাঁটলে|সিঁড়ি|পরিশ্রম).{0,30}বুক.{0,20}(চাপ|ভার|ব্যথা)/,
  },
];

/**
 * বাংলায় না-বাচক শব্দ সাধারণত ক্রিয়ার পরে আসে: "ঘাম হয় না", "রক্ত যায়নি", "ঘাম নেই"।
 * মিলের পরে একই বাক্যাংশে (দাঁড়ি/কমার আগে) ১৪ অক্ষরের মধ্যে এমন শব্দ থাকলে সেটা বিপদচিহ্ন নয়।
 */
const NEGATION_AFTER = /^[^।,.!?;\n]{0,14}?(না|নেই|নাই|নি)(?![ঀ-৿])/;
const NEGATION_BEFORE = /(কোনো|কোন)\s?$/;

function hasPositiveMatch(re: RegExp, text: string): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (let m = g.exec(text); m; m = g.exec(text)) {
    const after = text.slice(m.index + m[0].length);
    const before = text.slice(Math.max(0, m.index - 8), m.index);
    if (!NEGATION_AFTER.test(after) && !NEGATION_BEFORE.test(before)) return true;
    if (m[0].length === 0) g.lastIndex++;
  }
  return false;
}

export function keywordFlags(text: string): string[] {
  const t = bnToEnDigits(text);
  return FLAG_RULES.filter((r) => hasPositiveMatch(r.re, t)).map((r) => r.flag);
}

/** LLM-কে যে ফ্ল্যাগ-নামগুলো ব্যবহার করতে বলা হয় */
export const ALLOWED_FLAGS = [...FLAG_RULES.map((r) => r.flag), "pregnant"];
