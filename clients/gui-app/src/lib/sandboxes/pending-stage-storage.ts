import type { StateStorage } from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import {
  recordMapStorageKey,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist/keys";
import { createRecordMapStorage } from "@/lib/persist/record-map-storage";

export interface PendingStageRetryRequest {
  readonly id: string;
  readonly userId: string | null;
  readonly clientRequestId: string | null;
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
export function createPendingStageStorage(): StateStorage<void> {
  const storage = createRecordMapStorage("bySurface");
  return {
    getItem: (name) => {
      const snapshot: unknown = parse(storage.getItem(name));
      if (
        !record(snapshot) ||
        !record(snapshot.state) ||
        !record(snapshot.state.bySurface)
      )
        return null;
      const stages: Record<string, unknown> = {};
      const records = snapshot.state.bySurface;
      for (const [key, stage] of Object.entries(records)) {
        if (key.startsWith(RETRY_REGISTER_PREFIX) || !record(stage)) continue;
        const retry = records[`${RETRY_REGISTER_PREFIX}${key}`];
        stages[key] = retryFor(stage, retry)
          ? { ...stage, retryRequest: retry }
          : stage;
      }
      return JSON.stringify({
        ...snapshot,
        state: { ...snapshot.state, bySurface: stages },
      });
    },
    setItem: (name, value) => {
      const snapshot: unknown = parse(value);
      if (
        !record(snapshot) ||
        !record(snapshot.state) ||
        !record(snapshot.state.bySurface)
      )
        return;
      const records: Record<string, unknown> = {};
      for (const [key, stage] of Object.entries(snapshot.state.bySurface)) {
        if (!record(stage)) continue;
        const { retryRequest: _request, ...progress } = stage;
        records[key] = progress;
        const registerId = `${RETRY_REGISTER_PREFIX}${key}`;
        const retry: unknown = parse(
          localStorage.getItem(recordMapStorageKey(name, registerId)),
        );
        if (retryFor(stage, retry)) records[registerId] = retry;
      }
      storage.setItem(
        name,
        JSON.stringify({
          ...snapshot,
          state: { ...snapshot.state, bySurface: records },
        }),
      );
    },
    removeItem: (name) => storage.removeItem(name),
  };
}

/** A same-account UI request writes no stage progress and performs no host work. */
export function requestPendingStageRetry(input: {
  readonly name: string;
  readonly surfaceKey: string;
  readonly userId: string | null;
  readonly clientRequestId: string | null;
  readonly sendId: string;
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
