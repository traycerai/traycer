import { useEffect, useState } from "react";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { LINK_DOWN_ESCALATION_MS } from "@/lib/link-down-escalation";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
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
  /**
   * Which stretch of FOREGROUND waiting the clock is timing: the wait since
   * the person was last present, not foreground time accumulated across
   * absences. Bumped by the shell's resume signal, which re-arms the deadline
   * for a full interval and takes back any escalation already reached.
   *
   * The clock measures how long a person has watched the indicator, and a
   * person who left the app was not watching. A suspended WebView keeps its
   * timers frozen and, on thaw, fires every one whose deadline passed - so a
   * wait armed before a minutes-long background lands the escalated word on
   * the very first frame after return, before the fresh restore has even
   * begun. Measured on device: the overdue timer fires 25 ms BEFORE the resume
   * event reaches any subscriber. That order is why a resume must undo an
   * escalation rather than only postpone one, and why `performance.now()` is
   * no help - it advances through the suspension too.
   */
  readonly waitEpoch: number;
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
 *
 * The wait counts foreground time only: the shell's resume signal restarts it
 * (see {@link SpellRecord.waitEpoch}). Gated on the SIGNAL, not on a measured
 * dwell - desktop's power monitor reports none and sends `null`, and a laptop
 * that slept mid-outage was not being watched either.
 */
export function useStreamSyncingSpell(
  input: StreamSyncingSpellInput,
): StreamSyncingSpell {
  const { status, hasContent, identity } = input;
  const syncing = isStreamSyncing(status, hasContent);
  const runnerHost = useRunnerHostOrNull();
  const [record, setRecord] = useState<SpellRecord>({
    identity,
    escalated: false,
    waitEpoch: 0,
  });

  if (record.identity !== identity) {
    setRecord({ identity, escalated: false, waitEpoch: 0 });
  } else if (!syncing && record.escalated) {
    setRecord({ identity, escalated: false, waitEpoch: record.waitEpoch });
  }

  const { waitEpoch } = record;

  useEffect(() => {
    if (!syncing) return undefined;
    const timer = setTimeout(() => {
      setRecord((current) =>
        // Checked against the epoch this timer was armed for, not merely
        // cleared by the effect's cleanup: the resume handler's state update
        // is committed by React's scheduler on a LATER task, and a deadline
        // that expires in between fires against the record that already
        // carries the new epoch. Its verdict belongs to the wait that ended.
        current.waitEpoch === waitEpoch
          ? { ...current, escalated: true }
          : current,
      );
    }, LINK_DOWN_ESCALATION_MS);
    return () => {
      clearTimeout(timer);
    };
    // Keyed on the SPELL - is one running, and about what - never on the raw
    // status: `connecting` and `reconnecting` are one outage seen twice, and
    // re-running on that flip would restart the clock on a link that flaps and
    // so never let it escalate at all. `waitEpoch` is the one deliberate
    // restart: a system resume.
  }, [syncing, identity, waitEpoch]);

  useEffect(() => {
    if (!syncing || runnerHost === null) return undefined;
    const subscription = runnerHost.onSystemResumed(() => {
      setRecord((current) => ({
        ...current,
        escalated: false,
        waitEpoch: current.waitEpoch + 1,
      }));
    });
    return () => {
      subscription.dispose();
    };
  }, [syncing, identity, runnerHost]);

  return {
    syncing,
    escalated: syncing && record.identity === identity && record.escalated,
  };
}
