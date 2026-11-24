import type { StateStorage } from "zustand/middleware";
import type { SandboxCreateRequest } from "@traycer/protocol/host/sandbox-control";
import { v4 as uuidv4 } from "uuid";
import {
  recordMapStorageKey,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist/keys";
import { createRecordMapStorage } from "@/lib/persist/record-map-storage";

import type { PendingStageRetryAction } from "./pending-sandbox-send-transition";

export interface PendingStagePress {
  readonly createKey: string | null;
  readonly retryCreate?: SandboxCreateRequest;
  /** The attempt visible when the person chose Retry. */
  readonly observedCreateKey?: string | null;
}

export interface PendingStageRetryRequest {
  readonly action?: PendingStageRetryAction;
  readonly id: string;
  readonly userId: string | null;
  readonly clientRequestId: string | null;
  readonly createKey?: string | null;
  readonly retryCreate?: SandboxCreateRequest;
  /** Missing in mailbox entries written before attempt scope was recorded. */
  readonly observedCreateKey?: string | null;
}

export interface PendingDispatchRetryRequest {
  readonly id: string;
  readonly userId: string | null;
  readonly chatId: string;
  readonly hostId: string;
}

const RETRY_REGISTER_PREFIX = "retry-request:";
const STAGE_RETRY_SLOT_PREFIX = "retry-request:stage:";

function stageRetrySlot(
  surfaceKey: string,
  observedCreateKey: string | null | undefined,
  requestId: string,
): string {
  return `${STAGE_RETRY_SLOT_PREFIX}${JSON.stringify([surfaceKey, observedCreateKey, requestId])}`;
}

function stageRetrySurface(slot: string): string | null {
  if (!slot.startsWith(STAGE_RETRY_SLOT_PREFIX)) return null;
  try {
    const identity: unknown = parse(slot.slice(STAGE_RETRY_SLOT_PREFIX.length));
    return Array.isArray(identity) && typeof identity[0] === "string"
      ? identity[0]
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

/** The stage's record is the commit point for a mailbox action. */
export function readPendingStageRecord(
  surfaceKey: string,
): Readonly<Record<string, unknown>> | null {
  try {
    const stage = parse(
      localStorage.getItem(
        recordMapStorageKey(
          persistKey(STORE_KEYS.stagedSandboxSend),
          surfaceKey,
        ),
      ),
    );
    return record(stage) ? stage : null;
  } catch {
    return null;
  }
}

export function pendingStageAttemptCurrent(
  surfaceKey: string,
  stageId: string | null,
  createKey: string | null,
): boolean {
  const stage = readPendingStageRecord(surfaceKey);
  return (
    stage !== null &&
    stage.clientRequestId === stageId &&
    (stage.lastCreateKey ?? stage.clientRequestId) === createKey
  );
}

function stageRetryCandidate(
  name: string,
  stage: Record<string, unknown>,
  entries: ReadonlyArray<readonly [string, unknown]>,
): unknown {
  const currentKey = stage.lastCreateKey ?? stage.clientRequestId;
  let current: unknown;
  let stale: unknown;
  for (const [slot, value] of entries) {
    if (!record(value) || value.clientRequestId !== stage.clientRequestId)
      continue;
    if (value.id === stage.retryHandledId) {
      // A crash after the stage commit can leave the published request behind.
      if (!removeAcknowledgedSlot(name, slot, value.id)) return undefined;
      continue;
    }
    if (value.observedCreateKey === currentKey) current ??= value;
    else stale ??= value;
  }
  return current ?? stale;
}

function removeAcknowledgedSlot(
  name: string,
  slot: string,
  requestId: unknown,
): boolean {
  const storageKey = recordMapStorageKey(name, slot);
  try {
    const saved = parse(localStorage.getItem(storageKey));
    if (record(saved) && saved.id === requestId)
      localStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}

export function removeAcknowledgedStageRetry(
  surfaceKey: string,
  retry: PendingStageRetryRequest,
): void {
  const name = persistKey(STORE_KEYS.stagedSandboxSend);
  removeAcknowledgedSlot(
    name,
    stageRetrySlot(surfaceKey, retry.observedCreateKey, retry.id),
    retry.id,
  );
  removeAcknowledgedSlot(
    name,
    `${RETRY_REGISTER_PREFIX}${surfaceKey}`,
    retry.id,
  );
}

function stageRetrySlots(
  name: string,
  records: Record<string, unknown>,
): Map<string, Array<readonly [string, unknown]>> {
  const bySurface = new Map<string, Array<readonly [string, unknown]>>();
  for (const [slot, value] of Object.entries(records)) {
    const surface = stageRetrySurface(slot);
    if (surface === null || !record(value)) continue;
    if (localStorage.getItem(recordMapStorageKey(name, surface)) === "null") {
      removeAcknowledgedSlot(name, slot, value.id);
      continue;
    }
    const entries = bySurface.get(surface) ?? [];
    entries.push([slot, value]);
    bySurface.set(surface, entries);
  }
  return bySurface;
}

/**
 * Retry is a mailbox, not permission to mutate the owner's stage. Its separate
 * record survives stale stage writes and never overwrites creation progress.
 * Hydration presents it as part of that stage; an acknowledgement belongs to
 * the owning stage and cannot erase a later mailbox request.
 */
function createPendingRetryStorage(
  field: "bySurface" | "sends",
): StateStorage<void> {
  const stageMailbox = field === "bySurface";
  const storage = createRecordMapStorage(
    stageMailbox ? { field, separatePrefix: RETRY_REGISTER_PREFIX } : field,
  );
  return {
    getItem: (name) => {
      const snapshot: unknown = parse(storage.getItem(name));
      if (
        !record(snapshot) ||
        !record(snapshot.state) ||
        !record(snapshot.state[field])
      )
        return null;
      const stages: Record<string, unknown> = {};
      const records = snapshot.state[field];
      const stageSlots = stageMailbox ? stageRetrySlots(name, records) : null;
      for (const [key, stage] of Object.entries(records)) {
        if (key.startsWith(RETRY_REGISTER_PREFIX) || !record(stage)) continue;
        const legacySlot = `${RETRY_REGISTER_PREFIX}${key}`;
        const legacy = records[legacySlot];
        let retry: unknown;
        if (stageSlots !== null) {
          retry = stageRetryCandidate(name, stage, [
            ...(stageSlots.get(key) ?? []),
            [legacySlot, legacy],
          ]);
        } else if (dispatchRetryFor(stage, legacy)) {
          retry = legacy;
        }
        stages[key] =
          retry === undefined ? stage : { ...stage, retryRequest: retry };
      }
      return JSON.stringify({
        ...snapshot,
        state: { ...snapshot.state, [field]: stages },
      });
    },
    setItem: (name, value) => {
      const snapshot: unknown = parse(value);
      if (
        !record(snapshot) ||
        !record(snapshot.state) ||
        !record(snapshot.state[field])
      )
        return;
      const records: Record<string, unknown> = {};
      for (const [key, stage] of Object.entries(snapshot.state[field])) {
        if (!record(stage)) continue;
        const { retryRequest: _request, ...progress } = stage;
        records[key] = progress;
        if (stageMailbox) continue;
        const registerId = `${RETRY_REGISTER_PREFIX}${key}`;
        const retry: unknown = parse(
          localStorage.getItem(recordMapStorageKey(name, registerId)),
        );
        if (dispatchRetryFor(stage, retry)) records[registerId] = retry;
      }
      storage.setItem(
        name,
        JSON.stringify({
          ...snapshot,
          state: { ...snapshot.state, [field]: records },
        }),
      );
    },
    removeItem: (name) => storage.removeItem(name),
  };
}

export function createPendingStageStorage(): StateStorage<void> {
  return createPendingRetryStorage("bySurface");
}

/** Pending claims keep their mailbox separate from receipt/progress writes too. */
export function createPendingSendStorage(): StateStorage<void> {
  return createPendingRetryStorage("sends");
}

function dispatchRetryFor(
  send: Record<string, unknown>,
  value: unknown,
): boolean {
  const dispatch = send.dispatch;
  return (
    record(value) &&
    send.userId === value.userId &&
    send.delivery === null &&
    send.ended !== true &&
    record(dispatch) &&
    record(dispatch.input) &&
    dispatch.input.chatId === value.chatId &&
    dispatch.input.hostId === value.hostId
  );
}

/** No writer of a Retry request can replace an immutable claim or resurrect a receipt. */
export function requestPendingDispatchRetry(input: {
  readonly id: string;
  readonly userId: string | null;
  readonly chatId: string;
  readonly hostId: string;
}): string | null {
  const name = persistKey(STORE_KEYS.pendingSandboxSend);
  const recordKey = recordMapStorageKey(name, input.id);
  const request: PendingDispatchRetryRequest = { ...input, id: uuidv4() };
  const key = recordMapStorageKey(name, `${RETRY_REGISTER_PREFIX}${input.id}`);
  try {
    const before: unknown = parse(localStorage.getItem(recordKey));
    if (!record(before) || !dispatchRetryFor(before, request)) return null;
    localStorage.setItem(key, JSON.stringify(request));
    const saved: unknown = parse(localStorage.getItem(key));
    const after: unknown = parse(localStorage.getItem(recordKey));
    return record(saved) &&
      saved.id === request.id &&
      record(after) &&
      dispatchRetryFor(after, request)
      ? request.id
      : null;
  } catch {
    return null;
  }
}

/** A same-account UI request writes no stage progress and performs no host work. */
export function requestPendingStageRetry(
  input: PendingStagePress & {
    readonly name: string;
    readonly surfaceKey: string;
    readonly userId: string | null;
    readonly clientRequestId: string | null;
    readonly sendId: string;
    readonly action: PendingStageRetryAction;
  },
): string | null {
  const { name, surfaceKey, userId, clientRequestId, sendId } = input;
  try {
    const send: unknown = parse(
      localStorage.getItem(
        recordMapStorageKey(persistKey(STORE_KEYS.pendingSandboxSend), sendId),
      ),
    );
    if (
      !record(send) ||
      send.userId !== userId ||
      send.delivery !== null ||
      (send.dispatch !== null && send.dispatch !== undefined) ||
      send.ended === true ||
      send.stopRequested === true
    )
      return null;
    const stage: unknown = parse(
      localStorage.getItem(recordMapStorageKey(name, surfaceKey)),
    );
    if (!record(stage) || stage.clientRequestId !== clientRequestId)
      return null;
    const request: PendingStageRetryRequest = {
      id: uuidv4(),
      action: input.action,
      userId,
      clientRequestId,
      createKey: input.createKey,
      observedCreateKey: input.observedCreateKey,
      ...(input.retryCreate === undefined
        ? {}
        : { retryCreate: input.retryCreate }),
    };
    const key = recordMapStorageKey(
      name,
      stageRetrySlot(surfaceKey, request.observedCreateKey, request.id),
    );
    localStorage.setItem(key, JSON.stringify(request));
    return request.id;
  } catch {
    return null;
  }
}
