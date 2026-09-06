import { create } from "zustand";

/**
 * Per-HOST latches for the OS-service writes, module-scoped on purpose.
 *
 * They used to be component state in the service adapter, and that had two
 * structural holes the review rounds surfaced one each:
 *
 * - The Overview panel is keyed by host id. Switching Settings to another
 *   host unmounts the panel, discarding a latch mid-shutdown — and TanStack
 *   drops per-`mutate` callbacks once the observer is gone, so a settle that
 *   arrived after the switch never armed the latch at all. Coming back to the
 *   host then showed live controls while the detached CLI was still stopping
 *   it. The store survives the remount, and the ARM sites live at hook level
 *   in `host-overview-rpc.ts` (beside the invalidations, which are hook-level
 *   for exactly the same reason), keyed by the mutation's own host id.
 *
 * - `accepted` is a dispatch, not an outcome: the detached CLI can die
 *   without stopping the host, the scope then never flips, and an
 *   unreleasable latch locks the whole page for the visit. Both transient
 *   latches therefore carry their ARM TIME, and the adapter runs a bounded
 *   timer off it — a shutdown or launchd cycle is seconds, so a latch nothing
 *   released within its window is guarding an operation that finished or
 *   never happened.
 *
 * `externallyManagedRefusal` is deliberately un-timed: it records a
 * STRUCTURAL refusal (the supervisor is configured into the host's
 * environment), released only by a scope flip — a new process that may have
 * been reconfigured.
 */
/**
 * WHICH attempt this page's own update dispatch was granted (D8), and enough
 * about the grant to know when to stop believing it.
 *
 * Not a latch and not a gate: nothing is disabled by this slot's presence. It
 * answers exactly one question — "is the attempt now on screen the one THIS
 * page asked for?" — which is what entitles the panel to open the activation
 * dialog by itself. Acting on a park somebody else's dispatch produced would
 * put a modal in front of a person who did nothing.
 */
export interface HostUpdateDispatchSlot {
  /** The attempt the host acknowledged, from an `accepted` answer. */
  readonly attemptId: string;
  /** When the answer landed — the 60 s unseen clear is measured from here. */
  readonly dispatchedAt: number;
  /**
   * Which `HostOverviewPanel` mount dispatched it. A slot from a previous
   * mount is not this page's to act on, and the auto-open compares against
   * {@link isLiveOverviewIncarnation} rather than merely against "some
   * dispatch happened".
   */
  readonly incarnation: string;
  /**
   * Whether a `host.status` frame has yet named this attempt.
   *
   * The gap between an accepted dispatch and the first frame carrying its id
   * is where the cache still holds the PREVIOUS attempt, and treating that
   * cached frame as this dispatch's answer is how the slot would be cleared by
   * the very read it is waiting to be replaced by. So `seen` is what turns the
   * "a different id arrived" clear on: before it, a different id is old news;
   * after it, it is a different attempt and this slot is spent.
   */
  readonly seen: boolean;
}

export interface HostServiceWriteLatches {
  readonly deregisterAcceptedAt: number | null;
  readonly registerRestartLikelyAt: number | null;
  /**
   * An accepted `host.update.install`: the detached swap is starting but has
   * not yet published `host.status.updateProgress`, and that gap is wide
   * enough for a restart or service write to race the install being granted.
   * Released when progress appears, on a scope flip, or by a bounded timer.
   */
  readonly updateInstallAcceptedAt: number | null;
  readonly externallyManagedRefusal: boolean;
  /** See {@link HostUpdateDispatchSlot}. `null` = this page owns no dispatch. */
  readonly updateDispatch: HostUpdateDispatchSlot | null;
}

const EMPTY_LATCHES: HostServiceWriteLatches = {
  deregisterAcceptedAt: null,
  registerRestartLikelyAt: null,
  updateInstallAcceptedAt: null,
  externallyManagedRefusal: false,
  updateDispatch: null,
};

/** How long an unacknowledged dispatch stays owned before the slot is dropped. */
export const UPDATE_DISPATCH_UNSEEN_TTL_MS = 60_000;

