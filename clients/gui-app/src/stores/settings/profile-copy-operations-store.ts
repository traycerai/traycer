import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type PersistStorage,
} from "zustand/middleware";
import {
  PROFILE_COPY_DISPOSITIONS,
  PROFILE_COPY_MANUAL_ROUTES,
  PROFILE_COPY_PROVIDERS,
  PROFILE_COPY_REASONS,
  type ProfileCopyDisposition,
  type ProfileCopyManualRoute,
  type ProfileCopyPreviewRecord,
  type ProfileCopyReason,
  type ProfileCopyWireProvider,
} from "@/lib/profile-copy/profile-copy-model";
import { basePersistOptions, profileCopyOperationsKey } from "@/lib/persist";

/**
 * The copies THIS window started, so Settings can reopen them after it - or
 * the app - is closed. Closing is never cancelling: a handle is only a way
 * back to the source host's `status`.
 *
 * There is no list verb on the wire (Q3 ruling), so this is the only way back
 * to an outgoing copy, and it is viewer-local: another window or device sees
 * only the drafts waiting on a destination (`incoming`).
 *
 * What a handle holds is what `status` and an explicit "Start again" need,
 * plus the preview each destination was started from (its final state when it
 * got no attempt). No label, email, account id, credential, challenge or code
 * - a handle is host ids, operation ids and wire enums.
 *
 * Identity-scoped (`ProfileCopyOperationsPersistLifecycleBridge`): another
 * account never inherits one.
 */
export interface ProfileCopyOperationHandle {
  readonly operationId: string;
  readonly sourceHostId: string;
  readonly sourceProfileId: string;
  readonly providerId: ProfileCopyWireProvider;
  /** The exact previewed set - `start` must send this list unchanged. */
  readonly destinationHostIds: readonly string[];
  /**
   * The preview the start was sent with. `null` for a handle rebuilt from an
   * incoming draft: that copy was started elsewhere and is only watched here.
   */
  readonly previewRevision: string | null;
  readonly previewRecords: readonly ProfileCopyPreviewRecord[];
  readonly createdAt: number;
  /** `start` answered. Until then a FORBIDDEN `status` may mean "never started". */
  readonly startAcknowledged: boolean;
  /**
   * When the SOURCE confirmed a cancel this window sent for the whole
   * operation - set from the cancel's answer, never before dispatch, so a
   * cancel that failed leaves no mark. It drives the "Cancelling…" copy and
   * suppresses Retry; it never hides Cancel, which the host treats as
   * idempotent.
   */
  readonly cancelConfirmedAt: number | null;
  /**
   * The last `status` this window read had every row settled
   * (`isOutcomeSettled`, or a destination that got no attempt). Follows each
   * answer, so a retry clears it. Only a settled handle falls off past the
   * cap: an unsettled one may be the only way back to its copy's status,
   * retry or cancel - there is no list verb, and a source-local row has no
   * destination draft to reopen it from.
   */
  readonly settled: boolean;
  /**
   * When a `status` answer last set `settled` (ms), `0` before any. Two
   * windows' copies of a handle keep the newer read's flag: a window that
   * has not yet heard another's write still holds the older one.
   */
  readonly settlementReadAt: number;
}

/**
 * Newest first. Past this many, settled handles fall off; unsettled ones stay
 * until this window sees them settle or the user removes them.
 */
export const PROFILE_COPY_MAX_HANDLES = 20;

interface ProfileCopyOperationsState {
  readonly handles: readonly ProfileCopyOperationHandle[];
  readonly record: (handle: ProfileCopyOperationHandle) => void;
  readonly acknowledgeStart: (operationId: string) => void;
  readonly markCancelConfirmed: (operationId: string, at: number) => void;
  /** Records what the latest `status` answer said about settlement. */
  readonly markSettled: (operationId: string, settled: boolean) => void;
  /** Forget a handle here. Never cancels anything on any device. */
  readonly remove: (operationId: string) => void;
}

interface PersistedProfileCopyOperations {
  readonly handles: readonly ProfileCopyOperationHandle[];
}

