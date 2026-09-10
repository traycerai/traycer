import { useEffect, useState } from "react";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { LINK_DOWN_ESCALATION_MS } from "@/lib/link-down-escalation";
import {
  isStreamSyncing,
  type StreamSyncingSpell,
} from "@/lib/sync/stream-syncing-state";

interface StreamSyncingSpellInput {
  /** This surface's OWN stream status - never a blend across streams. */
  readonly status: StreamConnectionStatus;
  /**
   * Whether the surface is already showing something. Callers pass their
   * store's `snapshotLoaded`: it survives an ordinary reconnect on both the
   * Epic and the chat line (only a replica reset or a re-subscribe clears it),
   * which is exactly the "content on screen, stream away" window.
   */
  readonly hasContent: boolean;
  /**
   * WHAT is syncing - an epic id, a chat id. A change ends the spell and starts
   * a new one.
   *
   * Load-bearing, and not replaceable by a `key` on whatever renders the strip.
   * The phone's tile bar is one component that outlives the tile it names: swipe
   * from a chat whose resync has already escalated to a different chat that has
   * only just dropped, and without this the second chat inherits the first
   * one's verdict - "Still syncing…", motion already stopped - about an outage
   * that is seconds old. The clock has to belong to the thing being described,
   * not to the component describing it.
   */
  readonly identity: string;
}

interface SpellRecord {
  readonly identity: string;
  readonly escalated: boolean;
}

/**
 * How long this surface's stream has been away, reduced to the one question a
 * surface asks about it: long enough to stop calling it momentary?
 *
 * CALL IT UNCONDITIONALLY, including where the strip is suppressed. The clock
 * measures the outage, not the indicator, and a caller that only runs it while
 * something is drawn re-times a continuing outage every time the drawing
 * resumes - which is both a false "Syncing…" after a minute of "Still
 * syncing…", and an animation that renews itself past the bound the escalation
 * is there to impose.
 *
 * Render-phase transitions rather than effects, matching `useLinkDownTooLong`:
 * the moment the stream is back, or the subject changes, the escalated verdict
 * must not paint even one frame.
 */
export function useStreamSyncingSpell(
  input: StreamSyncingSpellInput,
): StreamSyncingSpell {
  const { status, hasContent, identity } = input;
  const syncing = isStreamSyncing(status, hasContent);
  const [record, setRecord] = useState<SpellRecord>({
    identity,
    escalated: false,
  });

  if (record.identity !== identity) {
    setRecord({ identity, escalated: false });
  } else if (!syncing && record.escalated) {
    setRecord({ identity, escalated: false });
  }

  useEffect(() => {
    if (!syncing) return undefined;
    const timer = setTimeout(() => {
      setRecord({ identity, escalated: true });
    }, LINK_DOWN_ESCALATION_MS);
    return () => {
      clearTimeout(timer);
    };
    // Keyed on the SPELL - is one running, and about what - never on the raw
    // status: `connecting` and `reconnecting` are one outage seen twice, and
    // re-running on that flip would restart the clock on a link that flaps and
    // so never let it escalate at all.
  }, [syncing, identity]);

  return {
    syncing,
    escalated: syncing && record.identity === identity && record.escalated,
  };
}
