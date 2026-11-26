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
import { environmentStatusResponseSchemaV13 } from "@traycer/protocol/host/environment-schemas";
import { TEAM_TRANSFER_DISCLOSURE_VERSION } from "@traycer/protocol/host/environment/team-transfer-disclosure";
import {
  environmentMoveOutcomeAnswerSchema,
  environmentMovePlanResponseSchemaV20,
  environmentMoveStageResponseSchema,
} from "@traycer/protocol/host/environment/move-contracts";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { createAuthenticatedUserFixture } from "../../../../shared/test-fixtures/authenticated-user";

// Fake timers do not drive the native `AbortSignal.timeout`, so it is replaced by
// one they do, aborting with the same `TimeoutError` at the same requested time.

const mocks = vi.hoisted(() => {
  class HostSocket {
    onopen: ((event: { readonly type: "open" }) => void) | null = null;
    onmessage: ((event: { readonly data: string }) => void) | null = null;
    onerror: ((event: { readonly type: "error" }) => void) | null = null;
    onclose:
      | ((event: {
          readonly code: number;
          readonly reason: string;
          readonly wasClean: boolean;
        }) => void)
      | null = null;
    /** The token each OPEN the client wrote carried. */
    readonly openTokens: string[] = [];

    send(data: string): void {
      const frame: unknown = JSON.parse(data);
      if (typeof frame !== "object" || frame === null || !("kind" in frame))
        return;
      if (frame.kind === "open" && "token" in frame) {
        if (typeof frame.token === "string") this.openTokens.push(frame.token);
        const manifest = "manifest" in frame ? frame.manifest : null;
        const optionalManifest =
          "optionalManifest" in frame ? frame.optionalManifest : null;
        setTimeout(
          () => this.deliver({ kind: "openAck", manifest, optionalManifest }),
          0,
        );
        return;
      }
      if (
        frame.kind === "request" &&
        "requestId" in frame &&
        "method" in frame &&
        typeof frame.method === "string" &&
        "schemaVersion" in frame
      ) {
        const { requestId, method, schemaVersion } = frame;
        setTimeout(() => {
          void mocks.requestMock(method, null, {}).then(
            (result: unknown) =>
              this.deliver({
                kind: "response",
                requestId,
                method,
                schemaVersion,
                result,
                error: null,
              }),
            (error: unknown) => this.deliver(fatalFrameOf(error)),
          );
        }, 0);
      }
    }

    close(_code: number, _reason: string): void {}

    deliver(frame: unknown): void {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
  }
  const fatalFrameOf = (error: unknown): unknown => ({
    kind: "fatalError",
    details:
      typeof error === "object" && error !== null && "fatalDetails" in error
        ? error.fatalDetails
        : null,
  });
  return {
    HostSocket,
    sockets: [] as InstanceType<typeof HostSocket>[],
    requestMock: vi.fn(),
    resolveHostAuthMock: vi.fn(),
    readHostPidMetadataMock: vi.fn(),
    readHostOwnershipMock: vi.fn(),
    validateIdentityMock: vi.fn(),
    credentialsPath: "",
    hostTokenTable: new Map() as HostTokenTable,
  };
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

// The REAL WsRpcClient dials a socket that is scripted as the host: it accepts every
// OPEN that carries a token, and answers each request by the same `answerHost` script
// the stub client used. A refusal that script throws is the host's fatal frame.
vi.mock("../../../../shared/host-transport/whatwg-ws-factory", () => ({
  createWhatwgWebSocketFactory: () => ({
    create: () => {
      const socket = new mocks.HostSocket();
      mocks.sockets.push(socket);
      setTimeout(() => socket.onopen?.({ type: "open" }), 0);
      return socket;
    },
  }),
}));

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
/** The first readiness ask comes this long after the give's budget starts: its dial hops through the scripted socket. */
const BUDGET_STARTS_BEFORE_FIRST_ASK_MS = 3;
/** The give's end, from its first readiness ask. */
const GIVE_ENDS_MS = GIVE_BUDGET_MS - BUDGET_STARTS_BEFORE_FIRST_ASK_MS;
/** A held mint's own fetch times out here. */
const MINT_TIMEOUT_MS = 10_000;
/** One readiness try's own budget: `min(2000, remaining)`. */
const TRY_BUDGET_MS = 2_000;
/** The good-side give's completion at 45829027 (mint answered 3 s after it is asked), measured with this fixture on that tree, from the first readiness ask. */
const BASE_GOOD_COMPLETION_MS = 18_057;
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

const teamBinding = {
  ...personalBinding,
  environment: {
    environmentId: TARGET_ENVIRONMENT_ID,
    ownerKind: "organization",
    ownerId: TEAM_ID,
    roomId: "room-team",
    label: "acme",
  },
  explicit: true,
};

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
  return environmentMovePlanResponseSchemaV20.parse({
    planHash: "a".repeat(64),
    planRevision: 3,
    hostVersion: "1.2.3",
    disclosureVersion: TEAM_TRANSFER_DISCLOSURE_VERSION,
    rows: {
      moves: [],
      staysOnThisComputer: [],
      alreadyInPersonal: [],
      differsMasked: [],
    },
    guideDiffers: false,
    personalHoldsSecrets: false,
  });
}

function moveStage() {
  return environmentMoveStageResponseSchema.parse({
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
      disclosureVersion: TEAM_TRANSFER_DISCLOSURE_VERSION,
    },
    authorization: { disclosureHash: "b".repeat(64) },
  });
}

function moveOutcome(state: "running" | "done") {
  return environmentMoveOutcomeAnswerSchema.parse({
    state,
    attemptId: ATTEMPT_ID,
    acceptanceId: ACCEPTANCE_ID,
  });
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
  readonly startedAtMs: number;
  abortedAtMs: number | null;
  reason: unknown;
}

let held: HeldMint[];
let abortTimeoutRequests: number[];
/** The fake time each readiness try asked the host for its status. */
let statusAskedAtMs: number[];
let refuseStatusFromMs: number | null;
/** When set, authn answers every host-only token mint `ok` after this many ms, instead of never. */
let mintAnswersAfterMs: number | null;
/** A mint was answered: the host then reports the team's binding. */
let mintAnswered: boolean;
let startedAtMs: number;
let credentialsRoot: string;

/**
 * A usable token is held for `tokenLifetimeSeconds`, so the first call needs no mint;
 * every mint authn is asked for after that is held and never answered.
 */
function stubAuthn(tokenLifetimeSeconds: number): void {
  mocks.hostTokenTable = new Map([
    [
      USER_ID,
      new Map([
        [
          HOST_ID,
          {
            token: "host-token-one",
            expiresAtMs: Date.now() + tokenLifetimeSeconds * 1000,
          },
        ],
      ]),
    ],
  ]);
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
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("the mint was sent with no abort signal");
      }
      const mint: HeldMint = {
        signal,
        startedAtMs: Date.now(),
        abortedAtMs: null,
        reason: undefined,
      };
      signal.addEventListener(
        "abort",
        () => {
          mint.abortedAtMs = Date.now();
          mint.reason = signal.reason;
        },
        { once: true },
      );
      held.push(mint);
      if (mintAnswersAfterMs !== null) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            mintAnswered = true;
            resolve(
              jsonResponse(200, {
                session_grant: "host-token-fresh",
                session_grant_expires_in: 3600,
              }),
            );
          }, mintAnswersAfterMs ?? 0);
        });
      }
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
        return moveOutcome("running");
      case "environment.status":
        statusAskedAtMs.push(Date.now());
        if (
          refuseStatusFromMs !== null &&
          Date.now() - startedAtMs >= refuseStatusFromMs
        ) {
          throw tokenRefusal();
        }
        return environmentStatusResponseSchemaV13.parse({
          principal: null,
          reachability: "connected",
          bindingGeneration: 1,
          desiredRevision: null,
          receivedRevision: null,
          appliedRevision: null,
          receiptAgeMs: 0,
          items: [],
          pendingUploads: [],
          setup: null,
          remoteAccess: "off",
          move: null,
        });
      case "environment.host.read":
        return mintAnswered ? teamBinding : personalBinding;
      case "environment.previewLocalFacts":
        return { activeTurns: 0, terminals: 0 };
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