function newestFirst(
  handles: readonly ProfileCopyOperationHandle[],
): readonly ProfileCopyOperationHandle[] {
  return [...handles]
    .sort((left, right) => right.createdAt - left.createdAt)
    .filter(
      (handle, index) => index < PROFILE_COPY_MAX_HANDLES || !handle.settled,
    );
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The value itself when it is one of the wire enum's `options`, else `null`.
 * Every enum a handle stores is parsed through this, from the schema's own
 * list: a value the wire adds later is kept, not the handle dropped.
 */
function parseWireEnum<T extends string>(
  options: readonly T[],
  value: unknown,
): T | null {
  return options.find((option) => option === value) ?? null;
}

function parseProvider(value: unknown): ProfileCopyWireProvider | null {
  return parseWireEnum(PROFILE_COPY_PROVIDERS, value);
}

function parseDisposition(value: unknown): ProfileCopyDisposition | null {
  return parseWireEnum(PROFILE_COPY_DISPOSITIONS, value);
}

function parseManualRoute(value: unknown): ProfileCopyManualRoute | null {
  return parseWireEnum(PROFILE_COPY_MANUAL_ROUTES, value);
}

function parseReason(value: unknown): ProfileCopyReason | null {
  return parseWireEnum(PROFILE_COPY_REASONS, value);
}

function parsePreviewRecord(value: unknown): ProfileCopyPreviewRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record: Record<string, unknown> = { ...value };
  const disposition = parseDisposition(record.disposition);
  const reason = parseReason(record.reason);
  const manualRoute = parseManualRoute(record.manualRoute);
  if (!isString(record.destinationHostId) || disposition === null) return null;
  // A present-but-unknown enum value is a record this build cannot read.
  if (record.reason !== null && reason === null) return null;
  if (record.manualRoute !== null && manualRoute === null) return null;
  const enabled = record.destinationProviderEnabled;
  return {
    destinationHostId: record.destinationHostId,
    disposition,
    reason,
    manualRoute,
    destinationProviderEnabled: typeof enabled === "boolean" ? enabled : null,
  };
}

function parseReadAt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Persisted state is whatever a previous build (or another window) wrote, so
 * every handle is re-validated field by field; a malformed one is dropped
 * rather than trusted.
 */
function parseHandle(value: unknown): ProfileCopyOperationHandle | null {
  if (typeof value !== "object" || value === null) return null;
  const record: Record<string, unknown> = { ...value };
  const providerId = parseProvider(record.providerId);
  if (
    !isString(record.operationId) ||
    !isString(record.sourceHostId) ||
    !isString(record.sourceProfileId) ||
    (record.previewRevision !== null && !isString(record.previewRevision)) ||
    providerId === null ||
    typeof record.createdAt !== "number" ||
    typeof record.startAcknowledged !== "boolean" ||
    !Array.isArray(record.destinationHostIds) ||
    !Array.isArray(record.previewRecords)
  ) {
    return null;
  }
  const destinationHostIds = record.destinationHostIds.filter(isString);
  const previewRecords = record.previewRecords
    .map(parsePreviewRecord)
    .filter((entry) => entry !== null);
  if (destinationHostIds.length === 0) return null;
  const cancelConfirmedAt = record.cancelConfirmedAt;
  return {
    operationId: record.operationId,
    sourceHostId: record.sourceHostId,
    sourceProfileId: record.sourceProfileId,
    providerId,
    destinationHostIds,
    previewRevision: isString(record.previewRevision)
      ? record.previewRevision
      : null,
    previewRecords,
    createdAt: record.createdAt,
    startAcknowledged: record.startAcknowledged,
    cancelConfirmedAt:
      typeof cancelConfirmedAt === "number" ? cancelConfirmedAt : null,
    // Absent on a handle an earlier build wrote: unknown, so kept.
    settled: record.settled === true,
    // Absent on a handle an earlier build wrote: older than any read.
    settlementReadAt: parseReadAt(record.settlementReadAt),
  };
}

function persistedHandles(
  value: unknown,
): readonly ProfileCopyOperationHandle[] {
  if (typeof value !== "object" || value === null) return [];
  const record: Record<string, unknown> = { ...value };
  if (!Array.isArray(record.handles)) return [];
  return newestFirst(
    record.handles.map(parseHandle).filter((handle) => handle !== null),
  );
}

/**
 * Two copies of one handle: acknowledgement and cancel are monotonic;
 * `settled` is the newer read's, and unsettled on a tie. The writer's own
 * copy is not newer just for being written: it may predate a read another
 * window stored, and a stale `settled: true` there lets the cap evict a copy
 * that is moving again.
 */
function mergeHandle(
  left: ProfileCopyOperationHandle,
  right: ProfileCopyOperationHandle,
): ProfileCopyOperationHandle {
  let cancelConfirmedAt = left.cancelConfirmedAt ?? right.cancelConfirmedAt;
  if (left.cancelConfirmedAt !== null && right.cancelConfirmedAt !== null) {
    cancelConfirmedAt = Math.min(
      left.cancelConfirmedAt,
      right.cancelConfirmedAt,
    );
  }
  const settlement =
    right.settlementReadAt > left.settlementReadAt ||
    (right.settlementReadAt === left.settlementReadAt && !right.settled)
      ? right
      : left;
  return {
    ...left,
    startAcknowledged: left.startAcknowledged || right.startAcknowledged,
    cancelConfirmedAt,
    settled: settlement.settled,
    settlementReadAt: settlement.settlementReadAt,
  };
}

/**
 * The handles THIS window forgot on purpose (`remove`) since it last read the
 * storage, recorded when it forgets them. A write drops exactly these from
 * what other windows stored. Nothing is ever inferred from absence: a handle
 * missing from this window's memory may be one another window recorded after
 * this one last read the storage, and dropping it would erase the only way
 * back to that copy.
 *
 * A read (hydration, a retarget to another account's key) makes the storage
 * this window's memory again, so it starts the set afresh; so does a write
 * under a key the set was not recorded for.
 */
