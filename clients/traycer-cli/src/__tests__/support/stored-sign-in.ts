import { readFile, rm } from "node:fs/promises";
import { vi } from "vitest";
import { writeCredentialsFile } from "@traycer/protocol/config/credentials";
import { config } from "../../config";
import { cliCredentialsPath } from "../../store/paths";

/**
 * The stored sign-in on the real credentials store under the suite's temp HOME,
 * and authn's refresh answer for it: a suite stubs `fetch`, routes
 * {@link STORED_SIGN_IN_REFRESH_PATH} to {@link refreshAnswer}, and reads what
 * the command left in the file.
 */
export const STORED_SIGN_IN_REFRESH_PATH = "/api/v3/auth/refresh";
export const STORED_REFRESH_TOKEN = "stored-refresh-token";
export const REFRESHED_TOKEN = "refreshed-bearer";
export const REFRESHED_REFRESH_TOKEN = "refreshed-refresh-token";

function credentialsPath(): string {
  return cliCredentialsPath(config.environment);
}

export async function seedStoredSignIn(
  token: string,
  userId: string,
): Promise<void> {
  await writeCredentialsFile(
    credentialsPath(),
    {
      token,
      refreshToken: STORED_REFRESH_TOKEN,
      savedAt: "2026-01-01T00:00:00.000Z",
      user: { id: userId, email: "member@example.test", name: "Member" },
    },
    0,
  );
}

export async function removeStoredSignIn(): Promise<void> {
  const path = credentialsPath();
  for (const file of [path, `${path}.meta.json`, `${path}.lock`]) {
    await rm(file, { recursive: true, force: true });
  }
}

export function storedSignInBytes(): Promise<string> {
  return readFile(credentialsPath(), "utf8");
}

/** authn's 200 answer to a refresh, with the pair it returns. */
export function refreshedPairAnswer(
  token: string,
  refreshToken: string,
): Response {
  return new Response(JSON.stringify({ token, refreshToken }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** `null` is authn being unreachable: the request itself throws. */
export function refreshAnswer(status: number | null): Response {
  if (status === null) throw new TypeError("fetch failed");
  if (status === 200) {
    return refreshedPairAnswer(REFRESHED_TOKEN, REFRESHED_REFRESH_TOKEN);
  }
  return new Response(JSON.stringify({}), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function bearerOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

/**
 * A fake clock for a call that waits on a request authn never answers. Date
 * moves with it, so {@link advanceFakeClockToDeadline} can report how long the
 * wait took.
 */
export function useBoundedFakeClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

/** The most turns {@link advanceFakeClockToDeadline} drains before it fails. */
const MAX_DRAIN_TURNS = 100;

/**
 * Runs the fake clock toward `deadlineMs`, from the moment the request the
 * test waits on has started, until `operation` has settled, and returns the
 * fake time that took. Each turn yields to real I/O (the store's file work is
 * not on the clock) and then runs the next timer, never starting one once the
 * deadline has passed. It fails the test after {@link MAX_DRAIN_TURNS} turns
 * with the operation still pending. The caller awaits `operation` itself and
 * asserts its result.
 */
export async function advanceFakeClockToDeadline(
  operation: Promise<unknown>,
  deadlineMs: number,
): Promise<number> {
  const startedAt = Date.now();
  let settledAt: number | null = null;
  const markSettled = (): void => {
    settledAt = Date.now();
  };
  const readSettledAt = (): number | null => settledAt;
  void operation.then(markSettled, markSettled);
  for (let turn = 0; readSettledAt() === null; turn += 1) {
    if (turn === MAX_DRAIN_TURNS) {
      throw new Error(
        `the operation was still pending after ${MAX_DRAIN_TURNS} drain turns, ${Date.now() - startedAt} ms into its ${deadlineMs} ms deadline`,
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (
      readSettledAt() === null &&
      Date.now() < startedAt + deadlineMs &&
      vi.getTimerCount() > 0
    ) {
      await vi.advanceTimersToNextTimerAsync();
    }
  }
  return (readSettledAt() ?? startedAt) - startedAt;
}
