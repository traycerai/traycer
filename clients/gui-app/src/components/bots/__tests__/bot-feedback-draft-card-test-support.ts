import { act } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { expect, vi } from "vitest";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";

/** The source draft the bot card decides: the local host's first block. */
export const SOURCE = {
  hostId: mockLocalHostEntry.hostId,
  epicId: "epic-1",
  chatId: "chat-1",
  blockId: "block-1",
} as const;

export const PENDING: ToolCallFeedbackDraftStamp = {
  category: "tool_problem",
  toolName: "traycer_run_shell",
  goal: "Restart a shell with a new working directory.",
  observed: "The process kept the old directory.",
  suggestion: null,
  suggestDiagnostics: false,
  state: "pending",
  decidedAt: null,
  failureReason: null,
};

export const UNAVAILABLE_COPY =
  "This feedback draft is unavailable. Try again when its computer is connected.";

export interface Gate<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export function gate<T>(): Gate<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const STEP_MS = 50;
const MAX_ATTEMPTS = 200;

/**
 * Lets the app's own work run on the fake clock, in act, until `check` holds,
 * and rethrows the last failure once the bounded attempts are spent.
 */
export async function until(check: () => void): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw error;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STEP_MS);
      });
    }
  }
}

/**
 * Waits for every mutation and read the client started to settle: a request a
 * press started is on the host, and answered, by the time this returns.
 */
export async function untilIdle(queryClient: QueryClient): Promise<void> {
  await until(() => {
    expect(queryClient.isMutating()).toBe(0);
    expect(queryClient.isFetching()).toBe(0);
  });
}
