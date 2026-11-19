import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { env } from "../config";
import { pool, q } from "../db";
import {
  askNode,
  comorbidNode,
  photosNode,
  planNode,
  processNode,
  redFlagNode,
  routeAfterComorbid,
  routeAfterPlan,
  startNode,
} from "./nodes";
import { InterviewAnnotation, type InterviewInterrupt, type InterviewState } from "./state";

/**
 * Interview Agent (LangGraph state machine)
 *
 *   START → start → ask ⇄ process → redflags → plan ─┬─> ask (পরের প্রশ্ন)
 *                                                   ├─> comorbid → photos → END
 *                                                   └─> END (emergency)
 *
 * প্রতিটি রোগী = একটি thread (thread_id = visit id), state Postgres checkpointer-এ।
 * ফলে API stateless — যেকোনো সার্ভার-ইনস্ট্যান্স যেকোনো রিকোয়েস্ট নিতে পারে (horizontal scaling)।
 */
function build(checkpointer: MemorySaver | PostgresSaver) {
  return new StateGraph(InterviewAnnotation)
    .addNode("start", startNode)
    .addNode("ask", askNode)
    .addNode("process", processNode)
    .addNode("redflags", redFlagNode)
    .addNode("plan", planNode)
    .addNode("comorbid", comorbidNode)
    .addNode("photos", photosNode)
    .addEdge(START, "start")
    .addEdge("start", "ask")
    .addEdge("ask", "process")
    .addEdge("process", "redflags")
    .addEdge("redflags", "plan")
    .addConditionalEdges("plan", routeAfterPlan, ["ask", "comorbid", END])
    .addConditionalEdges("comorbid", routeAfterComorbid, ["photos", END])
    .addEdge("photos", END)
    .compile({ checkpointer });
}

export type InterviewGraph = ReturnType<typeof build>;

/**
 * LangGraph-এর checkpoint টেবিলগুলো public স্কিমায় তৈরি হয়। Supabase-এ public টেবিল ডিফল্টে
 * anon/authenticated রোলকে (Data API) দেওয়া থাকে — তাই RLS চালু করে ও অনুমতি তুলে নিয়ে
 * ব্রাউজার থেকে রোগীর উত্তর পড়ার পথ বন্ধ করা হয়। (idempotent — প্রতিবার চালানো নিরাপদ)
 */
async function lockDownCheckpointTables(): Promise<void> {
  await q(`do $$
    declare t text;
    begin
      foreach t in array array['checkpoints', 'checkpoint_blobs', 'checkpoint_writes', 'checkpoint_migrations'] loop
        if to_regclass('public.' || t) is not null then
          execute format('alter table public.%I enable row level security', t);
          if exists (select 1 from pg_roles where rolname = 'anon') then
            execute format('revoke all on table public.%I from anon, authenticated', t);
          end if;
        end if;
      end loop;
    end $$;`);
}

let saver: MemorySaver | PostgresSaver | null = null;
let graphPromise: Promise<InterviewGraph> | null = null;

export function getInterviewGraph(): Promise<InterviewGraph> {
  graphPromise ??= (async () => {
    if (env.CHECKPOINTER === "memory") {
      saver = new MemorySaver();
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pg = new PostgresSaver(pool as any);
      await pg.setup();
      await lockDownCheckpointTables();
      saver = pg;
    }
    return build(saver);
  })().catch((err) => {
    graphPromise = null;
    throw err;
  });
  return graphPromise;
}

export const threadConfig = (visitId: string, extra: Record<string, unknown> = {}) => ({
  configurable: { thread_id: visitId, ...extra },
});

export interface InterviewSnapshot {
  values: InterviewState;
  pending: InterviewInterrupt | null;
  finished: boolean;
}

export async function getSnapshot(graph: InterviewGraph, visitId: string): Promise<InterviewSnapshot> {
  const snap = await graph.getState(threadConfig(visitId));
  let pending: InterviewInterrupt | null = null;
  for (const task of snap.tasks ?? []) {
    for (const intr of task.interrupts ?? []) {
      pending = intr.value as InterviewInterrupt;
      break;
    }
    if (pending) break;
  }
  const finished = !pending && (snap.next?.length ?? 0) === 0;
  return { values: snap.values as InterviewState, pending, finished };
}

/** ইন্টারভিউ শেষ হলে checkpoint মুছে ফেলা (ফ্রি ডাটাবেস ছোট রাখতে) */
export async function deleteInterviewThread(visitId: string): Promise<void> {
  const s = saver as unknown as { deleteThread?: (id: string) => Promise<void> } | null;
  try {
    if (s?.deleteThread) {
      await s.deleteThread(visitId);
      return;
    }
  } catch (err) {
    console.warn("[graph] deleteThread failed, falling back to SQL", (err as Error).message);
  }
  if (env.CHECKPOINTER === "postgres") {
    for (const table of ["checkpoint_writes", "checkpoint_blobs", "checkpoints"]) {
      await q(`delete from public.${table} where thread_id = $1`, [visitId]).catch(() => undefined);
    }
  }
}
