import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCredentialsFile } from "@traycer/protocol/config/credentials";
import type { CredentialsMutationStore } from "@traycer/protocol/config/credentials-mutation";
import type { HostTokenTable } from "@traycer-clients/shared/auth/host-token-store";
import {
  HostRpcError,
  type HostRequestOptions,
} from "../../../../shared/host-transport/host-messenger";
import type { HostPidMetadata } from "../pid-metadata";
import type { HealthProbeOptions } from "../../service/health-probe";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { createAuthenticatedUserFixture } from "../../../../shared/test-fixtures/authenticated-user";

// The give's readiness poll runs on the health probe's 45 s budget, and each
// try bounds its host call with `AbortSignal.timeout(remainingMs)`. These
// cases drive the real give (`useInstalledHostTeam`, the one transfer that
// `host use`, `host install --team` and `host ensure --team` share) through
// the real host call and the real host-only token open and recovery. Only the
// edges are fakes: the host's websocket replies, authn's HTTP routes, the
// token file, the clock and the native abort timer. The native
// `AbortSignal.timeout` timer is not driven by fake timers, so it is replaced
// by one that is, which aborts with the same `TimeoutError` at the same
// requested time.

const mocks = vi.hoisted(() => ({
  requestMock: vi.fn(),
  resolveHostAuthMock: vi.fn(),
  readHostPidMetadataMock: vi.fn(),
  readHostOwnershipMock: vi.fn(),
  validateIdentityMock: vi.fn(),
  credentialsPath: "",
  hostTokenTable: new Map() as HostTokenTable,
}));

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

vi.mock(
  "../../../../shared/host-transport/ws-rpc-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../shared/host-transport/ws-rpc-client")
      >();
    return {
      ...actual,
      WsRpcClient: class {
        request = (
          method: string,
          params: unknown,
          options: HostRequestOptions,
        ) => mocks.requestMock(method, params, options);
        requestWithResponseTimeout = (
          method: string,
          params: unknown,
          _responseTimeoutMs: number,
          options: HostRequestOptions,
        ) => mocks.requestMock(method, params, options);
        releaseIdleLocalSessions = vi.fn();
      },
    };
  },
);

vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return {
    ...actual,
    validateAuthTokenIdentityAccessOnly: mocks.validateIdentityMock,
  };
});

vi.mock("../../internal/host-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-auth")>();
  return { ...actual, resolveHostAuth: mocks.resolveHostAuthMock };
});

vi.mock("../pid-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pid-metadata")>();
  return { ...actual, readHostPidMetadata: mocks.readHostPidMetadataMock };
});

// The poll's budget and cadence stay real; only the loopback TCP and process
// checks, which would touch the machine, are answered.
vi.mock("../../service/health-probe", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/health-probe")>();
  return {
    ...actual,
    probeHostHealth: (options: HealthProbeOptions) =>
      actual.probeHostHealth({
        ...options,
        checkProcessAlive: () => true,
        checkTcpReachable: () => Promise.resolve(true),
      }),
  };
});

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return { ...actual, createCliCredentialsStore: () => fakeStore };
});

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return { ...actual, cliCredentialsPath: () => mocks.credentialsPath };
});

vi.mock(
  "@traycer-clients/shared/auth/host-token-file",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/auth/host-token-file")
      >();
    return {
      ...actual,
      createHostTokenFilePersistence: () => ({
        load: async () => mocks.hostTokenTable,
        update: async (change: (table: HostTokenTable) => HostTokenTable) => {
          mocks.hostTokenTable = change(mocks.hostTokenTable);
          return mocks.hostTokenTable;
        },
      }),
    };
  },
);

vi.mock(
  "@traycer-clients/shared/host-client/host-ownership",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-ownership")
      >();
    return { ...actual, readHostOwnershipViaHttp: mocks.readHostOwnershipMock };
  },
);

import { useInstalledHostTeam } from "../install-auth";

