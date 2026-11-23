import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import type { HostTokenMintOutcome } from "../../../../shared/auth/host-token-source";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import type { HostRequestOptions } from "../../../../shared/host-transport/host-messenger";
import type { WsRpcClientOptions } from "../../../../shared/host-transport/ws-rpc-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/registry";
import { createAuthenticatedUserFixture } from "../../../../shared/test-fixtures/authenticated-user";
import { listBots } from "../bot-host";
import { readSignInEnvironments } from "../sign-in-environments";
import { completeCredentialsReserve } from "./credentials-reserve-test-support";
import { createCliCredentialsStore } from "../../store/credentials-store";
import { nextCasePerson } from "./case-person-test-support";

// `traycer bot list` runs `readSignInEnvironments()` and `listBots()` at once
// (commands/bot-list.ts). Both start from one stored sign-in that authn
// refuses, over a real credentials file. The person's sign-in is refreshed once,
// and both calls answer on the sign-in that refresh produced.

const authn = vi.hoisted(() => ({
  /** Each refresh authn was asked for: the refresh token it was sent. */
  refreshes: [] as string[],
  refreshAnswer: "accepted" as "accepted" | "refused",
  /** Every sign-in authn was asked to read the identity of, in order. */
  identityReads: [] as string[],
  /** Every sign-in a host-only token was asked for, in order. */
  mints: [] as string[],
}));
const home = vi.hoisted(() => ({
  path: null as string | null,
  credentials: "",
}));
const rpc = vi.hoisted(() => ({ requests: [] as string[] }));

const ROTATED_PREFIX = "rotated-sign-in-";
const isRotated = (signIn: string): boolean =>
  signIn.startsWith(ROTATED_PREFIX);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.path ?? actual.homedir() };
});

vi.mock("../../logger", () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    createCliLogger: () => logger,
    errorFromUnknown: (value: unknown) =>
      value instanceof Error ? value : new Error(String(value)),
    noopLogger: logger,
  };
});

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return { ...actual, cliCredentialsPath: (): string => home.credentials };
});

vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return {
    ...actual,
    refreshOnceAbortable: async (args: { readonly refreshToken: string }) => {
      authn.refreshes.push(args.refreshToken);
      if (authn.refreshAnswer === "refused")
        return {
          kind: "rejected" as const,
          rejection: { kind: "credential" as const, revocation: null },
        };
      const token = `${ROTATED_PREFIX}${authn.refreshes.length}`;
      return {
        kind: "refreshed" as const,
        token,
        refreshToken: `rt-${token}`,
      };
    },
    validateAuthTokenIdentityAccessOnly: async (
      _authnBaseUrl: string,
      token: string,
    ) => {
      authn.identityReads.push(token);
      return isRotated(token)
        ? { kind: "valid" as const, user: createAuthenticatedUserFixture(undefined) }
        : { kind: "rejected" as const };
    },
  };
});

vi.mock(
  "@traycer-clients/shared/host-transport/remote/grant-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/grant-client")
      >();
    return {
      ...actual,
      mintHostTokenViaHttp: async (
        _authnBaseUrl: string,
        _hostId: string,
        signIn: string,
      ): Promise<HostTokenMintOutcome> => {
        authn.mints.push(signIn);
        return isRotated(signIn)
          ? {
              kind: "ok",
              token: {
                token: `host-token-${authn.mints.length}`,
                expiresAtMs: Date.now() + 3_600_000,
              },
            }
          : { kind: "sign-in-rejected" };
      },
    };
  },
);

vi.mock("../../host/pid-metadata", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadata: async () => ({
      pid: 1,
      hostId: "d1",
      version: "2.0.0",
      websocketUrl: "ws://127.0.0.1:9/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      processStartIdentityRead: "absent",
      layer0: null,
      layer0Slot: null,
    }),
  };
});

vi.mock(
  "../../../../shared/host-transport/ws-rpc-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../shared/host-transport/ws-rpc-client")
      >();
    const { resolveStubbedCallBearer } = await import("./stub-rpc-bearer");
    return {
      ...actual,
      WsRpcClient: class {
        constructor(
          private readonly clientOptions: WsRpcClientOptions<HostRpcRegistry>,
        ) {}

        request = async (
          method: string,
          _params: unknown,
          options: HostRequestOptions,
        ) => {
          await resolveStubbedCallBearer(this.clientOptions, method, options);
          rpc.requests.push(method);
          return { bots: [], mainBotIds: null };
        };
        requestWithResponseTimeout = async (
          method: string,
          params: unknown,
          _responseTimeoutMs: number,
          options: HostRequestOptions,
        ) => this.request(method, params, options);
        releaseIdleLocalSessions = vi.fn();
      },
    };
  },
);

const STALE_SIGN_IN = "stale-sign-in";

beforeEach(async () => {
  authn.refreshes.length = 0;
  authn.identityReads.length = 0;
  authn.mints.length = 0;
  rpc.requests.length = 0;
  authn.refreshAnswer = "accepted";
  const dir = await mkdtemp(join(tmpdir(), "traycer-sign-in-environments-"));
  home.path = dir;
  home.credentials = join(dir, "credentials");
  processReleasedHosts.forgetAll();
  // A person of this case's own: the process keeps its judgement of a sign-in per person.
  const person = nextCasePerson();
  await completeCredentialsReserve(home.credentials);
  const store = createCliCredentialsStore();
  const credentials: StoredCredentials = {
    token: STALE_SIGN_IN,
    refreshToken: `rt-${STALE_SIGN_IN}`,
    savedAt: "2026-01-01T00:00:00.000Z",
    user: { id: person.userId, email: "a@b.c", name: "A" },
  };
  await store.signIn(credentials, false, null);
  store.dispose();
});

afterEach(async () => {
  processReleasedHosts.forgetAll();
  const dir = home.path;
  home.path = null;
  if (dir !== null) await rm(dir, { recursive: true, force: true });
});

describe("the concurrent pair of `traycer bot list`", () => {
  it("asks authn for one refresh of the refused sign-in, and both calls answer on the sign-in it produced", async () => {
    const [environments, bots] = await Promise.allSettled([
      readSignInEnvironments(),
      listBots(),
    ]);

    expect(environments.status).toBe("fulfilled");
    expect(bots.status).toBe("fulfilled");
    expect(authn.refreshes).toEqual([`rt-${STALE_SIGN_IN}`]);
    // Nothing is sent on a sign-in other than the stale one and the one the refresh produced.
    const rotated = `${ROTATED_PREFIX}1`;
    for (const sent of [...authn.identityReads, ...authn.mints])
      expect([STALE_SIGN_IN, rotated]).toContain(sent);
    expect(authn.identityReads.at(-1)).toBe(rotated);
    expect(authn.mints.at(-1)).toBe(rotated);
  });

  it("asks authn for one refresh when it refuses that refresh too", async () => {
    authn.refreshAnswer = "refused";

    const [environments, bots] = await Promise.allSettled([
      readSignInEnvironments(),
      listBots(),
    ]);

    expect(environments.status).toBe("rejected");
    expect(bots.status).toBe("rejected");
    expect(authn.refreshes).toEqual([`rt-${STALE_SIGN_IN}`]);
  });
});
