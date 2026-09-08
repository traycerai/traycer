/**
 * ONE `epic.fileEvents` session per (host, epic), shared by every surface that
 * has that epic open on that host.
 *
 * The same epic can be mounted in two panes at once, and ticket 21's recording
 * badge reads the same stream the Files panel's refusals do. A subscription
 * owned by either surface would mean the other silently has no events - or, if
 * both opened one, two sockets pulling the same frames and two toasts per
 * refusal. So it lives here and surfaces CLAIM it:
 *
 *   first claim:  dial
 *   later claims: nothing - the frames already land in the shared store
 *   last release: close, and drop the epic's notices
 *
 * A CLAIM CARRIES ITS OWN OPENER, for the reason `comm-graph-registry.ts`
 * spells out at length: `useDurableStreamTransportFactory` reads its
 * dependencies through a ref that the CREATING component's effect refreshes, so
 * an opener retained from an unmounted surface redials into a disposed runtime.
 * Keying openers by claim makes that unconstructible, and the departing dialer
 * hands its socket to a surviving claim on the way out.
 *
 * ## Degrading on an older host
 *
 * There is deliberately no status handler. `epic.fileEvents` is an OPTIONAL
 * stream method: a host that predates the file plane fails the per-method
 * compatibility check at subscribe time and the client closes THIS session and
 * nothing else. With no status handler that is exactly the promised behavior -
 * no frames, no toast, no error - and the surfaces that read this store render
 * their quiet case, which is the only correct rendering against a host that has
 * no file plane to report on.
 */
import { epicFileEventsServerFrameSchema } from "@traycer/protocol/host/epic/files";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { appLogger } from "@/lib/logger";
import {
  clearEpicFileEvents,
  recordEpicFileEvent,
} from "@/lib/epic-files/file-events-store";

const FILE_EVENTS_METHOD = "epic.fileEvents";

/** Builds the durable transport for one host - `useDurableStreamTransportFactory`. */
export type EpicFileEventsTransportOpener = (
  hostId: string,
) => DurableStreamTransport;

/**
 * Identity for one surface's claim. The surface supplies a stable per-instance
 * object, so two panes are two claims even when they share an opener.
 */
export type EpicFileEventsClaim = object;

interface EpicFileEventsEntry {
  readonly epicId: string;
  readonly hostId: string;
  readonly openersByClaim: Map<
    EpicFileEventsClaim,
    EpicFileEventsTransportOpener
  >;
  /** Whose opener produced the socket that is currently open, if any. */
  dialClaim: EpicFileEventsClaim | null;
  close: (() => void) | null;
}

const entriesByKey = new Map<string, EpicFileEventsEntry>();

function subscriptionKey(hostId: string, epicId: string): string {
  // `hostId` first and length-prefixed: an id containing the separator must not
  // be able to alias another (host, epic) pair.
  return `${hostId.length}:${hostId}:${epicId}`;
}

function dial(
  entry: EpicFileEventsEntry,
  claim: EpicFileEventsClaim,
  opener: EpicFileEventsTransportOpener,
): void {
  let transport: DurableStreamTransport;
  try {
    transport = opener(entry.hostId);
  } catch (cause) {
    // The opener throws when the host has no dialable directory entry or no
    // signed-in user. Both are transient readiness, and the acquiring effect
    // re-runs when they resolve - so this is a skipped dial, not a failure a
    // surface should hear about.
    appLogger.debug("[epic-files] no transport for file events", {
      epic: entry.epicId,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    return;
  }
  try {
    const session = transport.wsStreamClient.subscribe(FILE_EVENTS_METHOD, {
      epicId: entry.epicId,
    });
    session.onServerFrame((envelope) => {
      const parsed = epicFileEventsServerFrameSchema.safeParse(envelope);
      if (!parsed.success) {
        appLogger.warn("[epic-files] unparsable file-events frame", {
          epic: entry.epicId,
        });
        return;
      }
      recordEpicFileEvent(entry.epicId, parsed.data);
    });
    entry.dialClaim = claim;
    entry.close = () => {
      // The transport (socket + rotation/wake listeners) must be released even
      // when the session's own teardown throws, or the leak is silent for the
      // life of the app.
      try {
        session.close();
      } finally {
        transport.close();
      }
    };
  } catch (cause) {
    transport.close();
    appLogger.warn("[epic-files] could not open the file-events stream", {
      epic: entry.epicId,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/**
 * Registers one surface's claim, dialing if this is the first.
 *
 * Paired with {@link releaseEpicFileEvents} in an EFFECT, never in render: a
 * StrictMode double-invoke runs the cleanup too, so the claims balance.
 */
export function acquireEpicFileEvents(args: {
  readonly epicId: string;
  readonly hostId: string;
  readonly claim: EpicFileEventsClaim;
  readonly openTransport: EpicFileEventsTransportOpener;
}): void {
  const key = subscriptionKey(args.hostId, args.epicId);
  const existing = entriesByKey.get(key);
  const entry: EpicFileEventsEntry = existing ?? {
    epicId: args.epicId,
    hostId: args.hostId,
    openersByClaim: new Map(),
    dialClaim: null,
    close: null,
  };
  if (existing === undefined) entriesByKey.set(key, entry);
  entry.openersByClaim.set(args.claim, args.openTransport);
  if (entry.close === null) dial(entry, args.claim, args.openTransport);
}

export function releaseEpicFileEvents(args: {
  readonly epicId: string;
  readonly hostId: string;
  readonly claim: EpicFileEventsClaim;
}): void {
  const key = subscriptionKey(args.hostId, args.epicId);
  const entry = entriesByKey.get(key);
  if (entry === undefined) return;
  entry.openersByClaim.delete(args.claim);
  const surviving = Array.from(entry.openersByClaim.entries()).at(-1);
  if (surviving !== undefined) {
    // Only the DEPARTING dialer's socket is replaced. It keeps reading the refs
    // of a surface that is gone, so its next re-dial would reach a disposed
    // runtime; a socket opened through a claim that is still mounted is healthy
    // and cycling it would drop frames for nothing.
    if (entry.dialClaim !== args.claim) return;
    entry.close?.();
    entry.close = null;
    entry.dialClaim = null;
    dial(entry, surviving[0], surviving[1]);
    return;
  }
  entry.close?.();
  entriesByKey.delete(key);
  // Only once the epic has no subscription on ANY host: the same epic can be
  // open on two, and one closing is not the epic closing.
  const stillOpen = Array.from(entriesByKey.values()).some(
    (other) => other.epicId === args.epicId,
  );
  if (!stillOpen) clearEpicFileEvents(args.epicId);
}

/** Live claims for one (host, epic). Tests only. */
export function __epicFileEventsClaimCountForTests(
  hostId: string,
  epicId: string,
): number {
  return (
    entriesByKey.get(subscriptionKey(hostId, epicId))?.openersByClaim.size ?? 0
  );
}

/** Closes every subscription. Tests only - a leaked socket outlives its test. */
export function __resetEpicFileEventsSubscriptionsForTests(): void {
  for (const entry of entriesByKey.values()) entry.close?.();
  entriesByKey.clear();
}
