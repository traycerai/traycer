import { create } from "zustand";
import type { ProfileSyncSelection } from "@traycer/protocol/host/profile-sync-schemas";
import type {
  ProfileCopyAttempt,
  ProfileCopyWireProvider,
} from "@/lib/profile-copy/profile-copy-model";
import type {
  ProfileCopyDirectBlock,
  ProfileCopyDirectVerb,
} from "@/lib/profile-copy/profile-copy-presentation";

/**
 * Which profile-copy surface is open, and on which CAPTURED hosts.
 *
 * Every host id here was read at the click that opened the surface and is
 * never re-derived: the flow host is mounted at the app root, outside any
 * Settings host scope, and resolves each id through `useHostClientForHostId`.
 * Moving Settings to another host - or closing Settings - re-routes nothing.
 *
 * In memory only. The durable half is `useProfileCopyOperationsStore`; this
 * store holds nothing that has to survive a restart. Everything here belongs
 * to the signed-in ACCOUNT, so `EpicSessionLifecycleBridge` resets it on
 * sign-out and on a user switch.
 */
export type ProfileCopyFlowView =
  | {
      readonly kind: "sync";
      readonly sourceHostId: string;
      readonly providerId: ProfileCopyWireProvider | null;
    }
  | {
      /** Pick devices, preview, start - from a profile on `sourceHostId`. */
      readonly kind: "new";
      readonly sourceHostId: string;
      readonly providerId: ProfileCopyWireProvider;
      readonly sourceProfileId: string;
    }
  | {
      /** An operation this window started, reopened from its handle. */
      readonly kind: "operation";
      readonly operationId: string;
    }
  | {
      /** One incoming draft, opened on the destination that holds it. */
      readonly kind: "draft";
      readonly destinationHostId: string;
      readonly attempt: ProfileCopyAttempt;
      readonly profileName: string;
    };

/** The one destination whose sign-in this window is driving. */
export interface ProfileCopyActiveLogin {
  readonly destinationHostId: string;
  readonly attemptId: string;
}

/** A direct answer that refused one verb, as the caller heard it. */
export type ProfileCopyDirectBlockAnswer = Omit<
  ProfileCopyDirectBlock,
  "repeats"
>;

interface ProfileCopyFlowState {
  readonly view: ProfileCopyFlowView | null;
  /** Bumped on every open so re-opening the same view remounts it fresh. */
  readonly session: number;
  readonly activeLogin: ProfileCopyActiveLogin | null;
  /** Start IDs survive closing/reopening an uncertain run in this account. */
  readonly syncStartBatchIds: ReadonlyMap<string, string>;
  readonly getSyncStartBatchId: (
    selection: ProfileSyncSelection,
    revision: string,
  ) => string;
  /** Only a confirmed empty start releases its ID for a fresh attempt. */
  readonly forgetSyncStartBatchId: (
    selection: ProfileSyncSelection,
    revision: string,
    batchId: string,
  ) => void;
  /** Uncertain retries retain their identity across result/dialog remounts. */
  readonly profileCopyRetryRequestIds: ReadonlyMap<string, string>;
  readonly getProfileCopyRetryRequestId: (
    attempt: ProfileCopyAttempt,
    revision: number,
  ) => string;
  /**
   * attemptId → the last direct answer that refused Sign in or Verify, keyed
   * by the verb and the draft revision it answered at (Q4 ruling). The host
   * never persists these answers, so a read after one says only what the
   * draft is; this is what remembers why the click did nothing. It applies
   * while the draft sits at that revision. Window memory only: a refusal is
   * a fact about one revision, never about the device.
   */
  readonly directBlocks: Readonly<
    Partial<Record<string, ProfileCopyDirectBlock>>
  >;
  readonly open: (view: ProfileCopyFlowView) => void;
  readonly close: () => void;
  /** Takes the lock; `false` when another destination already holds it. */
  readonly claimLogin: (login: ProfileCopyActiveLogin) => boolean;
  readonly releaseLogin: (attemptId: string) => void;
  /**
   * Records a refusal. The same verb refused for the same reason again counts
   * as a repeat - the shared-resource rule reads that count.
   */
  readonly recordDirectBlock: (
    attemptId: string,
    answer: ProfileCopyDirectBlockAnswer,
  ) => void;
  /** The verb got past its refusal: the next one starts a fresh count. */
  readonly clearDirectBlock: (
    attemptId: string,
    verb: ProfileCopyDirectVerb,
  ) => void;
  /** Forgets everything: the account this memory belongs to is gone. */
  readonly reset: () => void;
}

function nextRepeats(
  previous: ProfileCopyDirectBlock | undefined,
  answer: ProfileCopyDirectBlockAnswer,
): number {
  if (
    previous === undefined ||
    previous.verb !== answer.verb ||
    previous.reason !== answer.reason
  ) {
    return 1;
  }
  return previous.repeats + 1;
}

export const useProfileCopyFlowStore = create<ProfileCopyFlowState>(
  (set, get) => ({
    view: null,
    session: 0,
    activeLogin: null,
    syncStartBatchIds: new Map(),
    getSyncStartBatchId: (selection, revision) => {
      const key = JSON.stringify([selection, revision]);
      const previous = get().syncStartBatchIds;
      const existing = previous.get(key);
      if (existing !== undefined) return existing;
      const batchId = crypto.randomUUID();
      set({ syncStartBatchIds: new Map(previous).set(key, batchId) });
      return batchId;
    },
    forgetSyncStartBatchId: (selection, revision, batchId) => {
      const key = JSON.stringify([selection, revision]);
      const previous = get().syncStartBatchIds;
      if (previous.get(key) !== batchId) return;
      const next = new Map(previous);
      next.delete(key);
      set({ syncStartBatchIds: next });
    },
    profileCopyRetryRequestIds: new Map(),
    getProfileCopyRetryRequestId: (attempt, revision) => {
      const key = JSON.stringify([
        attempt.sourceHostId,
        attempt.operationId,
        attempt.destinationHostId,
        attempt.providerId,
        attempt.sourceProfileId,
        attempt.attemptId,
        revision,
      ]);
      const previous = get().profileCopyRetryRequestIds;
      const existing = previous.get(key);
      if (existing !== undefined) return existing;
      const requestId = crypto.randomUUID();
      set({
        profileCopyRetryRequestIds: new Map(previous).set(key, requestId),
      });
      return requestId;
    },
    directBlocks: {},
    open: (view) => set({ view, session: get().session + 1 }),
    close: () => set({ view: null }),
    claimLogin: (login) => {
      const current = get().activeLogin;
      if (current !== null && current.attemptId !== login.attemptId) {
        return false;
      }
      set({ activeLogin: login });
      return true;
    },
    releaseLogin: (attemptId) => {
      if (get().activeLogin?.attemptId !== attemptId) return;
      set({ activeLogin: null });
    },
    recordDirectBlock: (attemptId, answer) => {
      const directBlocks = get().directBlocks;
      const repeats = nextRepeats(directBlocks[attemptId], answer);
      set({
        directBlocks: { ...directBlocks, [attemptId]: { ...answer, repeats } },
      });
    },
    clearDirectBlock: (attemptId, verb) => {
      const directBlocks = get().directBlocks;
      if (directBlocks[attemptId]?.verb !== verb) return;
      set({
        directBlocks: Object.fromEntries(
          Object.entries(directBlocks).filter(([id]) => id !== attemptId),
        ),
      });
    },
    reset: () =>
      set({
        view: null,
        activeLogin: null,
        directBlocks: {},
        syncStartBatchIds: new Map(),
        profileCopyRetryRequestIds: new Map(),
      }),
  }),
);