/**
 * The `HostOverviewPanel` mounts that are currently live, by incarnation token.
 *
 * Module state rather than store state, because it is not per host and not
 * something any surface renders: it exists so a mutation settle can ask "is the
 * mount that armed me still on screen?" AFTER that mount is gone. TanStack runs
 * an install's hook-level `onSuccess` past unmount on purpose — that is how the
 * latch settles and the reads are invalidated for a swap the user navigated
 * away from — and the ownership write is the one part of that settle which must
 * NOT happen, because it exists solely to let a mount open a dialog.
 *
 * A set rather than a single value: StrictMode mounts, unmounts and remounts
 * with the same token, and two Overviews can briefly overlap during a scope
 * swap. Registration is reference-counted through the returned disposer so a
 * double cleanup cannot retire a token a live mount still holds.
 */
const liveOverviewIncarnations = new Map<string, number>();

export function registerOverviewIncarnation(incarnation: string): () => void {
  liveOverviewIncarnations.set(
    incarnation,
    (liveOverviewIncarnations.get(incarnation) ?? 0) + 1,
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = liveOverviewIncarnations.get(incarnation) ?? 0;
    if (count <= 1) {
      liveOverviewIncarnations.delete(incarnation);
      return;
    }
    liveOverviewIncarnations.set(incarnation, count - 1);
  };
}

export function isLiveOverviewIncarnation(incarnation: string): boolean {
  return liveOverviewIncarnations.has(incarnation);
}

/**
 * A fresh token for ONE `HostOverviewPanel` mount.
 *
 * Random rather than positional: `useId` would hand the same string to a
 * remounted panel at the same tree position, and "the mount that dispatched
 * this is still on screen" would then be answered `true` for a DIFFERENT mount
 * — which is precisely the substitution the incarnation exists to refuse.
 *
 * Uniqueness within one window is all this needs; nothing outside this renderer
 * ever sees it.
 */