const fakeStore: CredentialsMutationStore = {
  read: vi.fn(),
  rotate: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  signOutIfToken: vi.fn(),
  drainQuarantine: vi.fn(),
  updateProfile: vi.fn(),
  guardedSignIn: vi.fn(),
  migrateFirstWrite: vi.fn(),
  hasPendingContinuation: vi.fn(() => false),
  dispose: vi.fn(),
};

const HOST_ID = "00000000-0000-4000-8000-000000000001";
const TEAM_ID = "00000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000004";
const ACCEPTANCE_ID = "00000000-0000-4000-8000-000000000005";
const USER_ID = "user-1";
const GIVE_BUDGET_MS = 45_000;
const TRANSFER_LINE =
  "The team transfer could not be confirmed. Check this computer in the app before trying again.";

const TARGET_ENVIRONMENT_ID = "environment-acme";
const personalBinding = {
  hostId: HOST_ID,
  environment: {
    environmentId: "environment-personal",
    ownerKind: "user",
    ownerId: USER_ID,
    roomId: "room-personal",
    label: "Personal",
  },
  explicit: false,
  enrolledByUserId: null,
  canUnbind: false,
};

/** The sign-in's own record: Acme, listed by its slug. */
function signInWithAcme() {
  const base = createAuthenticatedUserFixture(undefined);
  return {
    ...base,
    user: { ...base.user, id: USER_ID },
    environments: {
      personal: "environment-personal",
      teams: [{ teamId: TEAM_ID, environmentId: TARGET_ENVIRONMENT_ID }],
    },
    teamSubscriptions: [
      {
        team: { id: TEAM_ID, slug: "acme" },
      } as (typeof base.teamSubscriptions)[number],
    ],
  };
}

function movePlan() {
  return {
    planHash: "a".repeat(64),
    planRevision: 3,
    hostVersion: "1.2.3",
    disclosureVersion: 2,
    rows: {
      moves: [],
      staysOnThisComputer: [],
      alreadyInPersonal: [],
      differsMasked: [],
      looksLikeAKey: [],
      sameNameInPersonal: [],
    },
    guideDiffers: false,
    personalHoldsSecrets: false,
  };
}

function moveStage() {
  return {
    evidence: {
      attemptId: ATTEMPT_ID,
      planHash: "a".repeat(64),
      planRevision: 3,
      hostVersion: "1.2.3",
      itemCount: 0,
      keyChoices: [],
      sourceHostId: HOST_ID,
      sharingGeneration: 1,
      targetKind: "team",
      environmentId: TARGET_ENVIRONMENT_ID,
      teamId: TEAM_ID,
      disclosureVersion: 2,
    },
    authorization: { disclosureHash: "b".repeat(64) },
  };
}

function hostMetadata(): HostPidMetadata {
  return {
    pid: process.pid,
    hostId: HOST_ID,
    version: "1.0.0",
    websocketUrl: "ws://127.0.0.1:9/rpc",
    startedAt: "2026-11-15T00:00:00.000Z",
    processStartIdentity: null,
    processStartIdentityRead: "absent",
    layer0: null,
    layer0Slot: null,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenRefusal(): HostRpcError {
  return new HostRpcError({
    code: "UNAUTHORIZED",
    message: "expired",
    requestId: "door-refusal",
    method: "environment.status",
    fatalDetails: {
      code: "UNAUTHORIZED",
      reason: "expired",
      incompatibleMethods: null,
      upgradeGuidance: null,
      doorReason: "token_expired",
    },
  });
}

/** One host-only token mint that authn never answers. */
interface HeldMint {
  readonly signal: AbortSignal;
  abortedAtMs: number | null;
  reason: unknown;
}

let held: HeldMint[];
let abortTimeoutRequests: number[];
let refuseStatusFromMs: number | null;
let startedAtMs: number;
let credentialsRoot: string;

/** The first mint (the give's first host call) is answered; every later one is held. */
function stubAuthn(tokenLifetimeSeconds: number): void {
  let mints = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (url.endsWith("/move-acceptances")) {
        return Promise.resolve(
          jsonResponse(201, { acceptanceId: ACCEPTANCE_ID }),
        );
      }
      if (!url.endsWith("/session-grant")) {
        throw new Error(`unexpected authn request ${url}`);
      }
      mints += 1;
      if (mints === 1) {
        return Promise.resolve(
          jsonResponse(200, {
            session_grant: "host-token-one",
            session_grant_expires_in: tokenLifetimeSeconds,
          }),
        );
      }
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("the mint was sent with no abort signal");
      }
      const mint: HeldMint = { signal, abortedAtMs: null, reason: undefined };
      signal.addEventListener(
        "abort",
        () => {
          mint.abortedAtMs = Date.now();
          mint.reason = signal.reason;
        },
        { once: true },
      );
      held.push(mint);
      return new Promise<Response>(() => undefined);
    }),
  );
}

