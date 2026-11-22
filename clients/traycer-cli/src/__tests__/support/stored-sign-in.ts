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

/** The fake time {@link advanceFakeClockToDeadline} moves in one turn, at most. */
const STEP_MS = 100;

/**
 * The most turns in a row {@link advanceFakeClockToDeadline} yields, with the
 * deadline ahead and no timer pending, before it fails. No current caller
 * ever idles, so this only has to be finite.
 */
const MAX_IDLE_TURNS = 1_000;

/**
 * The most turns {@link advanceFakeClockToDeadline} drains, with the clock
 * stopped at the deadline, before it fails.
 */
const MAX_DRAIN_TURNS = 100;

function yieldToRealIo(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Runs the fake clock toward `deadlineMs`, from the moment the request the
 * test waits on has started, until `operation` has settled, and returns the
 * fake time that took. Each turn yields to real I/O (the store's file work is
 * not on the clock); while timers are pending and the deadline is ahead it then
 * advances the clock by the smaller of {@link STEP_MS} and the time left, so
 * the clock never passes the deadline and no timer set for later than it runs.
 * With the deadline ahead and no timer pending the clock stays put and the
 * yields go on: the call fails the test if `operation` is still pending after
 * {@link MAX_IDLE_TURNS} of them in a row. Once the deadline is reached the
 * clock also stays put: the call fails the test if `operation` is still pending
 * after {@link MAX_DRAIN_TURNS} yields, whether it waits on a timer set for
 * later than the deadline or on nothing. The caller awaits `operation` itself
 * and asserts its result.
 */
export async function advanceFakeClockToDeadline(
  operation: Promise<unknown>,
  deadlineMs: number,
): Promise<number> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + deadlineMs;
  let settledAt: number | null = null;
  const markSettled = (): void => {
    settledAt = Date.now();
  };
  const readSettledAt = (): number | null => settledAt;
  void operation.then(markSettled, markSettled);
  let drainTurns = 0;
  let idleTurns = 0;
  while (readSettledAt() === null) {
    await yieldToRealIo();
    if (readSettledAt() !== null) break;
    const timeLeftMs = deadlineAt - Date.now();
    if (timeLeftMs > 0) {
      if (vi.getTimerCount() > 0) {
        idleTurns = 0;
        await vi.advanceTimersByTimeAsync(Math.min(STEP_MS, timeLeftMs));
      } else {
        idleTurns += 1;
        if (idleTurns > MAX_IDLE_TURNS) {
          throw new Error(
            `the operation was still pending after ${MAX_IDLE_TURNS} turns in a row with no timer pending, ${Date.now() - startedAt} ms into its ${deadlineMs} ms deadline`,
          );
        }
      }
    } else {
      drainTurns += 1;
      if (drainTurns > MAX_DRAIN_TURNS) {
        throw new Error(
          `the operation was still pending ${MAX_DRAIN_TURNS} drain turns after its ${deadlineMs} ms deadline, with ${vi.getTimerCount()} timer(s) pending`,
        );
      }
    }
  }
  return (readSettledAt() ?? startedAt) - startedAt;
}
