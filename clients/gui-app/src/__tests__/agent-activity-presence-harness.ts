/**
 * Test harness for the per-user notification room's agent-activity presence.
 *
 * Drives the REAL path a suite would otherwise have to stub: each simulated
 * host owns its own y-protocols `Awareness` producer, its entry is encoded with
 * `encodeAwarenessUpdate`, and the bytes are handed to the notifications store
 * exactly as an inbound `awareness` frame would be. That means the frozen field
 * names, the binary decode, the cross-host merge and the store projection are
 * all exercised, so a test asserting on a surface is asserting on the wire
 * shape a host actually publishes.
 *
 * Producers are stable per host index across calls, so a second `publish` with
 * a changed entry is a genuine clock-advancing update rather than a new host
 * appearing. Hosts omitted from a later publish have their entry removed, the
 * same way a host disconnecting from the room does.
 */
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  AGENT_ACTIVITY_AWARENESS_FIELD,
  AGENT_ACTIVITY_HOST_ID_AWARENESS_FIELD,
} from "@/lib/notifications/agent-activity-presence";
import {
  __applyNotificationsAwarenessForTests,
  __clearNotificationsAwarenessForTests,
} from "@/stores/notifications/notifications-store";

/**
 * One host's entry. `byEpic` is deliberately `unknown` so a suite can publish
 * malformed shapes (a non-object bucket, a `turn` that is not an array, ...)
 * and assert the reader degrades that piece alone.
 */
export interface AgentActivityHostEntry {
  readonly hostId: string | null;
  readonly byEpic: unknown;
}

interface Producer {
  readonly awareness: Awareness;
  readonly doc: Y.Doc;
}

const producers: Producer[] = [];

function producerAt(index: number): Producer {
  const existing = producers[index] as Producer | undefined;
  if (existing !== undefined) return existing;
  const doc = new Y.Doc();
  const producer: Producer = { doc, awareness: new Awareness(doc) };
  producers[index] = producer;
  return producer;
}

/**
 * Publishes one awareness entry per element of `entries` into the room replica.
 * Index position identifies the host, so re-publishing with a different entry
 * at index 0 updates that host rather than adding another.
 */
export function publishAgentActivity(
  entries: readonly AgentActivityHostEntry[],
): void {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const producer = producerAt(index);
    const state: Record<string, unknown> = {
      [AGENT_ACTIVITY_AWARENESS_FIELD]: entry.byEpic,
    };
    if (entry.hostId !== null) {
      state[AGENT_ACTIVITY_HOST_ID_AWARENESS_FIELD] = entry.hostId;
    }
    producer.awareness.setLocalState(state);
    __applyNotificationsAwarenessForTests(
      encodeAwarenessUpdate(producer.awareness, [producer.awareness.clientID]),
    );
  }
  // Hosts that dropped out of the list disconnected: clear their entry so the
  // union stops reporting their agents.
  for (let index = entries.length; index < producers.length; index += 1) {
    const producer = producerAt(index);
    if (producer.awareness.getLocalState() === null) continue;
    producer.awareness.setLocalState(null);
    __applyNotificationsAwarenessForTests(
      encodeAwarenessUpdate(producer.awareness, [producer.awareness.clientID]),
    );
  }
}

/** Tears every simulated host down and empties the replica. Use in afterEach. */
export function resetAgentActivityPresence(): void {
  for (const producer of producers) {
    producer.awareness.destroy();
    producer.doc.destroy();
  }
  producers.length = 0;
  __clearNotificationsAwarenessForTests();
}