function answerHost(): void {
  mocks.requestMock.mockImplementation(async (method: string) => {
    switch (method) {
      case "environment.move.plan":
        return movePlan();
      case "environment.move.stage":
        return moveStage();
      case "environment.move.start":
        return {
          state: "running",
          attemptId: ATTEMPT_ID,
          acceptanceId: ACCEPTANCE_ID,
        };
      case "environment.status":
        if (
          refuseStatusFromMs !== null &&
          Date.now() - startedAtMs >= refuseStatusFromMs
        ) {
          throw tokenRefusal();
        }
        return { move: null };
      case "environment.host.read":
        return personalBinding;
      default:
        throw new Error(`unexpected host call ${method}`);
    }
  });
}

function tokenTableSnapshot(): string {
  return JSON.stringify(
    [...mocks.hostTokenTable].map(([user, hosts]) => [user, [...hosts]]),
  );
}

interface GiveRun {
  readonly outcome:
    | { readonly status: "resolved" }
    | { readonly status: "rejected"; readonly error: unknown };
  readonly endedAtMs: number;
  readonly tokensAfterFirstCall: string;
}

/**
 * Runs the give on the fake clock until it settles, and reports when it did.
 * The first host call mints and saves the host-only token; the table is
 * recorded as it stands after that, to be compared with the end.
 */
async function runGive(): Promise<GiveRun> {
  let endedAtMs: number | null = null;
  let tokensAfterFirstCall = "";
  mocks.requestMock.mockImplementationOnce(async (method: string) => {
    tokensAfterFirstCall = tokenTableSnapshot();
    expect(method).toBe("environment.move.plan");
    return movePlan();
  });
  const give = useInstalledHostTeam("acme", vi.fn());
  const observed = give.then(
    () => {
      endedAtMs = Date.now();
      return { status: "resolved" as const };
    },
    (error: unknown) => {
      endedAtMs = Date.now();
      return { status: "rejected" as const, error };
    },
  );
  for (let step = 0; step < 400 && endedAtMs === null; step += 1) {
    await vi.advanceTimersByTimeAsync(250);
  }
  const outcome = await observed;
  if (endedAtMs === null) throw new Error("the give never settled");
  return {
    outcome,
    endedAtMs,
    tokensAfterFirstCall: tokensAfterFirstCall,
  };
}

function expectTransferLine(run: GiveRun): void {
  expect(run.outcome.status).toBe("rejected");
  if (run.outcome.status !== "rejected") return;
  expect(run.outcome.error).toMatchObject({
    code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
    message: TRANSFER_LINE,
    exitCode: 1,
  });
}

