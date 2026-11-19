import { bnToEnDigits } from "@chamberai/shared";

/**
 * হালকা PII মাস্কিং (বাংলাদেশি ফোন, NID, ইমেইল)।
 * Presidio-র pattern-recognizer পদ্ধতির TypeScript রূপ — Render free-এর 512 MB RAM-এ ভারী NLP মডেল ছাড়াই চলে।
 * মূল সুরক্ষা হলো: আমরা নাম/ফোন চাই-ই না। এটা রোগী নিজে থেকে বললে তার জন্য।
 */
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "phone", re: /(?:\+?88)?01[3-9]\d{8}/g },
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: "nid", re: /\b(?:\d{17}|\d{13}|\d{10})\b/g },
];

export function maskPii(text: string): string {
  let out = bnToEnDigits(text);
  for (const p of PATTERNS) out = out.replace(p.re, `<${p.name}>`);
  return out;
}

export function containsPii(text: string): boolean {
  const t = bnToEnDigits(text);
  return PATTERNS.some((p) => new RegExp(p.re.source).test(t));
}