/** The table is recorded after the first host call's mint, to compare with the end. */
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

/** A try that waited on a held mint would sit out its 10 s timeout between two asks. */
function expectNoTryAwaitedAMint(): void {
  expect(statusAskedAtMs.length).toBeGreaterThan(1);
  const gaps = statusAskedAtMs
    .slice(1)
    .map((at, index) => at - (statusAskedAtMs[index] ?? at));
  expect(Math.max(...gaps)).toBeLessThan(10_000);
}

/** Each of a try's two calls (status, binding) waits at most its own budget: two tries are never more than the poll's 2 s plus both budgets apart. */
function expectNoTryWaitedPastItsBudget(): void {
  const gaps = statusAskedAtMs
    .slice(1)
    .map((at, index) => at - (statusAskedAtMs[index] ?? at));
  expect(Math.max(...gaps)).toBeLessThanOrEqual(2_006 + 2 * TRY_BUDGET_MS + 10);
}

/** The give's budget runs from its first readiness ask; the scripted socket's own hops come before it. */
function pollStartMs(): number {
  const first = statusAskedAtMs[0];
  if (first === undefined) throw new Error("the give never asked the host");
  return first;
}

/** No held mint is in flight once the give has ended: each was aborted, and none after the give's end. */
function expectNoMintInFlightAfterTheGive(): void {
  for (const mint of held) {
    expect(mint.abortedAtMs).not.toBeNull();
    expect((mint.abortedAtMs ?? 0) - pollStartMs()).toBeLessThanOrEqual(
      GIVE_ENDS_MS,
    );
  }
}

