import type { AgentActivityByEpic } from "@traycer/protocol/host/agent/activity";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";

export interface AgentActivityHostEntry {
  readonly hostId: string | null;
  readonly byEpic: Readonly<
    Record<
      string,
      {
        readonly working: readonly string[];
        readonly turn: readonly string[];
      }
    >
  >;
}

/**
 * Surface-test helper. Production receives an already-unioned replacement from
 * the host; this folds fixtures only so existing component tests can describe
 * multiple contributing hosts without constructing a transport.
 */
export function publishAgentActivity(
  entries: readonly AgentActivityHostEntry[],
): void {
  const merged = new Map<
    string,
    { readonly working: Set<string>; readonly turn: Set<string> }
  >();
  for (const entry of entries) {
    for (const [epicId, bucket] of Object.entries(entry.byEpic)) {
      let target = merged.get(epicId);
      if (target === undefined) {
        target = { working: new Set<string>(), turn: new Set<string>() };
        merged.set(epicId, target);
      }
      for (const id of bucket.working) target.working.add(id);
      for (const id of bucket.turn) target.turn.add(id);
    }
  }
  const byEpic: AgentActivityByEpic = {};
  for (const [epicId, bucket] of merged) {
    byEpic[epicId] = {
      working: [...bucket.working],
      turn: [...bucket.turn],
    };
  }
  __setAgentActivityStateForTests(byEpic, "cloud");
}

export function resetAgentActivity(): void {
  __resetAgentActivityStoreForTests();
}
