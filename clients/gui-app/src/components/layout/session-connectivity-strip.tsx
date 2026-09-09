import { useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SyncingSweepBar } from "@/components/sync/syncing-sweep-bar";
import {
  isAnnouncedInterruption,
  useHostSessionWake,
  type HostSessionConnectivity,
} from "@/lib/host/session-connectivity";
import { streamSyncingLabel } from "@/lib/sync/stream-syncing-state";
import {
  resolveSurfaceSync,
  useSurfaceSyncStore,
  type SurfaceSyncEntry,
} from "@/stores/sync/surface-sync-store";
import { cn } from "@/lib/utils";

/**
 * The ONE strip that states what this client's OWN transport is doing, mounted
 * directly under the app header.
 *
 * It speaks for the SESSION plane only: the latched verdict from
 * `useHostSessionConnectivity`, which reads the exact stream client's
 * readiness - never a host-wide or directory-plane view. Everything the old
 * host-status strip said about the directory plane (switching, no selection,
 * a broken default host) belongs to the window narrator modal now, which
 * derives those states from the selection authority's leases; a second row
 * restating them here would put two narrators on screen for one fact.
 *
 * The session plane is the one fact the narrator CANNOT own: a session that
 * is not carrying frames is only observable from the client that holds it,
 * and the two causes (our leg down, the relay's host uplink gone) are
 * deliberately indistinguishable - so the copy names the connection, never
 * the host. The verdict is latched per episode and dismissed only by the
 * bound session's own ready edge; surface churn can neither flicker nor
 * postpone it (see the store's announce/escalate deadlines).
 *
 * The accessible name is derived from the same verdict the visible line is,
 * so a screen reader and a pair of eyes are told the same thing - a static
 * label would keep announcing the first rung after the row had escalated.
 *
 * The copy names the CONNECTION and never the machine, for two reasons that
 * both bite: the verdict cannot distinguish this device's leg from the relay's
 * host uplink, and a host is not necessarily a Mac - the same string would
 * face a user whose host is a Windows or Linux box.
 *
 * The tone is deliberately quiet, and the two states differ in HOW MUCH is
 * said, not only in wording.
 *
 * The ordinary interruption is a bar and nothing else. Most of what this
 * reports is a reconnect that completes in a second or two - a phone coming
 * back from the background, a network moving under a live socket - and a row of
 * words that appears and vanishes in that time is read as an alarm, then
 * distrusted. A bar under the header says "something is happening" without
 * making a sentence of it, and the same bar is what the surfaces below use for
 * the same fact, so a person learns the one motion once. The row keeps its
 * `<output>` and its label throughout, so what a screen reader hears does not
 * depend on whether words happen to be on screen.
 *
 * Only when it has gone on long enough that "back in a moment" is no longer
 * true does the row spend words and offer an action. Retry wakes exactly the
 * session the verdict speaks for (`useHostSessionWake` collapses the
 * transport's pending backoff). Offering it during the ordinary state would
 * invite a tap that changes nothing: the transport is already redialing, and
 * its first attempt has not yet failed. The wake reports no progress of its
 * own, and the button stays enabled - a redial that fails re-arms at the
 * escalated backoff, and re-entering this same line is a normal outcome.
 *
 * The bar stops travelling at that point too, which is the same rule the
 * surface strips follow: a bar still sweeping under "Still reconnecting"
 * promises "any moment now" about a retry that has just been described as not
 * converging, and stopping it bounds the animation of a reconnect that never
 * converges.
 *
 * The verdict is read by the shell and passed in, rather than read here.
 * `useHostSessionConnectivity` builds a store per call - with its own timers
 * and its own latched episode - so a second reader is a second episode.
 *
 * ## Why this row also speaks for the surfaces below it
 *
 * The Epic's stream and a chat's report the same class of fact, and an app
 * switch drops all three legs in the same tick. They used to render their own
 * bars at their own mount points, which made the indicator a DIFFERENT DOM
 * element depending on which stream was speaking: every hand-off restarted the
 * CSS animation from its first frame - which always runs forward, so the motion
 * read as repeating rather than travelling - and moved the bar down the screen
 * by the height of whatever header it had been mounted under.
 *
 * So this row owns the only element. Surfaces publish their state to
 * `surface-sync-store` and render nothing; the ordering between them is the
 * store's rank, not a chain of components agreeing with each other. Across a
 * hand-off only the DATA here changes, so the element neither moves nor
 * restarts, and the indicator stays continuous from the first drop until
 * everything on screen is current.
 */
