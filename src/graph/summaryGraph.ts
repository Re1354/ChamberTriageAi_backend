import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { SummaryLlm } from "@chamberai/shared";
import { env } from "../config";
import type { RedFlagHit } from "../clinical/redFlags";
import { canUseAi } from "../llm/quota";
import {
  buildRulesSummary,
  generateAiSummary,
  postprocess,
  verifyCard,
  type SummaryInput,
} from "../services/summaryBuild";

/**
 * Summarizer Agent:  START → generate → postprocess → verify ─┬─> generate (AI হলে, সর্বোচ্চ ২ বার)
 *                                                             └─> END
 * Vision (ওষুধের পাতা/ল্যাব রিপোর্ট) ও সামারি একটি AI কলেই — ফ্রি কোটায় প্রতি রোগী ১টি ফাইনাল কল।
 */
interface Meta {
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

const SummaryAnnotation = Annotation.Root({
  input: Annotation<SummaryInput>(),
  attempts: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  generatedBy: Annotation<"ai" | "rules">({ reducer: (_a, b) => b, default: () => "rules" }),
  draft: Annotation<SummaryLlm | null>({ reducer: (_a, b) => b, default: () => null }),
  card: Annotation<SummaryLlm | null>({ reducer: (_a, b) => b, default: () => null }),
  labAlerts: Annotation<RedFlagHit[]>({ reducer: (_a, b) => b, default: () => [] }),
  issues: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  meta: Annotation<Meta>({
    reducer: (a, b) => ({
      model: b.model ?? a.model,
      tokensIn: a.tokensIn + b.tokensIn,
      tokensOut: a.tokensOut + b.tokensOut,
      latencyMs: a.latencyMs + b.latencyMs,
    }),
    default: () => ({ model: null, tokensIn: 0, tokensOut: 0, latencyMs: 0 }),
  }),
});

type SummaryState = typeof SummaryAnnotation.State;

async function generateNode(s: SummaryState) {
  const useAi = !env.MOCK_LLM && s.input.mode !== "no_ai" && (await canUseAi("final"));
  if (useAi) {
    try {
      const r = await generateAiSummary(s.input, s.issues);
      return {
        draft: r.data,
        generatedBy: "ai" as const,
        attempts: s.attempts + 1,
        meta: { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, latencyMs: r.latencyMs },
      };
    } catch (err) {
      console.warn("[summary] AI summary failed, using rules:", (err as Error).message);
    }
  }
  return { draft: buildRulesSummary(s.input), generatedBy: "rules" as const, attempts: s.attempts + 1 };
}

async function postprocessNode(s: SummaryState) {
  const { card, labAlerts } = await postprocess(s.input, s.draft!, s.generatedBy);
  return { card, labAlerts };
}

function verifyNode(s: SummaryState) {
  return { issues: verifyCard(s.input, s.card!) };
}

function routeAfterVerify(s: SummaryState): "generate" | typeof END {
  return s.issues.length > 0 && s.generatedBy === "ai" && s.attempts < 2 ? "generate" : END;
}

const graph = new StateGraph(SummaryAnnotation)
  .addNode("generate", generateNode)
  .addNode("postprocess", postprocessNode)
  .addNode("verify", verifyNode)
  .addEdge(START, "generate")
  .addEdge("generate", "postprocess")
  .addEdge("postprocess", "verify")
  .addConditionalEdges("verify", routeAfterVerify, ["generate", END])
  .compile();

export async function runSummaryGraph(input: SummaryInput) {
  const out = await graph.invoke({ input });
  return {
    card: out.card!,
    generatedBy: out.generatedBy,
    issues: out.issues,
    labAlerts: out.labAlerts,
    meta: out.meta,
  };
}

export function summaryGraphMermaid(): string {
  return graph.getGraph().drawMermaid();
}