export function newOverviewIncarnation(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `overview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface HostServiceWriteLatchState {
  readonly byHost: Readonly<Record<string, HostServiceWriteLatches>>;
  readonly armDeregisterAccepted: (hostId: string) => void;
  readonly armRegisterRestartLikely: (hostId: string) => void;
  readonly armUpdateInstallAccepted: (hostId: string) => void;
  readonly armExternallyManagedRefusal: (hostId: string) => void;
  readonly releaseDeregisterAccepted: (hostId: string) => void;
  readonly releaseRegisterRestartLikely: (hostId: string) => void;
  readonly releaseUpdateInstallAccepted: (hostId: string) => void;
  readonly releaseExternallyManagedRefusal: (hostId: string) => void;
  /**
   * The scope-flip release: every LATCH for this host, structural included.
   *
   * Deliberately not the dispatch slot. A latch guards a window of time and a
   * flip is evidence that window closed; ownership is a fact about who asked
   * for the attempt now on screen, and a host briefly going unreachable is not
   * evidence that somebody else asked. The slot has its own four clears and
   * this is none of them.
   */
  readonly releaseAll: (hostId: string) => void;
  /** Records an `accepted {attemptId}` as this mount's. */
  readonly armUpdateDispatch: (
    hostId: string,
    dispatch: { readonly attemptId: string; readonly incarnation: string },
  ) => void;
  /**
   * Feeds one `host.status` attempt frame to the slot: `null` when the frame
   * named no attempt. Owns the two FRAME-driven clears (a terminal id, and a
   * different id once `seen`) plus the `seen` flip itself.
   */
  readonly observeUpdateDispatchFrame: (
    hostId: string,
    frame: {
      readonly attemptId: string;
      readonly terminal: boolean;
    } | null,
  ) => void;
  /**
   * The two clears no frame can express, both of them by a caller who knows
   * something the status stream does not:
   *
   *  - the UNSEEN TTL, which needs a timer and so lives with the panel; and
   *  - an ACCEPTED host-service **deregister** (`host-overview-rpc.ts`), where
   *    the service the dispatch was made about is being removed. Without it a
   *    re-register under the same `hostId` inherits the removed service's
   *    activation offer.
   */
  readonly clearUpdateDispatch: (hostId: string) => void;
}

export const useHostServiceWriteLatchStore = create<HostServiceWriteLatchState>(
  (set) => {
    const patch = (
      hostId: string,
      change: Partial<HostServiceWriteLatches>,
    ): void => {
      set((state) => ({
        byHost: {
          ...state.byHost,
          [hostId]: { ...(state.byHost[hostId] ?? EMPTY_LATCHES), ...change },
        },
      }));
    };
    return {
      byHost: {},
      armDeregisterAccepted: (hostId) => {
        patch(hostId, { deregisterAcceptedAt: Date.now() });
      },
      armRegisterRestartLikely: (hostId) => {
        patch(hostId, { registerRestartLikelyAt: Date.now() });
      },
      armUpdateInstallAccepted: (hostId) => {
        patch(hostId, { updateInstallAcceptedAt: Date.now() });
      },
      armExternallyManagedRefusal: (hostId) => {
        patch(hostId, { externallyManagedRefusal: true });
      },
      releaseDeregisterAccepted: (hostId) => {
        patch(hostId, { deregisterAcceptedAt: null });
      },
      releaseRegisterRestartLikely: (hostId) => {
        patch(hostId, { registerRestartLikelyAt: null });
      },
      releaseUpdateInstallAccepted: (hostId) => {
        patch(hostId, { updateInstallAcceptedAt: null });
      },
      releaseExternallyManagedRefusal: (hostId) => {
        patch(hostId, { externallyManagedRefusal: false });
      },
      releaseAll: (hostId) => {
        set((state) => {
          if (!(hostId in state.byHost)) return state;
          const dispatch = hostServiceWriteLatches(
            state.byHost,
            hostId,
          ).updateDispatch;
          const next = { ...state.byHost };
          // The slot outlives the flip — see the interface note. Dropping the
          // key wholesale is still what happens when there is nothing to
          // carry, so a host with no dispatch leaves no entry behind.
          if (dispatch === null) {
            delete next[hostId];
          } else {
            next[hostId] = { ...EMPTY_LATCHES, updateDispatch: dispatch };
          }
          return { byHost: next };
        });
      },
      armUpdateDispatch: (hostId, dispatch) => {
        patch(hostId, {
          updateDispatch: {
            attemptId: dispatch.attemptId,
            dispatchedAt: Date.now(),
            incarnation: dispatch.incarnation,
            seen: false,
          },
        });
      },
      observeUpdateDispatchFrame: (hostId, frame) => {
        set((state) => {
          if (!(hostId in state.byHost)) return state;
          const current = hostServiceWriteLatches(state.byHost, hostId);
          const slot = current.updateDispatch;
          if (slot === null) return state;
          const next = nextDispatchSlot(slot, frame);
          if (next === slot) return state;
          return {
            byHost: {
              ...state.byHost,
              [hostId]: { ...current, updateDispatch: next },
            },
          };
        });
      },
      clearUpdateDispatch: (hostId) => {
        patch(hostId, { updateDispatch: null });
      },
    };
  },
);

/**
 * The slot's frame-driven transitions, as one total function so the three
 * outcomes are readable side by side rather than as nested conditions in a
 * setter.
 *
 * Returning the SAME reference for "no change" is what keeps an unchanged
 * `host.status` poll from publishing a store update on every tick.
 */
function nextDispatchSlot(
  slot: HostUpdateDispatchSlot,
  frame: { readonly attemptId: string; readonly terminal: boolean } | null,
): HostUpdateDispatchSlot | null {
  // A frame that names NO attempt is not a different attempt. The host reports
  // `{kind: "none"}` for a record it has not written yet and for one it has
  // pruned, and reading either as "somebody else's attempt replaced mine"
  // would clear the slot in the exact gap it exists to cover.
  if (frame === null) return slot;
  if (frame.attemptId === slot.attemptId) {
    // Terminal: this dispatch's attempt is over. Nothing left to own, and
    // nothing left to open a dialog about.
    if (frame.terminal) return null;
    return slot.seen ? slot : { ...slot, seen: true };
  }
  // A DIFFERENT attempt. Before `seen`, this is the cache still serving the
  // attempt that preceded ours — the ACK raced the poll, which is the ordinary
  // case, not an anomaly. After `seen`, our attempt has been superseded on
  // screen and the slot is spent.
  return slot.seen ? null : slot;
}

/** Test-only: drops every host's latches, mirroring a fresh module load. */
export function resetHostServiceWriteLatchesForTest(): void {
  useHostServiceWriteLatchStore.setState({ byHost: {} });
  liveOverviewIncarnations.clear();
}

export function hostServiceWriteLatches(
  byHost: Readonly<Record<string, HostServiceWriteLatches>>,
  hostId: string | null,
): HostServiceWriteLatches {
  if (hostId === null) return EMPTY_LATCHES;
  return byHost[hostId] ?? EMPTY_LATCHES;
}