export function SessionConnectivityStrip(props: {
  readonly connectivity: HostSessionConnectivity;
}): ReactNode {
  const wakeSession = useHostSessionWake();
  const surfaceEntries = useSurfaceSyncStore((state) => state.entries);
  const sessionAnnounced = isAnnouncedInterruption(props.connectivity);
  const resolved = useMemo(
    () =>
      resolveIndicator({
        connectivity: props.connectivity,
        sessionAnnounced,
        wakeSession,
        surfaceEntries,
      }),
    [props.connectivity, sessionAnnounced, wakeSession, surfaceEntries],
  );
  if (resolved === null) return null;
  return (
    <output
      aria-label={resolved.ariaLabel}
      data-testid="session-connectivity-strip"
      data-state={resolved.state}
      // Which surface the indicator currently speaks for. Presentation reads
      // nothing from it; it is here so a test can prove the SAME element
      // survives a hand-off rather than being replaced by another surface's.
      data-sync-source={resolved.source}
      className={cn(
        "flex w-full flex-col border-b border-border bg-background text-ui-xs text-muted-foreground",
        // Words earn the padding; the bar alone sits flush under the header as
        // a hairline, so an ordinary two-second reconnect does not shift the
        // whole app down and back.
        resolved.escalated ? "gap-1.5 px-3 py-1.5" : null,
      )}
    >
      {resolved.escalated ? (
        <div className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1">{resolved.escalatedText}</span>
          {resolved.wake === null ? null : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-current"
              data-testid="session-connectivity-strip-retry"
              onClick={resolved.wake}
            >
              Retry now
            </Button>
          )}
        </div>
      ) : null}
      <SyncingSweepBar
        settled={resolved.escalated}
        testId="session-connectivity-strip-bar"
        className={undefined}
      />
    </output>
  );
}

interface ResolvedIndicator {
  /** The surface this currently speaks for, for assertions only. */
  readonly source: string;
  readonly state: string;
  readonly ariaLabel: string;
  readonly escalated: boolean;
  readonly escalatedText: string;
  readonly wake: (() => void) | null;
}

/**
 * The one thing to say, chosen from this client's own session and everything
 * the surfaces have published.
 *
 * The session leg wins outright when it is announced: while this client's whole
 * transport is down, every stream below it is down for the same reason, and
 * naming one of them would be a narrower claim than the truth.
 */
function resolveIndicator(input: {
  readonly connectivity: HostSessionConnectivity;
  readonly sessionAnnounced: boolean;
  readonly wakeSession: () => void;
  readonly surfaceEntries: Readonly<Record<string, SurfaceSyncEntry>>;
}): ResolvedIndicator | null {
  if (input.sessionAnnounced) {
    const prolonged = input.connectivity === "interrupted-prolonged";
    return {
      source: "session",
      state: input.connectivity,
      // Follows the verdict rather than being static: a fixed name would keep
      // announcing the first rung after the row had escalated, so a screen
      // reader and a pair of eyes would be told different things.
      ariaLabel: prolonged
        ? "Connection interrupted - still reconnecting"
        : "Connection interrupted - reconnecting",
      escalated: prolonged,
      escalatedText: "Still reconnecting",
      wake: input.wakeSession,
    };
  }
  const surface = resolveSurfaceSync(input.surfaceEntries);
  if (surface === null) return null;
  return {
    source: surface.key,
    state: surface.entry.spell.escalated ? "stalled" : "syncing",
    ariaLabel: `${surface.entry.label}: ${streamSyncingLabel(
      surface.entry.spell.escalated,
    )}`,
    escalated: surface.entry.spell.escalated,
    escalatedText: streamSyncingLabel(true),
    wake: surface.entry.wake,
  };
}
