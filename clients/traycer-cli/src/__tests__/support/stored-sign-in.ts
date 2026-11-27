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
 * moves with it.
 */
export function useBoundedFakeClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}
