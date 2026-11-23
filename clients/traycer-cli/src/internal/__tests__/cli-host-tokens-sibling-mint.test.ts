import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import type { AuthTokenRefreshResult } from "../../../../shared/auth/auth-validation";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";
import type { HostTokenMintOutcome } from "../../../../shared/auth/host-token-source";
import type { Environment } from "../../runner/environment";
import { createCliCredentialsStore } from "../../store/credentials-store";
import {
  acquireCliSignIn,
  type CliHostBearer,
  type CliHostTokens,
  type CliSignInHandle,
} from "../cli-host-tokens";
import { nextCasePerson } from "./case-person-test-support";

// Two token sessions of one person for one host process, over the real token
// path and a real credentials file, against a scripted authn. One session's
// mint request is held while the stored sign-in moves on and the other
// session's request buys a token; the held request then comes back refused.
// What is asserted is what the person gets and what authn was sent.

const SIGN_IN = "sign-in-held-request";
const SIGN_IN_MOVED = "sign-in-moved-on";
const USABLE_HELD_TOKEN = {
  token: "host-token-held-in-file",
  expiresAtMs: Date.now() + 3_600_000,
};

const harness = vi.hoisted(() => ({
  /** Every authn request, in the order sent. */
  mints: [] as Array<{ readonly hostId: string; readonly signIn: string }>,
  /** Requests answered when the test says; the first is held, every later one is answered ok. */
  held: [] as Array<(outcome: HostTokenMintOutcome) => void>,
  /** Called as each authn request is sent. */
  onSend: null as ((index: number) => void) | null,
  table: new Map() as HostTokenTable,
  refreshes: 0,
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

vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return {
    ...actual,
    refreshOnceAbortable: async (): Promise<AuthTokenRefreshResult> => {
      harness.refreshes += 1;
      return {
        kind: "rejected",
        rejection: { kind: "credential", revocation: null },
      };
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
      ): Promise<HostTokenMintOutcome> =>
        new Promise<HostTokenMintOutcome>((resolve) => {
          const index = harness.mints.length;
          harness.mints.push({ hostId, signIn });
          if (index === 0) harness.held.push(resolve);
          else
            resolve({
              kind: "ok",
              token: {
                token: `host-token-bought-${index}`,
                expiresAtMs: Date.now() + 3_600_000,
              },
            });
          harness.onSend?.(index);
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
  harness.held.splice(0);
  harness.onSend = null;
  harness.refreshes = 0;
  harness.table = new Map();
  hostCount += 1;
  hostId = `77777777-7777-4777-8777-${String(hostCount).padStart(12, "0")}`;
  processReleasedHosts.forgetAll();
  workDir = await mkdtemp(join(tmpdir(), "traycer-sibling-mint-"));
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

/**
 * One token session of the person over the shared credentials file, signed in
 * as the held request's sign-in until the file is read again. A second session
 * of the person is a handle on the same lease, store and tokens.
 */
async function sessionOverFile(): Promise<{
  readonly tokens: CliHostTokens;
  readonly readFile: () => Promise<void>;
  readonly dispose: () => void;
}> {
  const handle: CliSignInHandle = await acquireCliSignIn(
    { token: SIGN_IN, authnBaseUrl: "https://authn.test", userId },
    null,
  );
  return {
    tokens: handle.tokens,
    readFile: () => handle.revalidator.adoptStoredSignIn(),
    dispose: () => handle.dispose(),
  };
}

describe("a refused mint whose stored sign-in moved on while a sibling session bought a token", () => {
  /** X's request is held, the stored sign-in moves on, Y buys a token, then X's request comes back refused. */
  async function refusedAfterSiblingBought(): Promise<{
    readonly answeredToX: CliHostBearer;
    readonly boughtByY: CliHostBearer;
  }> {
    const other = createCliCredentialsStore();
    await other.signIn(credentialsOf(SIGN_IN), false, null);
    processReleasedHosts.observeInstance(hostId, "boot-1");
    const x = await sessionOverFile();
    const y = await sessionOverFile();
    try {
      const sent = new Promise<void>((resolve) => {
        harness.onSend = (index) => {
          if (index === 0) resolve();
        };
      });
      const askingX = x.tokens.mintFresh(hostId, null);
      await sent;
      harness.onSend = null;
      // The stored sign-in moves on while X's request is out.
      await other.signIn(credentialsOf(SIGN_IN_MOVED), false, null);
      // Y reads the file now, so it asks on the sign-in the file holds.
      await y.readFile();
      const boughtByY = await y.tokens.mintFresh(hostId, null);
      const release = harness.held[0];
      if (release === undefined) throw new Error("no request was held");
      release({ kind: "sign-in-rejected" });
      return { answeredToX: await askingX, boughtByY };
    } finally {
      x.dispose();
      y.dispose();
    }
  }

  it("answers the token the sibling bought and sends authn no third request, when the file held a usable token at load", async () => {
    harness.table = new Map([[userId, new Map([[hostId, USABLE_HELD_TOKEN]])]]);

    const { answeredToX, boughtByY } = await refusedAfterSiblingBought();

    expect(tokenOf(boughtByY)).toBe("host-token-bought-1");
    expect(tokenOf(answeredToX)).toBe("host-token-bought-1");
    expect(harness.mints).toHaveLength(2);
  });

  it("answers the token the sibling bought and sends authn no third request, when the file was empty at load", async () => {
    const { answeredToX, boughtByY } = await refusedAfterSiblingBought();

    expect(tokenOf(boughtByY)).toBe("host-token-bought-1");
    expect(tokenOf(answeredToX)).toBe("host-token-bought-1");
    expect(harness.mints).toHaveLength(2);
  });
});
