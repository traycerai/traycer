import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";
import type { HostTokenMintOutcome } from "../../../../shared/auth/host-token-source";
import type { Environment } from "../../runner/environment";
import { createCliCredentialsStore } from "../../store/credentials-store";
import {
  acquireCliSignIn,
  type CliHostBearer,
  type CliSignInHandle,
} from "../cli-host-tokens";
import { nextCasePerson } from "./case-person-test-support";

// Two handles of one person ask fresh for the one host process's token with
// their own exits, over the real token path and a real credentials file,
// against a scripted authn. The second handle's ask joins the request the
// first started. A request authn was sent stays out while any asker still
// waits for it, and is aborted only once every asker has left.

const SIGN_IN = "sign-in-joined-askers";

const harness = vi.hoisted(() => ({
  /** Every authn request in the order sent, with the signal it was sent under. */
  mints: [] as Array<{
    readonly hostId: string;
    readonly signIn: string;
    readonly signal: AbortSignal;
  }>,
  /** The first request is held until the test answers it; its signal's state at that moment. */
  answerHeld: null as ((outcome: HostTokenMintOutcome) => void) | null,
  abortedWhenAnswered: null as boolean | null,
  table: new Map() as HostTokenTable,
}));

const credentialsFile = vi.hoisted(() => ({ path: "" }));

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    cliCredentialsPath: (_environment: Environment): string => {
      if (credentialsFile.path === "")
        throw new Error("no credentials file under test");
      return credentialsFile.path;
    },
  };
});

vi.mock("@traycer-clients/shared/auth/host-token-file", () => ({
  createHostTokenFilePersistence: () => ({
    load: async () => harness.table,
    update: async (change: (table: HostTokenTable) => HostTokenTable) => {
      harness.table = change(harness.table);
      return harness.table;
    },
  }),
}));

vi.mock(
  "@traycer-clients/shared/host-transport/remote/grant-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/grant-client")
      >();
    return {
      ...actual,
      mintHostTokenViaHttp: (
        _authnBaseUrl: string,
        hostId: string,
        signIn: string,
        signal: AbortSignal,
      ): Promise<HostTokenMintOutcome> =>
        new Promise<HostTokenMintOutcome>((resolve) => {
          harness.mints.push({ hostId, signIn, signal });
          // An aborted request answers nothing usable, as the wire does.
          signal.addEventListener(
            "abort",
            () => resolve({ kind: "unavailable", detail: "aborted" }),
            { once: true },
          );
          harness.answerHeld = (outcome) => {
            harness.abortedWhenAnswered = signal.aborted;
            resolve(outcome);
          };
        }),
    };
  },
);

let userId = "";
let hostId = "";
let hostCount = 0;
let workDir = "";

const credentialsOf = (token: string): StoredCredentials => ({
  token,
  refreshToken: `rt-${token}`,
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: userId, email: "user@example.test", name: "User" },
});

beforeEach(async () => {
  userId = nextCasePerson().userId;
  harness.mints.splice(0);
  harness.answerHeld = null;
  harness.abortedWhenAnswered = null;
  harness.table = new Map();
  hostCount += 1;
  hostId = `88888888-8888-4888-8888-${String(hostCount).padStart(12, "0")}`;
  processReleasedHosts.forgetAll();
  workDir = await mkdtemp(join(tmpdir(), "traycer-joined-askers-"));
  credentialsFile.path = join(workDir, "credentials");
});

afterEach(async () => {
  processReleasedHosts.forgetAll();
  credentialsFile.path = "";
  await rm(workDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

/** The host-only token an answer hands the caller, or null for a failure. */
function tokenOf(answer: CliHostBearer): string | null {
  return answer.kind === "ok" ? answer.bearer.getBearerToken() : null;
}

/** Lets what an abort or a start set going run its continuations. */
const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

async function twoHandles(): Promise<{
  readonly first: CliSignInHandle;
  readonly second: CliSignInHandle;
}> {
  const store = createCliCredentialsStore();
  await store.signIn(credentialsOf(SIGN_IN), false, null);
  store.dispose();
  processReleasedHosts.observeInstance(hostId, "boot-1");
  const person = {
    token: SIGN_IN,
    authnBaseUrl: "https://authn.test",
    userId,
  };
  const first = await acquireCliSignIn(person, null);
  const second = await acquireCliSignIn(person, null);
  return { first, second };
}

/** The first handle's ask starts the one request; the second handle's ask then joins it. */
async function secondJoinsFirst(
  first: CliSignInHandle,
  firstExit: AbortSignal | null,
  second: CliSignInHandle,
  secondExit: AbortSignal | null,
): Promise<{
  readonly askedByFirst: Promise<CliHostBearer>;
  readonly askedBySecond: Promise<CliHostBearer>;
}> {
  const askedByFirst = first.tokens.mintFresh(hostId, firstExit);
  while (harness.mints.length === 0) await flush();
  const askedBySecond = second.tokens.mintFresh(hostId, secondExit);
  await flush();
  return { askedByFirst, askedBySecond };
}

function answerHeldRequest(): void {
  const answer = harness.answerHeld;
  if (answer === null) throw new Error("no request was held");
  answer({
    kind: "ok",
    token: { token: "host-token-bought", expiresAtMs: Date.now() + 3_600_000 },
  });
}

describe("two handles of one person asking fresh for one host process's token", () => {
  it("keeps the one request out for the second handle when the first handle's ask ends", async () => {
    const { first, second } = await twoHandles();
    try {
      const firstExit = new AbortController();
      const { askedByFirst, askedBySecond } = await secondJoinsFirst(
        first,
        firstExit.signal,
        second,
        null,
      );

      firstExit.abort();
      await flush();
      answerHeldRequest();

      expect(tokenOf(await askedBySecond)).toBe("host-token-bought");
      expect(tokenOf(await askedByFirst)).toBeNull();
      expect(harness.mints).toHaveLength(1);
      expect(harness.abortedWhenAnswered).toBe(false);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("keeps the one request out for the second handle when the first handle is disposed", async () => {
    const { first, second } = await twoHandles();
    try {
      const { askedByFirst, askedBySecond } = await secondJoinsFirst(
        first,
        null,
        second,
        null,
      );

      first.dispose();
      await flush();
      answerHeldRequest();

      expect(tokenOf(await askedBySecond)).toBe("host-token-bought");
      expect(tokenOf(await askedByFirst)).toBeNull();
      expect(harness.mints).toHaveLength(1);
      expect(harness.abortedWhenAnswered).toBe(false);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("aborts the one request once both handles' asks have ended", async () => {
    const { first, second } = await twoHandles();
    try {
      const firstExit = new AbortController();
      const secondExit = new AbortController();
      const { askedByFirst, askedBySecond } = await secondJoinsFirst(
        first,
        firstExit.signal,
        second,
        secondExit.signal,
      );

      firstExit.abort();
      secondExit.abort();
      await flush();

      expect(harness.mints).toHaveLength(1);
      expect(harness.mints[0]?.signal.aborted).toBe(true);
      expect(tokenOf(await askedByFirst)).toBeNull();
      expect(tokenOf(await askedBySecond)).toBeNull();
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});