const removedHere = new Set<string>();

/**
 * Merges on write, so two windows starting copies at once each keep the
 * other's handle instead of the last writer erasing it - on every write, not
 * just the first. A handle this window removed stays removed for this
 * window's writes. A handle ANOTHER window removed is dropped from this
 * window's memory by the `storage` listener below once the storage event
 * arrives; a write this window makes before then carries it back once.
 */
function crossWindowSafeStorage(): PersistStorage<PersistedProfileCopyOperations> {
  const inner = createJSONStorage<PersistedProfileCopyOperations>(
    () => window.localStorage,
  );
  if (inner === undefined) {
    throw new Error("profile copy operations store needs a JSON storage");
  }
  let removalsName: string | null = null;
  const startRemovals = (name: string): void => {
    removalsName = name;
    removedHere.clear();
  };
  return {
    getItem: (name) => {
      startRemovals(name);
      const stored = inner.getItem(name);
      if (stored instanceof Promise) {
        throw new Error("profile copy operations storage must be synchronous");
      }
      return stored;
    },
    setItem: (name, value) => {
      if (name !== removalsName) startRemovals(name);
      const stored = inner.getItem(name);
      if (stored instanceof Promise) {
        throw new Error("profile copy operations storage must be synchronous");
      }
      const written = value.state.handles;
      const writtenIds = new Set(written.map((handle) => handle.operationId));
      const others =
        stored === null
          ? []
          : persistedHandles(stored.state).filter(
              (handle) => !removedHere.has(handle.operationId),
            );
      const merged = written.map((handle) => {
        const other = others.find(
          (candidate) => candidate.operationId === handle.operationId,
        );
        return other === undefined ? handle : mergeHandle(handle, other);
      });
      const extra = others.filter(
        (handle) => !writtenIds.has(handle.operationId),
      );
      const handles = newestFirst([...merged, ...extra]);
      return inner.setItem(name, { ...value, state: { handles } });
    },
    removeItem: (name) => {
      removedHere.clear();
      return inner.removeItem(name);
    },
  };
}

export const useProfileCopyOperationsStore =
  create<ProfileCopyOperationsState>()(
    persist(
      (set, get) => ({
        handles: [],
        record: (handle) => {
          removedHere.delete(handle.operationId);
          const rest = get().handles.filter(
            (candidate) => candidate.operationId !== handle.operationId,
          );
          set({ handles: newestFirst([handle, ...rest]) });
        },
        acknowledgeStart: (operationId) => {
          set({
            handles: get().handles.map((handle) =>
              handle.operationId === operationId && !handle.startAcknowledged
                ? { ...handle, startAcknowledged: true }
                : handle,
            ),
          });
        },
        markCancelConfirmed: (operationId, at) => {
          set({
            handles: get().handles.map((handle) =>
              handle.operationId === operationId &&
              handle.cancelConfirmedAt === null
                ? { ...handle, cancelConfirmedAt: at }
                : handle,
            ),
          });
        },
        markSettled: (operationId, settled) => {
          const current = get().handles;
          if (
            !current.some(
              (handle) =>
                handle.operationId === operationId &&
                handle.settled !== settled,
            )
          ) {
            return;
          }
          // Not re-capped here: the view that read it may still be open on
          // it. The next start (or another window's write) drops it.
          set({
            handles: current.map((handle) =>
              handle.operationId === operationId
                ? { ...handle, settled, settlementReadAt: Date.now() }
                : handle,
            ),
          });
        },
        remove: (operationId) => {
          removedHere.add(operationId);
          set({
            handles: get().handles.filter(
              (handle) => handle.operationId !== operationId,
            ),
          });
        },
      }),
      {
        ...basePersistOptions(profileCopyOperationsKey(null)),
        storage: crossWindowSafeStorage(),
        merge: (persistedState, currentState) => ({
          ...currentState,
          handles: persistedHandles(persistedState),
        }),
        partialize: (state) => ({ handles: state.handles }),
      },
    ),
  );

// Another window wrote the handles (a start, an acknowledgement, a removal):
// read them again, so this window lists what that window did and a write it
// makes AFTER this read does not carry a handle that window removed back into
// storage (one made before the event arrives still can, once). The
// key is identity-scoped, so it is compared with the CURRENT persist name. The
// `storage` event fires only in OTHER same-origin windows, so this rehydrate
// never re-triggers itself, and `getItem` restarts `removedHere` because the
// storage is this window's memory again. `event.key === null` is an explicit
// `localStorage.clear()`.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    const name = useProfileCopyOperationsStore.persist.getOptions().name;
    if (event.key === null || event.key === name) {
      void useProfileCopyOperationsStore.persist.rehydrate();
    }
  });
}

/** The handle for one operation, or `null` once it is forgotten here. */
export function useProfileCopyOperationHandle(
  operationId: string,
): ProfileCopyOperationHandle | null {
  return useProfileCopyOperationsStore(
    (state) =>
      state.handles.find((handle) => handle.operationId === operationId) ??
      null,
  );
}