/** Mints are one flight at a time: each starts strictly after the previous one ended, none overlaps it. */
function expectOneMintInFlightAtATime(): void {
  held.forEach((mint, index) => {
    const previous = held[index - 1];
    if (previous === undefined) return;
    expect(previous.abortedAtMs).not.toBeNull();
    expect(mint.startedAtMs).toBeGreaterThan(previous.abortedAtMs ?? 0);
  });
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
  statusAskedAtMs = [];
  refuseStatusFromMs = null;
  mintAnswersAfterMs = null;
  mintAnswered = false;
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
  it("starts one background mint at the first try after the token expires, and cancels it when the give ends", async () => {
    // The token expires 1 s before the budget does. The tries come 2006 ms apart
    // (the poll's 2 s and 6 ms of the scripted socket's hops), so the first try
    // after the expiry is the one at 44132 ms from the first ask.
    stubAuthn(44);

    const run = await runGive();

    expectTransferLine(run);
    expectNoTryAwaitedAMint();
    expect(run.endedAtMs - pollStartMs()).toBe(GIVE_ENDS_MS);
    // That try's dial reads the bearer and starts the one mint of the flight; the
    // ask at the same try joins it instead of starting a second.
    expect(held.map((mint) => mint.startedAtMs - pollStartMs())).toEqual([
      44_129,
    ]);
    // The give ends 868 ms later, long before its 10 s timeout, and cancels it.
    expect(held.map((mint) => (mint.abortedAtMs ?? 0) - pollStartMs())).toEqual(
      [GIVE_ENDS_MS],
    );
    expect(held[0].reason).toMatchObject({ name: "AbortError" });
    expectOneMintInFlightAtATime();
    expectNoMintInFlightAfterTheGive();
    expect(tokenTableSnapshot()).toBe(run.tokensAfterFirstCall);
  });

  it("holds one mint in flight at a time after the expiry, each started by the first try after the previous one's timeout, and no try waits longer than its own budget", async () => {
    // The token expires after 14 s. The first try after it, at 14042 ms, starts a
    // mint at its dial (14039). A try now waits up to its own budget (min(2 s,
    // what is left)) for the mint in flight, so the first try after a 10 s
    // timeout comes up to 2 s later than at 45829027 (12 s apart, not 10 s):
    // the next mint starts at 26042, then at 38045. A fourth would start after
    // the give's end.
    stubAuthn(14);

    const run = await runGive();

    expectTransferLine(run);
    expectNoTryAwaitedAMint();
    expectNoTryWaitedPastItsBudget();
    expect(run.endedAtMs - pollStartMs()).toBe(GIVE_ENDS_MS);
    expect(held.map((mint) => mint.startedAtMs - pollStartMs())).toEqual([
      14_039, 26_042, 38_045,
    ]);
    // The first two end at their own 10 s timeout; the last, before its own,
    // is cancelled by the give's end.
    expect(held.map((mint) => (mint.abortedAtMs ?? 0) - pollStartMs())).toEqual(
      [24_039, 36_042, GIVE_ENDS_MS],
    );
    expect(held.map((mint) => mint.reason)).toEqual([
      expect.objectContaining({ name: "TimeoutError" }),
      expect.objectContaining({ name: "TimeoutError" }),
      expect.objectContaining({ name: "AbortError" }),
    ]);
    expectOneMintInFlightAtATime();
    expectNoMintInFlightAfterTheGive();
    expect(tokenTableSnapshot()).toBe(run.tokensAfterFirstCall);
  });

  it("completes when the sign-in service answers the mint inside the window: no try waits past its budget, and it ends no later than the base's completion plus one try's budget", async () => {
    // The token expires after 14 s; authn answers the mint 3 s after it is asked.
    stubAuthn(14);
    mintAnswersAfterMs = 3_000;
    const ownership = (owner: object) => ({
      kind: "ok" as const,
      host: {
        hostId: HOST_ID,
        owner,
        kind: "personal" as const,
        remoteAccess: false,
      },
    });
    mocks.readHostOwnershipMock.mockReset();
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(ownership({ kind: "user", id: USER_ID }))
      .mockResolvedValue(
        ownership({ kind: "team", id: TEAM_ID, name: "Acme" }),
      );

    const run = await runGive();

    expect(run.outcome).toEqual({ status: "resolved" });
    expectNoTryAwaitedAMint();
    expect(held).toHaveLength(1);
    expect(run.endedAtMs - pollStartMs()).toBeLessThanOrEqual(
      BASE_GOOD_COMPLETION_MS + TRY_BUDGET_MS,
    );
  });

  it("cancels the recovery's fresh-token mint with the try when the host refuses the call near the deadline", async () => {
    // The host accepts the token at open and refuses the status call as expired
    // from 43.5 s. The first refused ask is the try at 44132 ms; its recovery asks
    // for a fresh token with no signal of its own, and authn never answers it.
    stubAuthn(120);
    refuseStatusFromMs = 43_500;

    const run = await runGive();

    expectTransferLine(run);
    expect(run.endedAtMs - pollStartMs()).toBe(GIVE_ENDS_MS);
    expect(held.map((mint) => mint.startedAtMs - pollStartMs())).toEqual([
      44_132,
    ]);
    // The give's end, 865 ms later, cancels it with the try.
    expect(held.map((mint) => (mint.abortedAtMs ?? 0) - pollStartMs())).toEqual(
      [GIVE_ENDS_MS],
    );
    expect(held[0].reason).toMatchObject({ name: "AbortError" });
    expectOneMintInFlightAtATime();
    expectNoMintInFlightAfterTheGive();
    expect(tokenTableSnapshot()).toBe(run.tokensAfterFirstCall);
  });
});
