import type { StateStorage } from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import {
  recordMapStorageKey,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist/keys";
import { createRecordMapStorage } from "@/lib/persist/record-map-storage";

import type { PendingStageRetryAction } from "./pending-sandbox-send-transition";

export interface PendingStageRetryRequest {
  readonly action?: PendingStageRetryAction;
  readonly id: string;
  readonly userId: string | null;
  readonly clientRequestId: string | null;
}

export interface PendingDispatchRetryRequest {
  readonly id: string;
  readonly userId: string | null;
  readonly chatId: string;
  readonly hostId: string;
}

const RETRY_REGISTER_PREFIX = "retry-request:";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function retryFor(stage: Record<string, unknown>, value: unknown): boolean {
  return record(value) && value.clientRequestId === stage.clientRequestId;
}

/**
 * Retry is a mailbox, not permission to mutate the owner's stage. Its separate
 * record survives stale stage writes and never overwrites creation progress.
 * Hydration presents it as part of that stage; an acknowledgement belongs to
 * the owning stage and cannot erase a later mailbox request.
 */
function createPendingRetryStorage(
  field: "bySurface" | "sends",
  matches: (item: Record<string, unknown>, retry: unknown) => boolean,
): StateStorage<void> {
  const storage = createRecordMapStorage(field);
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
      for (const [key, stage] of Object.entries(records)) {
        if (key.startsWith(RETRY_REGISTER_PREFIX) || !record(stage)) continue;
        const retry = records[`${RETRY_REGISTER_PREFIX}${key}`];
        stages[key] = matches(stage, retry)
          ? { ...stage, retryRequest: retry }
          : stage;
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
        const registerId = `${RETRY_REGISTER_PREFIX}${key}`;
        const retry: unknown = parse(
          localStorage.getItem(recordMapStorageKey(name, registerId)),
        );
        if (matches(stage, retry)) records[registerId] = retry;
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
  return createPendingRetryStorage("bySurface", retryFor);
}

/** Pending claims keep their mailbox separate from receipt/progress writes too. */
export function createPendingSendStorage(): StateStorage<void> {
  return createPendingRetryStorage("sends", dispatchRetryFor);
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
export function requestPendingStageRetry(input: {
  readonly name: string;
  readonly surfaceKey: string;
  readonly userId: string | null;
  readonly clientRequestId: string | null;
  readonly sendId: string;
  readonly action: PendingStageRetryAction;
}): string | null {
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
    };
    const key = recordMapStorageKey(
      name,
      `${RETRY_REGISTER_PREFIX}${surfaceKey}`,
    );
    localStorage.setItem(key, JSON.stringify(request));
    return request.id;
  } catch {
    return null;
  }
}