beforeEach(async () => {
  held = [];
  abortTimeoutRequests = [];
  refuseStatusFromMs = null;
  credentialsRoot = mkdtempSync(join(tmpdir(), "team-give-deadline-"));
  mocks.credentialsPath = join(credentialsRoot, "cli", "credentials");
  mocks.hostTokenTable = new Map();
  await writeCredentialsFile(
    mocks.credentialsPath,
    {
      token: "stored-bearer",
      refreshToken: "stored-refresh",
      savedAt: "2026-11-10T00:00:00.000Z",
      user: { id: USER_ID, email: "member@example.test", name: "Member" },
    },
    0,
  );
  mocks.requestMock.mockReset();
  mocks.resolveHostAuthMock.mockReset();
  mocks.resolveHostAuthMock.mockResolvedValue({
    token: "stored-bearer",
    authnBaseUrl: "https://authn.test",
    userId: USER_ID,
  });
  mocks.readHostPidMetadataMock.mockReset();
  mocks.readHostPidMetadataMock.mockResolvedValue(hostMetadata());
  mocks.validateIdentityMock.mockReset();
  mocks.validateIdentityMock.mockResolvedValue({
    kind: "valid",
    user: signInWithAcme(),
  });
  mocks.readHostOwnershipMock.mockReset();
  mocks.readHostOwnershipMock.mockResolvedValue({
    kind: "ok",
    host: {
      hostId: HOST_ID,
      owner: { kind: "user", id: USER_ID },
      kind: "personal",
      remoteAccess: false,
    },
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T12:00:00.000Z"));
  startedAtMs = Date.now();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    abortTimeoutRequests.push(ms);
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(
        new DOMException("The operation timed out.", "TimeoutError"),
      );
    }, ms);
    return controller.signal;
  });
  answerHost();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(credentialsRoot, { recursive: true, force: true });
});

describe("the team give's readiness poll", () => {
  it("ends a try at the give's deadline when its token mint is held with the budget nearly spent", async () => {
    // The token expires 1 s before the budget does, so the try at that moment
    // must mint before it can reach the host, with 1 s of the budget left.
    stubAuthn(44);

    const run = await runGive();

    expectTransferLine(run);
    expect(held).toHaveLength(1);
    expect(abortTimeoutRequests).toContain(1_000);
    expect(held[0].signal.aborted).toBe(true);
    expect(held[0].abortedAtMs).toBe(startedAtMs + GIVE_BUDGET_MS);
    // The try's own signal cancelled it, not the mint's 10 s request timeout.
    expect(held[0].reason).toMatchObject({ name: "AbortError" });
    expect(run.endedAtMs).toBe(startedAtMs + GIVE_BUDGET_MS);
    expect(tokenTableSnapshot()).toBe(run.tokensAfterFirstCall);
  });

  it("ends the give at its deadline with the transfer line when every later try's mint is held", async () => {
    // The token expires after 14 s: the tries at 14, 26 and 38 s each hold a
    // mint. The first two end on the mint's own 10 s timeout; the third has
    // 7 s of the budget left and ends with the give.
    stubAuthn(14);

    const run = await runGive();

    expectTransferLine(run);
    expect(held).toHaveLength(3);
    for (const mint of held) {
      expect(mint.signal.aborted).toBe(true);
    }
    expect(held.map((mint) => mint.abortedAtMs)).toEqual([
      startedAtMs + 24_000,
      startedAtMs + 36_000,
      startedAtMs + GIVE_BUDGET_MS,
    ]);
    expect(held[2].reason).toMatchObject({ name: "AbortError" });
    expect(run.endedAtMs).toBe(startedAtMs + GIVE_BUDGET_MS);
    expect(tokenTableSnapshot()).toBe(run.tokensAfterFirstCall);
  });

  it("cancels the recovery's fresh-token mint with the try when the host refuses the call near the deadline", async () => {
    // The host accepts the token at open and refuses the status call at 44 s
    // as expired. The recovery asks for a fresh token with no signal of its
    // own, and authn never answers it.
    stubAuthn(120);
    refuseStatusFromMs = 43_500;

    const run = await runGive();

    expectTransferLine(run);
    expect(held).toHaveLength(1);
    expect(held[0].signal.aborted).toBe(true);
    expect(held[0].abortedAtMs).toBe(startedAtMs + GIVE_BUDGET_MS);
    expect(held[0].reason).toMatchObject({ name: "AbortError" });
    expect(run.endedAtMs).toBe(startedAtMs + GIVE_BUDGET_MS);
    // A mint the deadline cancelled is not a refusal: the give ends on the
    // transfer line, not on the stored credential being rejected, and the
    // token file keeps the token it held.
    expect(tokenTableSnapshot()).toBe(run.tokensAfterFirstCall);
  });
});
