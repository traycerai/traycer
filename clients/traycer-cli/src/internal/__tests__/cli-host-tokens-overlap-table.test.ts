import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutableBearerLease } from "../../../../shared/auth/bearer-source";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";
import type { HostTokenMintOutcome } from "../../../../shared/auth/host-token-source";
import {
  processReleasedHosts,
  type HostInstance,
} from "@traycer-clients/shared/host-transport/released-sign-on";
import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import type { CredentialsMutationStore } from "@traycer/protocol/config/credentials-mutation";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { Environment } from "../../runner/environment";
import {
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../../store/credentials-store";
import { createCliHostTokens, type CliHostTokens } from "../cli-host-tokens";
import type { SignInRotationResult } from "../../store/credentials-store";
import { completeCredentialsReserve } from "./credentials-reserve-test-support";

// Two overlapping mints, in either completion order, over the real token path
// (`createCliHostTokens`) and a real credentials file, against a scripted authn.
// The rule under test: a `sign-in-rejected` leaves `tracked.obtain` only if, at
// the moment it leaves, (1) it was sent with the sign-in that is the stored one
// now, and (2) no mint for that host process that started after it has bought a
// token. Any other refusal is not a refusal for anyone: it judges, records,
// refreshes and reports nothing, and what goes upward is the answer of an ask on
// the stored sign-in.

// A distinct user per case: process-wide judge state is keyed by user.
let userId = "user-1";
const SIGN_IN_A = "sign-in-a";
const SIBLING_SIGN_IN = "sign-in-sibling";
const OURS = "sign-in-ours";
const FIRST_PROCESS = "process-1";
const SECOND_PROCESS = "process-2";

interface MintRequest {
  readonly seq: number;
  readonly signIn: string;
  /** The host process observed when authn was sent the request. */
  readonly process: HostInstance;
  given: HostTokenMintOutcome | null;
  /** Whether the asker of this request still wants it when authn answers; the test ends it. */
  askerLive: boolean;
  /** The test sets this to have the model judge the refusal when it resumes, not when authn answers. */
  resumeLater: boolean;
  readonly answer: (outcome: HostTokenMintOutcome) => void;
}

/** What the test saw, in the order it happened. */
type Event =
  | {
      readonly kind: "left";
      /** The refusal's request, `null` for an outcome that is not a refusal. */
      readonly hostId: string;
      readonly refusalOf: MintRequest | null;
      readonly obeysRule: boolean;
      /** Whether a request sent with our rotation's sign-in had bought a token by then. */
      readonly boughtOnOurs: boolean;
      /** What `signInRejected()` said as the outcome left. */
      readonly judged: boolean;
    }
  | { readonly kind: "rotation-started"; readonly byTest: boolean }
  /** A rotation's answer, as `refreshSignIn` resumes with it. */
  | {
      readonly kind: "rotation-done";
      readonly installed: string | null;
      /** The sign-in authn or the store refused to rotate. */
      readonly refused: string | null;
    }
  /** Authn answered a request; the model reads what stood when it folds this. */
  | {
      readonly kind: "answered";
      readonly request: MintRequest;
      readonly outcomeKind: HostTokenMintOutcome["kind"];
      /** The stored sign-in when authn answered. */
      readonly storedThen: string;
      readonly askerLive: boolean;
    }
  /** A refusal's tracker resumed, after the adopting read it was held at. */
  | {
      readonly kind: "resumed";
      readonly request: MintRequest;
      readonly storedThen: string;
      readonly askerLive: boolean;
    };

const harness = vi.hoisted(() => ({
  requests: [] as MintRequest[],
  events: [] as Event[],
  table: new Map() as HostTokenTable,
  /** How many of the first requests are held; every later one is answered ok. */
  hold: 0,
  /** Requests sent with these sign-ins are refused at once, whatever else is held. */
  refuseSignIns: null as ReadonlySet<string> | null,
  /** When set, instead of `hold`: exactly the requests sent with these sign-ins are held. */
  holdOnly: null as ReadonlySet<string> | null,
  /** Set while the test itself refreshes the sign-in. */
  testRotating: false,
  /** Called whenever authn is sent a request. */
  onRequest: null as (() => void) | null,
  /** While set, a rotation the code under test starts waits here before authn answers it. */
  rotationGate: null as Promise<void> | null,
  /** Rotations waiting at the gate; they are the test's to release, not work in flight. */
  gated: 0,
  /** Called when a rotation reaches the gate. */
  onGate: null as (() => void) | null,
  /** While set, an adopting read of the credentials file waits here before it reads. */
  readGate: null as Promise<void> | null,
  /** Adopting reads that pass before the read gate takes effect. */
  readSkip: 0,
  /** The gate holds one read, then is gone. */
  readOnce: false,
  /** The next rotation the code under test starts waits here after it commits, before it resumes. */
  resumeGate: null as Promise<void> | null,
  /** The next read of the token file waits here. */
  loadGate: null as Promise<void> | null,
  /** The next write of the token file waits here before it lands. */
  writeGate: null as Promise<void> | null,
  /** Called as every outcome leaves the tracker, with what `signInRejected()` said then. */
  onLeave: null as ((judged: boolean) => void) | null,
  /** Asks that reached the token tracker; past a bound the tracker answers nothing more. */
  obtainCalls: 0,
  boundExceeded: false,
  storedSignIn: (): string => "",
  signInRejected: (): boolean => false,
}));

const credentialsFile = vi.hoisted(() => ({
  path: "",
  /** The sign-ins authn's refresh hands out, in the order asked. */
  refreshed: [] as string[],
}));

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
    refreshOnceAbortable: async (): Promise<{
      readonly kind: "refreshed";
      readonly token: string;
      readonly refreshToken: string;
    }> => {
      harness.events.push({
        kind: "rotation-started",
        byTest: harness.testRotating,
      });
      if (harness.rotationGate !== null && !harness.testRotating) {
        harness.gated += 1;
        harness.onGate?.();
        await harness.rotationGate;
        harness.gated -= 1;
      }
      const token = credentialsFile.refreshed.shift();
      if (token === undefined)
        throw new Error("authn was asked for a refresh no test expected");
      return { kind: "refreshed", token, refreshToken: `rt-${token}` };
    },
  };
});

vi.mock("@traycer-clients/shared/auth/host-token-file", () => ({
  createHostTokenFilePersistence: () => ({
    load: async () => {
      const gate = harness.loadGate;
      harness.loadGate = null;
      if (gate !== null) await gate;
      return harness.table;
    },
    update: async (change: (table: HostTokenTable) => HostTokenTable) => {
      const gate = harness.writeGate;
      harness.writeGate = null;
      if (gate !== null) await gate;
      harness.table = change(harness.table);
      return harness.table;
    },
  }),
}));

// Every outcome that leaves `tracked.obtain`, judged against the rule at the
// moment it leaves.
vi.mock("../../../../shared/auth/host-token-lease", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/host-token-lease")
    >();
  return {
    ...actual,
    trackHostTokenMints: (
      tokens: Parameters<typeof actual.trackHostTokenMints>[0],
      hosts: Parameters<typeof actual.trackHostTokenMints>[1],
    ) =>
      actual.trackHostTokenMints(
        {
          ...tokens,
          obtain: async (userId, hostId, fresh, ask) => {
            harness.obtainCalls += 1;
            // A loop that never ends is a failed bound, not a hung test.
            if (harness.obtainCalls > 40) {
              harness.boundExceeded = true;
              return {
                kind: "unavailable",
                detail: "the ask bound was exceeded",
              };
            }
            const outcome = await tokens.obtain(userId, hostId, fresh, ask);
            const refusalOf =
              outcome.kind === "sign-in-rejected"
                ? (harness.requests.find(
                    (request) => request.given === outcome,
                  ) ?? null)
                : null;
            const obeysRule =
              refusalOf === null ||
              (refusalOf.signIn === harness.storedSignIn() &&
                !harness.requests.some(
                  (later) =>
                    later.process === ask.owner &&
                    later.seq > refusalOf.seq &&
                    later.given?.kind === "ok",
                ));
            harness.events.push({
              kind: "left",
              hostId,
              refusalOf,
              obeysRule,
              boughtOnOurs: harness.requests.some(
                (request) =>
                  request.signIn === OURS && request.given?.kind === "ok",
              ),
              judged: harness.signInRejected(),
            });
            harness.onLeave?.(harness.signInRejected());
            return outcome;
          },
        },
        hosts,
      ),
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
      mintHostTokenViaHttp: (
        _authnBaseUrl: string,
        hostId: string,
        signIn: string,
      ): Promise<HostTokenMintOutcome> =>
        new Promise<HostTokenMintOutcome>((resolve) => {
          const seq = harness.requests.length;
          const request: MintRequest = {
            seq,
            signIn,
            process: processReleasedHosts.currentInstance(hostId),
            given: null,
            askerLive: true,
            resumeLater: false,
            answer: (outcome) => {
              request.given = outcome;
              harness.events.push({
                kind: "answered",
                request,
                outcomeKind: outcome.kind,
                storedThen: harness.storedSignIn(),
                askerLive: request.askerLive,
              });
              resolve(outcome);
            },
          };
          harness.requests.push(request);
          harness.onRequest?.();
          const held =
            harness.holdOnly !== null
              ? harness.holdOnly.has(signIn)
              : seq < harness.hold;
          if (harness.refuseSignIns?.has(signIn) === true)
            request.answer({ kind: "sign-in-rejected" });
          else if (!held)
            request.answer({
              kind: "ok",
              token: {
                token: `host-token-${seq}`,
                expiresAtMs: Date.now() + 3_600_000,
              },
            });
        }),
    };
  },
);

type Transition = "unchanged" | "rotated by us" | "replaced by a sibling";
type Answer = "a token" | "a 401";
type Order = "first mint first" | "second mint first";

interface Scenario {
  /** Two host ids share the one sign-in in one command, each with its own host process. */
  readonly hostIds: 1 | 2;
  /** Host processes of the first host id; always 1 for two host ids. */
  readonly hostProcesses: 1 | 2;
  readonly transition: Transition;
  readonly first: Answer;
  readonly second: Answer;
  readonly order: Order;
}

/**
 * With one host process and the sign-in unchanged, or replaced on disk without
 * this process having adopted it, the second mint joins the first's request:
 * there is one request, and only its answer exists.
 */
function sharesOneRequest(scenario: Scenario): boolean {
  return (
    scenario.hostIds === 1 &&
    scenario.hostProcesses === 1 &&
    scenario.transition !== "rotated by us"
  );
}

const ANSWERS: readonly Answer[] = ["a token", "a 401"];
const ORDERS: readonly Order[] = ["first mint first", "second mint first"];
const TRANSITIONS: readonly Transition[] = [
  "unchanged",
  "rotated by us",
  "replaced by a sibling",
];

const scenarios: Scenario[] = [];
for (const layout of [
  { hostIds: 1, hostProcesses: 1 },
  { hostIds: 1, hostProcesses: 2 },
  { hostIds: 2, hostProcesses: 1 },
] as const)
  for (const transition of TRANSITIONS)
    for (const first of ANSWERS)
      for (const second of ANSWERS)
        for (const order of ORDERS) {
          const scenario = { ...layout, transition, first, second, order };
          // One request, answered once: the second answer and the order mean nothing.
          if (
            sharesOneRequest(scenario) &&
            (second !== "a token" || order !== "first mint first")
          )
            continue;
          scenarios.push(scenario);
        }

const nameOf = (scenario: Scenario): string =>
  scenario.hostIds === 2
    ? `2 host ids, sign-in ${scenario.transition} between, first host's mint answered with ${scenario.first}, second host's with ${scenario.second}, ${scenario.order}`
    : sharesOneRequest(scenario)
      ? `${scenario.hostProcesses} host process, sign-in ${scenario.transition} between, one shared request answered with ${scenario.first}`
      : `${scenario.hostProcesses} host process${scenario.hostProcesses === 1 ? "" : "es"}, sign-in ${scenario.transition} between, first mint answered with ${scenario.first}, second with ${scenario.second}, ${scenario.order}`;

let hostCount = 0;
let hostId = "";
let otherHostId = "";
let workDir = "";

beforeEach(async () => {
  harness.requests.splice(0);
  harness.events.splice(0);
  harness.onRequest = null;
  harness.rotationGate = null;
  harness.readGate = null;
  harness.resumeGate = null;
  harness.writeGate = null;
  harness.loadGate = null;
  harness.onLeave = null;
  harness.obtainCalls = 0;
  harness.boundExceeded = false;
  harness.gated = 0;
  ioInFlight = 0;
  ioIdle = null;
  harness.table = new Map();
  harness.hold = 0;
  harness.holdOnly = null;
  harness.refuseSignIns = null;
  harness.readSkip = 0;
  harness.readOnce = false;
  harness.testRotating = false;
  hostCount += 1;
  userId = `user-${hostCount}`;
  hostId = `66666666-6666-4666-8666-${String(hostCount * 2).padStart(12, "0")}`;
  otherHostId = `66666666-6666-4666-8666-${String(hostCount * 2 + 1).padStart(12, "0")}`;
  processReleasedHosts.forgetAll();
  workDir = await mkdtemp(join(tmpdir(), "traycer-overlap-table-"));
  credentialsFile.path = join(workDir, "credentials");
  credentialsFile.refreshed.splice(0);
  harness.storedSignIn = (): string => {
    const stored: unknown = JSON.parse(
      readFileSync(credentialsFile.path, "utf8"),
    );
    if (
      typeof stored !== "object" ||
      stored === null ||
      !("token" in stored) ||
      typeof stored.token !== "string"
    )
      throw new Error("the credentials file holds no sign-in");
    return stored.token;
  };
});

afterEach(async () => {
  await quiet();
  for (const { tokens, store, otherProcess } of opened.splice(0)) {
    tokens.dispose();
    store.dispose();
    otherProcess.dispose();
  }
  processReleasedHosts.forgetAll();
  credentialsFile.path = "";
  await rm(workDir, { recursive: true, force: true });
});

const credentialsOf = (token: string): StoredCredentials => ({
  token,
  refreshToken: `rt-${token}`,
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: userId, email: "user@example.test", name: "User" },
});

// The credentials file work the code under test starts on its own (a rotation,
// an adopting read): counted from the moment it starts until it settles.
let ioInFlight = 0;
let ioIdle: (() => void) | null = null;

function counted<T>(operation: Promise<T>): Promise<T> {
  ioInFlight += 1;
  return operation.finally(() => {
    ioInFlight -= 1;
    if (ioInFlight === harness.gated) ioIdle?.();
  });
}

harness.onGate = (): void => {
  if (ioInFlight === harness.gated) ioIdle?.();
};

interface Gate {
  readonly gate: Promise<void>;
  readonly release: () => void;
}

function makeGate(): Gate {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/** Holds every rotation the code under test starts until the returned release. */
function holdRotations(): () => void {
  const held = makeGate();
  harness.rotationGate = held.gate;
  return () => {
    harness.rotationGate = null;
    held.release();
  };
}

/** Holds every adopting read of the credentials file until the returned release. */
function holdReads(): () => void {
  const held = makeGate();
  harness.readGate = held.gate;
  return () => {
    harness.readGate = null;
    held.release();
  };
}

/** Lets `skip` adopting reads pass, then holds the next one until the returned release. */
function holdOneReadAfter(skip: number): () => void {
  const held = makeGate();
  harness.readSkip = skip;
  harness.readOnce = true;
  harness.readGate = held.gate;
  return held.release;
}

/** Holds the next rotation after it commits, until the returned release. */
function holdNextRotationResume(): () => void {
  const held = makeGate();
  harness.resumeGate = held.gate;
  return held.release;
}

/** Waits at a gate the test releases: held work is not work in flight. */
async function atGate(gate: Promise<void> | null): Promise<void> {
  if (gate === null) return;
  harness.gated += 1;
  harness.onGate?.();
  await gate;
  harness.gated -= 1;
}

async function rotateThenResume(
  rotate: () => Promise<SignInRotationResult>,
): Promise<SignInRotationResult> {
  const resume = harness.resumeGate;
  harness.resumeGate = null;
  const result = await rotate();
  await atGate(resume);
  harness.events.push({
    kind: "rotation-done",
    installed: result.outcome === "rotated" ? result.installed : null,
    refused: result.outcome === "rejected" ? result.refused : null,
  });
  return result;
}

async function adoptAfterGate(adopt: () => Promise<void>): Promise<void> {
  if (harness.readSkip > 0) {
    harness.readSkip -= 1;
  } else {
    const gate = harness.readGate;
    if (harness.readOnce) {
      harness.readGate = null;
      harness.readOnce = false;
    }
    await atGate(gate);
  }
  await adopt();
}

/** Settles once a request sent with `signIn` is held for the test's answer. */
function untilHeldOn(signIn: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const check = (): void => {
      if (heldOn(signIn, "oldest") === undefined) return;
      harness.onRequest = null;
      resolve();
    };
    harness.onRequest = check;
    check();
  });
}

/** Settles once authn has been sent `count` requests. */
function untilRequests(count: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const check = (): void => {
      if (harness.requests.length < count) return;
      harness.onRequest = null;
      resolve();
    };
    harness.onRequest = check;
    check();
  });
}

/**
 * Settles once what an answer or a start set going has finished or waits only
 * on a request authn has not answered: no counted file work is under way, and
 * the continuations of everything already resolved have run (a macrotask runs
 * after every microtask).
 */
async function quiet(): Promise<void> {
  for (;;) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (ioInFlight === harness.gated) return;
    await new Promise<void>((resolve) => {
      ioIdle = resolve;
    });
  }
}

const REVOKED: FatalErrorDetails = {
  code: "UNAUTHORIZED",
  reason: "refused at the host door",
  incompatibleMethods: null,
  upgradeGuidance: null,
  doorReason: "session_revoked",
};

const TOKEN_EXPIRED: FatalErrorDetails = {
  code: "UNAUTHORIZED",
  reason: "refused at the host door",
  incompatibleMethods: null,
  upgradeGuidance: null,
  doorReason: "token_expired",
};

const answerOf = (answer: Answer, seq: number): HostTokenMintOutcome =>
  answer === "a token"
    ? {
        kind: "ok",
        token: {
          token: `host-token-held-${seq}`,
          expiresAtMs: Date.now() + 3_600_000,
        },
      }
    : { kind: "sign-in-rejected" };

/**
 * The round P model, from its page and not from the code under test: the sets
 * of sign-ins refused, rotated in and bought with only grow, and
 * `signInRejected()` is derived from them. Facts are folded in the order they
 * happened, each judged by what stands when the case's step has finished.
 */
class JudgeModel {
  readonly refused = new Set<string>();
  readonly rotatedIn = new Set<string>();
  readonly bought = new Set<string>();
  readonly refreshRefused = new Set<string>();
  private readonly mintedAt = new Map<HostInstance, number>();
  /** Each host process's latest counting refusal, until a counting token on the stored sign-in clears it. */
  private readonly held = new Map<HostInstance, string>();
  /** Rotations the model lets a counting, non-final refusal earn. */
  credits = 0;
  private folded = 0;
  private readonly lease: MutableBearerLease;

  constructor(lease: MutableBearerLease) {
    this.lease = lease;
  }

  private isFinal(signIn: string): boolean {
    return (
      this.refused.has(signIn) &&
      this.rotatedIn.has(signIn) &&
      !this.bought.has(signIn)
    );
  }

  fold(): void {
    for (; this.folded < harness.events.length; this.folded += 1) {
      const event = harness.events[this.folded];
      if (event?.kind === "rotation-done") {
        if (event.installed !== null) this.rotatedIn.add(event.installed);
        if (event.refused !== null) this.refreshRefused.add(event.refused);
      } else if (event?.kind === "answered") {
        const { request } = event;
        const current = processReleasedHosts.isCurrent(request.process);
        if (event.outcomeKind === "ok") {
          // authn's raw token answer prevents a final whoever is left to take
          // it; only a live asker of a current process writes the rest.
          this.bought.add(request.signIn);
          if (!current || !event.askerLive) continue;
          if (request.signIn === event.storedThen)
            this.held.delete(request.process);
          this.mintedAt.set(
            request.process,
            Math.max(this.mintedAt.get(request.process) ?? -1, request.seq),
          );
        } else if (
          event.outcomeKind === "sign-in-rejected" &&
          !request.resumeLater
        ) {
          this.refusal(request, event.storedThen, event.askerLive);
        }
      } else if (event?.kind === "resumed") {
        this.refusal(event.request, event.storedThen, event.askerLive);
      }
    }
  }

  /**
   * A refusal counts when it was sent with the stored sign-in, no later
   * request for its process bought a token, the process is current and its
   * asker is live; one that does not count writes nothing.
   */
  private refusal(
    request: MintRequest,
    storedThen: string,
    askerLive: boolean,
  ): void {
    const counts =
      request.signIn === storedThen &&
      (this.mintedAt.get(request.process) ?? -1) <= request.seq &&
      processReleasedHosts.isCurrent(request.process) &&
      askerLive;
    if (!counts) return;
    this.refused.add(request.signIn);
    this.held.set(request.process, request.signIn);
    if (!this.isFinal(request.signIn)) this.credits += 1;
  }

  /**
   * What a session revocation's recovery for `process` earns with no refusal
   * of its own in hand: a rotation when it holds none or one of the stored
   * sign-in, none when it holds one of another sign-in (adopted).
   */
  revocationEarns(process: HostInstance): number {
    this.fold();
    const held = this.held.get(process);
    return held === undefined || held === this.lease.getBearerToken() ? 1 : 0;
  }

  rejected(): boolean {
    this.fold();
    const signIn = this.lease.getBearerToken();
    return this.refreshRefused.has(signIn) || this.isFinal(signIn);
  }
}

const nonTestRotations = (): number =>
  harness.events.filter(
    (event) => event.kind === "rotation-started" && !event.byTest,
  ).length;

/** The model's claims after a step, each named by the step. */
function checkModel(open: OpenTokens, step: string): void {
  expect(open.mismatches, `${step}: signInRejected() as outcomes left`).toEqual(
    [],
  );
  const expected = open.model.rejected();
  expect(open.tokens.signInRejected(), `${step}: signInRejected()`).toBe(
    expected,
  );
  expect(
    nonTestRotations(),
    `${step}: rotations started beyond those a counting, non-final refusal earns`,
  ).toBeLessThanOrEqual(open.model.credits + open.limits.allowance);
  expect(harness.boundExceeded, `${step}: the ask bound`).toBe(false);
  expect(harness.obtainCalls, `${step}: asks`).toBeLessThanOrEqual(
    open.limits.calls,
  );
}

/** One step of a case: the action, then the model's claims once everything it set going has settled. */
async function step(
  open: OpenTokens,
  name: string,
  action: () => Promise<unknown>,
): Promise<void> {
  await action();
  await quiet();
  checkModel(open, name);
}

const answerRequest = (
  request: MintRequest | undefined,
  answer: Answer,
): void => {
  if (request === undefined) throw new Error("the mint sent no request");
  request.answer(answerOf(answer, request.seq));
};

function startAsk(open: OpenTokens, host: string): void {
  open.pending.push(open.tokens.mintFresh(host, null));
}

/**
 * One command's tokens over a real credentials file holding sign-in A, with a
 * second handle on the same file (another process's save). Authn's refresh
 * hands out our rotation's sign-in first, then a run of recovery ones.
 */
interface OpenTokens {
  readonly store: CredentialsMutationStore;
  readonly otherProcess: CredentialsMutationStore;
  readonly lease: MutableBearerLease;
  readonly tokens: CliHostTokens;
  readonly reports: string[];
  readonly model: JudgeModel;
  /** Where `signInRejected()` differed from the model as an outcome left the tracker. */
  readonly mismatches: string[];
  /** Every ask the case started; awaited when it ends. */
  readonly pending: Promise<unknown>[];
  /** What the model allows beyond the rotations counting refusals earn. */
  readonly limits: { allowance: number; calls: number };
}

const opened: OpenTokens[] = [];

async function openTokens(): Promise<OpenTokens> {
  const open = await openTokensLoading();
  await open.tokens.whenLoaded();
  return open;
}

/** As `openTokens`, without waiting for the stored tokens to be read. */
async function openTokensLoading(): Promise<OpenTokens> {
  // A full reserve is never refilled under the lock: no store's background
  // fill takes it, or writes into the directory, while the case runs.
  await completeCredentialsReserve(credentialsFile.path);
  const store = createCliCredentialsStore();
  const otherProcess = createCliCredentialsStore();
  await store.signIn(credentialsOf(SIGN_IN_A), false, null);
  credentialsFile.refreshed.push(
    OURS,
    "sign-in-recovery-1",
    "sign-in-recovery-2",
    "sign-in-recovery-3",
    "sign-in-recovery-4",
    "sign-in-recovery-5",
    "sign-in-recovery-6",
  );
  const lease = new MutableBearerLease(SIGN_IN_A, userId);
  const revalidator = createStoreBackedRevalidator({
    store,
    lease,
    signal: null,
  });
  const tokens = createCliHostTokens({
    lease,
    refresh: () => counted(rotateThenResume(() => revalidator.rotateSignIn())),
    adoptStored: () =>
      counted(adoptAfterGate(() => revalidator.adoptStoredSignIn())),
    signal: null,
  });
  harness.signInRejected = () => tokens.signInRejected();
  const reports: string[] = [];
  tokens.onRefusalEndingCommand((reportedHostId) => {
    reports.push(reportedHostId);
  });
  const model = new JudgeModel(lease);
  const mismatches: string[] = [];
  harness.onLeave = (judged) => {
    const expected = model.rejected();
    if (judged !== expected)
      mismatches.push(
        `as an outcome left: signInRejected() was ${judged}, the model says ${expected}`,
      );
  };
  const open: OpenTokens = {
    store,
    otherProcess,
    lease,
    tokens,
    reports,
    model,
    mismatches,
    pending: [],
    limits: { allowance: 0, calls: 8 },
  };
  opened.push(open);
  return open;
}

const rotationsStarted = (): number =>
  harness.events.filter((event) => event.kind === "rotation-started").length;

describe.each(scenarios)(
  "two overlapping mints: $hostIds host id(s), $hostProcesses host process(es), sign-in $transition",
  (scenario) => {
    it(nameOf(scenario), async () => {
      const { otherProcess, lease, tokens, reports } = await openTokens();
      processReleasedHosts.observeInstance(hostId, FIRST_PROCESS);
      if (scenario.hostIds === 2)
        processReleasedHosts.observeInstance(otherHostId, FIRST_PROCESS);
      const requestsExpected = sharesOneRequest(scenario) ? 1 : 2;
      harness.hold = requestsExpected;

      // The first mint starts and is held.
      const first = tokens.mintFresh(hostId, null);
      await untilRequests(1);

      // What happens to the sign-in, or to the host process, between them.
      if (scenario.transition === "rotated by us") {
        harness.testRotating = true;
        await expect(tokens.refreshSignIn()).resolves.toBe("rotated");
        harness.testRotating = false;
      }
      if (scenario.transition === "replaced by a sibling")
        await otherProcess.signIn(credentialsOf(SIBLING_SIGN_IN), false, null);
      if (scenario.hostProcesses === 2)
        processReleasedHosts.observeInstance(hostId, SECOND_PROCESS);

      // The second mint starts after it, and is held when it is a request of its own.
      const second = tokens.mintFresh(
        scenario.hostIds === 2 ? otherHostId : hostId,
        null,
      );
      await untilRequests(requestsExpected);
      await quiet();

      // Authn answers, in the order the case names.
      const firstRequest = harness.requests[0];
      const secondRequest = harness.requests[1] ?? firstRequest;
      if (firstRequest === undefined || secondRequest === undefined)
        throw new Error("the mints sent no request");
      if (sharesOneRequest(scenario)) {
        firstRequest.answer(answerOf(scenario.first, 0));
        await quiet();
      } else if (scenario.order === "first mint first") {
        firstRequest.answer(answerOf(scenario.first, 0));
        await quiet();
        secondRequest.answer(answerOf(scenario.second, 1));
        await quiet();
      } else {
        secondRequest.answer(answerOf(scenario.second, 1));
        await quiet();
        firstRequest.answer(answerOf(scenario.first, 0));
        await quiet();
      }
      await Promise.all([first, second]);

      const left = harness.events.flatMap((event) =>
        event.kind === "left" && event.refusalOf !== null ? [event] : [],
      );
      // (1) Every refusal that left `obtain` obeys the rule.
      expect(
        left
          .filter((event) => !event.obeysRule)
          .map((event) => event.refusalOf?.signIn),
      ).toEqual([]);
      // (2) The sign-in is judged rejected only by a refusal of the one our own
      // rotation installed, while it is still the stored one.
      const judgedByTheRule =
        scenario.transition === "rotated by us" &&
        harness.storedSignIn() === OURS &&
        left.some((event) => event.refusalOf?.signIn === OURS);
      expect({
        rejected: tokens.signInRejected(),
        permitted: judgedByTheRule,
      }).not.toEqual({ rejected: true, permitted: false });
      // (3) No rotation starts for a refusal the rule excludes: each rotation
      // the test did not start follows a refusal that obeys it.
      const rotationsWithoutRefusal = harness.events.flatMap((event, index) => {
        if (event.kind !== "rotation-started" || event.byTest) return [];
        const before = harness.events
          .slice(0, index)
          .reverse()
          .find(
            (earlier) => earlier.kind === "left" && earlier.refusalOf !== null,
          );
        return before !== undefined &&
          before.kind === "left" &&
          before.obeysRule
          ? []
          : [index];
      });
      expect(rotationsWithoutRefusal).toEqual([]);
      // (4) A refusal of the sign-in our own rotation installed, while it is
      // still stored and before any token was bought on it, is judged as it
      // leaves, whatever another mint did meanwhile.
      expect(
        left.filter(
          (event) =>
            event.refusalOf?.signIn === OURS &&
            event.obeysRule &&
            !event.boughtOnOurs &&
            !event.judged,
        ),
      ).toEqual([]);
      // (4b) The judgement stands when a token sent with an earlier sign-in
      // arrives after it, until a rotation starts: such a token is no mint on
      // the installed sign-in.
      let standing = false;
      const clearedByOlderToken: Event[] = [];
      for (const event of harness.events) {
        if (event.kind === "rotation-started") standing = false;
        else if (event.kind !== "left") continue;
        else if (event.refusalOf !== null) {
          if (
            event.refusalOf.signIn === OURS &&
            event.obeysRule &&
            event.judged
          )
            standing = true;
        } else if (standing && !event.boughtOnOurs && !event.judged)
          clearedByOlderToken.push(event);
      }
      expect(clearedByOlderToken).toEqual([]);
      if (scenario.hostIds === 2) {
        // (5) The second host's session is then revoked. The refusal its
        // recovery reads is that host's own latest mint outcome, when that is
        // a refusal; the first host's never steers it. With none of its own,
        // it refreshes the stored sign-in (the store adopts a newer file
        // instead of spending); and it reports nothing.
        const ownLatest = harness.events
          .filter(
            (event) => event.kind === "left" && event.hostId === otherHostId,
          )
          .at(-1);
        const holdsOwnRefusal =
          ownLatest?.kind === "left" && ownLatest.refusalOf !== null;
        const leaseBehindFile =
          lease.getBearerToken() !== harness.storedSignIn();
        const rotationsBefore = rotationsStarted();
        const reportsBefore = reports.length;
        await tokens
          .streamRecovery(otherHostId)
          .revalidateRefused(REVOKED, () => true);
        expect({
          rotations: holdsOwnRefusal
            ? "its own refusal's"
            : rotationsStarted() - rotationsBefore,
          reports: reports.length - reportsBefore,
        }).toEqual({
          rotations: holdsOwnRefusal
            ? "its own refusal's"
            : leaseBehindFile
              ? 0
              : 1,
          reports: 0,
        });
      }
    });
  },
);

describe("a revoked session's recovery reads the host's own latest mint outcome", () => {
  it("one host: a refusal on A, a rotation, a token bought on B, then a revoked session: the recovery refreshes", async () => {
    const { tokens } = await openTokens();
    processReleasedHosts.observeInstance(hostId, FIRST_PROCESS);
    harness.hold = 1;
    const minting = tokens.mintFresh(hostId, null);
    await untilRequests(1);
    // A is refused; the recovery rotates to B and buys a token on it.
    harness.requests[0]?.answer({ kind: "sign-in-rejected" });
    await expect(minting).resolves.toMatchObject({ kind: "ok" });
    expect(harness.requests.map((request) => request.signIn)).toEqual([
      SIGN_IN_A,
      OURS,
    ]);
    const rotationsBefore = rotationsStarted();

    await tokens.streamRecovery(hostId).revalidateRefused(REVOKED, () => true);

    expect(rotationsStarted() - rotationsBefore).toBe(1);
  });
});

type Layout = "one process" | "a replaced process" | "two host ids";
type Landing = "token before the refusal" | "refusal before the token";
type TokenFrom = "the first mint" | "the second mint";

interface InstalledCase {
  readonly layout: Layout;
  readonly landing: Landing;
  readonly tokenFrom: TokenFrom;
}

// After our rotation A to B, two mints are sent with B: one answered with a
// token, one refused. With one process the second is asked once the first has
// left, as a mint for one process shares its request while it is out. With a
// replaced process or two host ids both are out at once and answered in either
// order; a refusal answered first cannot be followed by a token that is
// answered before its recovery rotates, one process having one request.
const installedCases: InstalledCase[] = [
  {
    layout: "one process",
    landing: "token before the refusal",
    tokenFrom: "the first mint",
  },
];
for (const layout of ["a replaced process", "two host ids"] as const)
  for (const landing of [
    "token before the refusal",
    "refusal before the token",
  ] as const)
    for (const tokenFrom of ["the first mint", "the second mint"] as const)
      installedCases.push({ layout, landing, tokenFrom });

describe.each(installedCases)(
  "a token on the installed sign-in: $layout",
  (scenario) => {
    it(`${scenario.layout}: ${scenario.landing}, the token from ${scenario.tokenFrom}`, async () => {
      const open = await prepare(scenario.layout, [OURS]);
      await step(open, "our rotation installs B", () => rotateByTest(open));
      if (scenario.layout === "one process") {
        // One process has one request per sign-in: the second mint is asked
        // once the first has left.
        await step(open, "a mint is sent with B", async () => {
          startAsk(open, hostId);
          await untilHeldOn(OURS);
        });
        await step(open, "its token on B", async () => {
          answerRequest(heldOn(OURS, "oldest"), "a token");
        });
        await step(open, "a second mint is sent with B", async () => {
          startAsk(open, hostId);
          await untilHeldOn(OURS);
        });
        await step(open, "it is refused", async () => {
          answerRequest(heldOn(OURS, "oldest"), "a 401");
        });
      } else {
        await step(open, "the first mint is sent with B", async () => {
          startAsk(open, hostId);
          await untilRequests(1);
        });
        await step(open, "the second mint is sent with B", async () => {
          if (scenario.layout === "a replaced process")
            processReleasedHosts.observeInstance(hostId, SECOND_PROCESS);
          startAsk(open, secondHostOf(scenario.layout));
          await untilRequests(2);
        });
        const first = harness.requests[0];
        const second = harness.requests[1];
        const tokenRequest =
          scenario.tokenFrom === "the first mint" ? first : second;
        const refusalRequest =
          scenario.tokenFrom === "the first mint" ? second : first;
        const token = (): Promise<void> =>
          step(open, "the token on B lands", async () => {
            answerRequest(tokenRequest, "a token");
          });
        const refusal = (): Promise<void> =>
          step(open, "the refusal of B lands", async () => {
            answerRequest(refusalRequest, "a 401");
          });
        if (scenario.landing === "token before the refusal") {
          await token();
          await refusal();
        } else {
          await refusal();
          await token();
        }
      }
      await finish(open);
    });
  },
);

// ---- the round P model: each case asserts it after every step ----

const LAYOUTS: readonly Layout[] = [
  "one process",
  "a replaced process",
  "two host ids",
];

/** Opens a case in which exactly the requests sent with `held` sign-ins wait for the test's answer. */
async function prepare(
  layout: Layout,
  held: readonly string[],
): Promise<OpenTokens> {
  const open = await openTokens();
  processReleasedHosts.observeInstance(hostId, FIRST_PROCESS);
  if (layout === "two host ids")
    processReleasedHosts.observeInstance(otherHostId, FIRST_PROCESS);
  harness.holdOnly = new Set(held);
  return open;
}

const secondHostOf = (layout: Layout): string =>
  layout === "two host ids" ? otherHostId : hostId;

async function rotateByTest(open: OpenTokens): Promise<void> {
  harness.testRotating = true;
  try {
    await expect(open.tokens.refreshSignIn()).resolves.toBe("rotated");
  } finally {
    harness.testRotating = false;
  }
}

/** The oldest or newest request sent with `signIn` that authn has not answered. */
function heldOn(
  signIn: string,
  which: "oldest" | "newest",
): MintRequest | undefined {
  const held = harness.requests.filter(
    (request) => request.given === null && request.signIn === signIn,
  );
  return which === "oldest" ? held[0] : held.at(-1);
}

/** Ends the case: whatever authn still holds is answered with a token, and every ask has finished. */
async function finish(open: OpenTokens): Promise<void> {
  harness.holdOnly = new Set();
  for (const request of harness.requests)
    if (request.given === null) answerRequest(request, "a token");
  await Promise.all(open.pending);
}

describe.each(LAYOUTS)(
  "model O2: a judged refusal, a lock-free adoption of a sibling's sign-in, then its first refusal: %s",
  (layout) => {
    it("judges B final, un-judges on adopting C, and earns one recovery for C's first refusal", async () => {
      const open = await prepare(layout, [OURS, SIBLING_SIGN_IN]);
      // The first refusal of B rotates today though it is final: that fault
      // is the final cases' subject, so it is allowed here and what follows
      // is judged on its own.
      open.limits.allowance = 1;
      await step(open, "our rotation installs B", () => rotateByTest(open));
      await step(open, "a mint is sent with B", async () => {
        startAsk(open, hostId);
        await untilRequests(1);
      });
      await step(
        open,
        "B is refused: the first mint after our rotation",
        async () => {
          answerRequest(heldOn(OURS, "oldest"), "a 401");
        },
      );
      await step(
        open,
        "a sibling saves C and the lease adopts it",
        async () => {
          await open.otherProcess.signIn(
            credentialsOf(SIBLING_SIGN_IN),
            false,
            null,
          );
          await open.tokens.adoptStoredSignIn();
        },
      );
      await step(open, "a mint is sent with C", async () => {
        if (layout === "a replaced process")
          processReleasedHosts.observeInstance(hostId, SECOND_PROCESS);
        startAsk(open, secondHostOf(layout));
        await vi.waitFor(() =>
          expect(heldOn(SIBLING_SIGN_IN, "oldest")).toBeDefined(),
        );
      });
      await step(
        open,
        "C is refused: its first refusal, which is not final",
        async () => {
          answerRequest(heldOn(SIBLING_SIGN_IN, "oldest"), "a 401");
        },
      );
      await finish(open);
    });
  },
);

describe.each(LAYOUTS)(
  "model final: a direct caller's counting first refusal: %s",
  (layout) => {
    it("of the sign-in our rotation installed, with nobody having bought on it: final, no rotation", async () => {
      const open = await prepare(layout, [OURS]);
      if (layout === "a replaced process")
        processReleasedHosts.observeInstance(hostId, SECOND_PROCESS);
      await step(open, "our rotation installs B", () => rotateByTest(open));
      await step(open, "a mint is sent with B", async () => {
        startAsk(open, secondHostOf(layout));
        await untilRequests(1);
      });
      await step(open, "B is refused", async () => {
        answerRequest(heldOn(OURS, "oldest"), "a 401");
      });
      expect(nonTestRotations()).toBe(0);
      await finish(open);
    });

    it("of a sibling's sign-in: not final, one rotation", async () => {
      const open = await prepare(layout, [SIBLING_SIGN_IN]);
      if (layout === "a replaced process")
        processReleasedHosts.observeInstance(hostId, SECOND_PROCESS);
      await step(
        open,
        "a sibling saves C and the lease adopts it",
        async () => {
          await open.otherProcess.signIn(
            credentialsOf(SIBLING_SIGN_IN),
            false,
            null,
          );
          await open.tokens.adoptStoredSignIn();
        },
      );
      await step(open, "a mint is sent with C", async () => {
        startAsk(open, secondHostOf(layout));
        await untilRequests(1);
      });
      await step(open, "C is refused", async () => {
        answerRequest(heldOn(SIBLING_SIGN_IN, "oldest"), "a 401");
      });
      expect(nonTestRotations()).toBe(1);
      await finish(open);
    });
  },
);

describe.each(["a replaced process", "two host ids"] as const)(
  "model O3: the owner replaced while its mint is out: %s",
  (layout) => {
    const sendBoth = async (open: OpenTokens): Promise<void> => {
      await step(open, "our rotation installs B", () => rotateByTest(open));
      await step(open, "the mints are sent with B", async () => {
        startAsk(open, hostId);
        await untilRequests(1);
        if (layout === "two host ids") {
          startAsk(open, otherHostId);
          await untilRequests(2);
        }
      });
    };
    const otherHostRefused = async (open: OpenTokens): Promise<void> => {
      if (layout === "two host ids")
        await step(open, "the other host's mint is refused on B", async () => {
          answerRequest(heldOn(OURS, "newest"), "a 401");
        });
    };

    it("its refusal arrives after the replacement: it counts for nobody", async () => {
      const open = await prepare(layout, [OURS]);
      await sendBoth(open);
      await step(open, "the host process is replaced", async () => {
        processReleasedHosts.observeInstance(hostId, SECOND_PROCESS);
      });
      await step(
        open,
        "the replaced process's mint is refused on B",
        async () => {
          answerRequest(heldOn(OURS, "oldest"), "a 401");
        },
      );
      await otherHostRefused(open);
      await finish(open);
    });

    it("the replacement lands while the adopting read for its refusal is held", async () => {
      const open = await prepare(layout, [OURS]);
      await sendBoth(open);
      await step(
        open,
        "the refusal is read while the process is replaced",
        async () => {
          const release = holdReads();
          answerRequest(heldOn(OURS, "oldest"), "a 401");
          await quiet();
          processReleasedHosts.observeInstance(hostId, SECOND_PROCESS);
          release();
        },
      );
      await otherHostRefused(open);
      await finish(open);
    });
  },
);

describe.each(["one process", "two host ids"] as const)(
  "model gap 1, the publication window: %s",
  (layout) => {
    it.each([
      "the refusal resumes first",
      "the rotation resumes first",
    ] as const)(
      "our rotation is committed and adopted lock-free, B is refused before its result lands: %s",
      async (order) => {
        const open = await prepare(layout, [OURS]);
        // A first refusal of B rotates today though it is final: that is the
        // final cases' subject, not this window's.
        open.limits.allowance = 1;
        let release: () => void = () => undefined;
        await step(
          open,
          "our rotation commits and waits to resume",
          async () => {
            release = holdNextRotationResume();
            harness.testRotating = true;
            open.pending.push(open.tokens.refreshSignIn());
            await quiet();
            harness.testRotating = false;
          },
        );
        await step(open, "a lock-free adoption publishes B", () =>
          open.tokens.adoptStoredSignIn(),
        );
        await step(open, "a mint is sent with B", async () => {
          startAsk(open, secondHostOf(layout));
          await untilRequests(1);
        });
        const refuse = (): Promise<void> =>
          step(open, "B is refused", async () => {
            answerRequest(heldOn(OURS, "oldest"), "a 401");
          });
        const resume = (): Promise<void> =>
          step(open, "our rotation's result lands", async () => {
            release();
          });
        if (order === "the refusal resumes first") {
          await refuse();
          await resume();
        } else {
          await resume();
          await refuse();
        }
        await finish(open);
      },
    );
  },
);

describe.each([
  "token before the refusal",
  "refusal before the token",
] as const)(
  "model gap 4: a retired process's unkept raw token on B and the replacement's refusal of B: %s",
  (landing) => {
    it("the raw token is bought whoever remains, and writes nothing strict", async () => {
      const open = await prepare("a replaced process", [OURS]);
      // A first refusal of B rotates today though it is final: that is the
      // final cases' subject; here the judgement is read as it stands.
      open.limits.allowance = 1;
      await step(open, "our rotation installs B", () => rotateByTest(open));
      await step(open, "the first process's mint is sent with B", async () => {
        startAsk(open, hostId);
        await untilRequests(1);
      });
      await step(
        open,
        "the host process is replaced and its mint is sent with B",
        async () => {
          processReleasedHosts.observeInstance(hostId, SECOND_PROCESS);
          startAsk(open, hostId);
          await untilRequests(2);
        },
      );
      const token = (): Promise<void> =>
        step(open, "the retired process's token on B lands", async () => {
          answerRequest(harness.requests[0], "a token");
        });
      const refusal = (): Promise<void> =>
        step(open, "the replacement's mint is refused on B", async () => {
          answerRequest(harness.requests[1], "a 401");
        });
      if (landing === "token before the refusal") {
        await token();
        await refusal();
      } else {
        await refusal();
        await token();
      }
      await finish(open);
    });
  },
);

describe("model: authn's raw token answer is published before the token file is written", () => {
  it("two mints on B, X's token-file write held: Y's refusal of B, judged during the hold, is not final", async () => {
    const open = await prepare("two host ids", [OURS]);
    await step(open, "our rotation installs B", () => rotateByTest(open));
    await step(open, "both hosts' mints are sent with B", async () => {
      startAsk(open, hostId);
      await untilRequests(1);
      startAsk(open, otherHostId);
      await untilRequests(2);
    });
    const writeHold = makeGate();
    await step(
      open,
      "X's token on B is answered and its write is held",
      async () => {
        harness.writeGate = writeHold.gate;
        answerRequest(harness.requests[0], "a token");
      },
    );
    await step(open, "Y's refusal of B arrives during the hold", async () => {
      answerRequest(harness.requests[1], "a 401");
    });
    harness.writeGate = null;
    writeHold.release();
    await finish(open);
  });
});

describe("model: an ended asker's raw token answer", () => {
  it("is bought without any strict write: the other host's refusal of B is not final", async () => {
    const open = await prepare("two host ids", [OURS]);
    await step(open, "our rotation installs B", () => rotateByTest(open));
    const asker = new AbortController();
    await step(open, "both hosts' mints are sent with B", async () => {
      open.pending.push(open.tokens.mintFresh(hostId, asker.signal));
      await untilRequests(1);
      startAsk(open, otherHostId);
      await untilRequests(2);
    });
    await step(
      open,
      "X's asker ends and authn answers its mint with a token",
      async () => {
        asker.abort();
        const request = harness.requests[0];
        if (request !== undefined) request.askerLive = false;
        answerRequest(request, "a token");
      },
    );
    await step(open, "Y's refusal of B arrives", async () => {
      answerRequest(harness.requests[1], "a 401");
    });
    await finish(open);
  });
});

describe("model O4: an excluded refusal whose asker ends while a newer counting refusal is held", () => {
  it("writes nothing: the held refusal still decides the session revocation's recovery", async () => {
    const open = await prepare("one process", [SIGN_IN_A, OURS]);
    // The first refusal of B rotates today though it is final: that is the
    // final cases' subject, not this case's.
    open.limits.allowance = 1;
    const asker = new AbortController();
    await step(
      open,
      "a mint is sent with A and its asker may end",
      async () => {
        open.pending.push(open.tokens.mintFresh(hostId, asker.signal));
        await untilRequests(1);
      },
    );
    await step(open, "our rotation installs B", () => rotateByTest(open));
    await step(open, "a mint is sent with B", async () => {
      startAsk(open, hostId);
      await untilRequests(2);
    });
    await step(
      open,
      "B is refused: counting, held for the process",
      async () => {
        answerRequest(heldOn(OURS, "oldest"), "a 401");
      },
    );
    await step(open, "the first mint's asker ends", async () => {
      asker.abort();
    });
    await step(
      open,
      "the first mint's refusal of A arrives: excluded, asker gone",
      async () => {
        answerRequest(heldOn(SIGN_IN_A, "oldest"), "a 401");
      },
    );
    await step(open, "a sibling saves C and the lease adopts it", async () => {
      await open.otherProcess.signIn(
        credentialsOf(SIBLING_SIGN_IN),
        false,
        null,
      );
      await open.tokens.adoptStoredSignIn();
    });
    // The process holds a refusal of B and the lease holds C: its recovery
    // is adopted, and rotates nothing.
    const earns = open.model.revocationEarns(
      processReleasedHosts.currentInstance(hostId),
    );
    const before = nonTestRotations();
    await step(open, "the session is revoked", async () => {
      open.limits.allowance += earns;
      await open.tokens
        .streamRecovery(hostId)
        .revalidateRefused(REVOKED, () => true);
    });
    expect(nonTestRotations() - before).toBe(earns);
    await finish(open);
  });
});

describe("model: the lease's spent branch", () => {
  it("answers transient and reports nothing when another host bought on B and the retry's refusal of B counts", async () => {
    const open = await prepare("two host ids", [SIGN_IN_A, OURS]);
    let recovery: Promise<string> = Promise.resolve("");
    await step(
      open,
      "Y's door refusal starts its recovery: a mint on A",
      async () => {
        recovery = open.tokens
          .streamRecovery(otherHostId)
          .revalidateRefused(TOKEN_EXPIRED, () => true);
        open.pending.push(recovery);
        await untilRequests(1);
      },
    );
    await step(
      open,
      "A is refused: the recovery rotates to B and retries on it",
      async () => {
        answerRequest(heldOn(SIGN_IN_A, "oldest"), "a 401");
        await untilRequests(2);
      },
    );
    await step(open, "another host buys a token on B", async () => {
      startAsk(open, hostId);
      await untilRequests(3);
      answerRequest(heldOn(OURS, "newest"), "a token");
    });
    await step(
      open,
      "the retry's refusal of B arrives: it counts, and B is not final",
      async () => {
        answerRequest(heldOn(OURS, "oldest"), "a 401");
      },
    );
    await expect(recovery).resolves.toBe("network-error");
    expect(open.reports).toEqual([]);
    await finish(open);
  });
});

describe("model: the refusals of a refresh with no authn behind them", () => {
  it("a deleted credentials file: the refresh is refused for the sign-in it was asked to rotate", async () => {
    const open = await prepare("one process", []);
    await step(
      open,
      "the credentials file is deleted and a refresh is asked",
      async () => {
        await rm(credentialsFile.path);
        await open.tokens.refreshSignIn();
      },
    );
    await finish(open);
  });

  it("another user's sign-in in the credentials file: the refresh is refused for the sign-in it was asked to rotate", async () => {
    const open = await prepare("one process", []);
    await step(
      open,
      "another user signs in on the file and a refresh is asked",
      async () => {
        await open.otherProcess.signIn(
          {
            ...credentialsOf(SIBLING_SIGN_IN),
            user: {
              id: "someone-else",
              email: "else@example.test",
              name: "Else",
            },
          },
          false,
          null,
        );
        await open.tokens.refreshSignIn();
      },
    );
    await finish(open);
  });
});

describe("model J: nothing starts for an ended owner", () => {
  it("a mint whose token session ends during the read of the stored tokens sends no request, though its asker's signal is live", async () => {
    const loadHold = makeGate();
    harness.loadGate = loadHold.gate;
    const open = await openTokensLoading();
    processReleasedHosts.observeInstance(hostId, FIRST_PROCESS);
    harness.holdOnly = new Set();
    const asker = new AbortController();
    open.pending.push(open.tokens.mintFresh(hostId, asker.signal));
    await quiet();
    open.tokens.dispose();
    loadHold.release();
    await Promise.all(open.pending);
    expect(harness.requests).toHaveLength(0);
  });
});

describe("model H: P to Q re-owning through the lease's recovery", () => {
  it("P's revalidator acts on nothing, and the recovery-call count stays within the bound", async () => {
    const open = await prepare("one process", [SIGN_IN_A]);
    harness.refuseSignIns = new Set([SIBLING_SIGN_IN]);
    // The recovery of A's refusal finds no refresh to take: authn is not asked
    // again for it, so P is left holding its refusal of A.
    credentialsFile.refreshed.splice(0);
    await step(open, "P's mint is sent with A", async () => {
      startAsk(open, hostId);
      await untilRequests(1);
    });
    await step(open, "A is refused: counting, held for P", async () => {
      answerRequest(heldOn(SIGN_IN_A, "oldest"), "a 401");
    });
    await step(open, "a sibling saves B and the lease adopts it", async () => {
      await open.otherProcess.signIn(
        credentialsOf(SIBLING_SIGN_IN),
        false,
        null,
      );
      await open.tokens.adoptStoredSignIn();
    });
    // The lease's recovery is built while P is current.
    const recoveryOfP = open.tokens.streamRecovery(hostId);
    await step(open, "P is replaced by Q", async () => {
      processReleasedHosts.observeInstance(hostId, SECOND_PROCESS);
    });
    // Q's mint of B is refused, through P's revalidator.
    let outcome = "";
    await step(
      open,
      "P's revalidator recovers for the host: Q's refusal of B",
      async () => {
        outcome = await recoveryOfP.revalidateForReconnect(() => true);
      },
    );
    expect(outcome).toBe("network-error");
    await finish(open);
  });
});

describe("model O5: two recoveries each rotating, a third host having bought on the newest sign-in", () => {
  it("X's counting refusal of C is not final, so X gets one more recovery", async () => {
    const C = "sign-in-recovery-1";
    const open = await prepare("two host ids", [SIGN_IN_A, OURS, C]);
    await step(open, "X's mint is sent with A", async () => {
      startAsk(open, hostId);
      await untilHeldOn(SIGN_IN_A);
    });
    await step(
      open,
      "A is refused: X rotates A to B and retries on it",
      async () => {
        answerRequest(heldOn(SIGN_IN_A, "oldest"), "a 401");
        await untilHeldOn(OURS);
      },
    );
    await step(open, "meanwhile Y rotates B to C", () => rotateByTest(open));
    await step(open, "a third host buys a token on C", async () => {
      startAsk(open, otherHostId);
      await untilHeldOn(C);
      answerRequest(heldOn(C, "oldest"), "a token");
    });
    await step(
      open,
      "X's retry on B gets a stale refusal and re-asks on C",
      async () => {
        answerRequest(heldOn(OURS, "oldest"), "a 401");
        await untilHeldOn(C);
      },
    );
    await step(
      open,
      "X's retry on C is refused: counting, not final",
      async () => {
        answerRequest(heldOn(C, "oldest"), "a 401");
      },
    );
    await finish(open);
  });
});

describe("model (e): two recoveries sharing one refused flight", () => {
  it("one is answered rotated and the other adopted, and both retries are refused on the rotated sign-in: final, no further rotation", async () => {
    const open = await prepare("one process", [SIGN_IN_A, OURS]);
    await step(
      open,
      "two mints of the host share one request sent with A",
      async () => {
        startAsk(open, hostId);
        await untilHeldOn(SIGN_IN_A);
        startAsk(open, hostId);
      },
    );
    await step(open, "A is refused for both", async () => {
      answerRequest(heldOn(SIGN_IN_A, "oldest"), "a 401");
    });
    for (let pass = 0; pass < 3; pass += 1) {
      const retry = heldOn(OURS, "oldest");
      if (retry === undefined) break;
      await step(
        open,
        `a retry on the rotated sign-in is refused (${pass + 1})`,
        async () => {
          answerRequest(retry, "a 401");
        },
      );
    }
    expect(nonTestRotations()).toBe(1);
    await finish(open);
  });
});

describe("model: two overlapping refreshes in one process, the second superseded", () => {
  it("the first's sign-in is kept, the retries' refusal of it is final, and nothing rotates again", async () => {
    const open = await prepare("one process", [OURS]);
    await step(open, "two refreshes overlap", async () => {
      harness.testRotating = true;
      try {
        const first = open.tokens.refreshSignIn();
        const second = open.tokens.refreshSignIn();
        open.pending.push(first, second);
        await Promise.all([first, second]);
      } finally {
        harness.testRotating = false;
      }
    });
    await step(open, "a mint is sent with the installed sign-in", async () => {
      startAsk(open, hostId);
      await untilHeldOn(OURS);
    });
    await step(open, "it is refused: counting, final", async () => {
      answerRequest(heldOn(OURS, "oldest"), "a 401");
    });
    expect(nonTestRotations()).toBe(0);
    await finish(open);
  });
});

describe("model gap 2: a recovery for a known refusal of A, held at its adopting read", () => {
  it("answers adopted and rotates nothing when the lease has moved to B and B's refusal is recorded meanwhile", async () => {
    const open = await prepare("one process", [SIGN_IN_A, OURS]);
    await step(open, "a mint is sent with A", async () => {
      startAsk(open, hostId);
      await untilHeldOn(SIGN_IN_A);
    });
    const release = holdOneReadAfter(1);
    await step(
      open,
      "A is refused: counting; its recovery waits at its adopting read",
      async () => {
        answerRequest(heldOn(SIGN_IN_A, "oldest"), "a 401");
      },
    );
    await step(open, "our rotation moves the lease to B", () =>
      rotateByTest(open),
    );
    await step(
      open,
      "another mint of the host is sent with B and refused: final",
      async () => {
        startAsk(open, hostId);
        await untilHeldOn(OURS);
        answerRequest(heldOn(OURS, "oldest"), "a 401");
      },
    );
    await step(open, "the recovery's read is released", async () => {
      release();
    });
    expect(nonTestRotations()).toBe(0);
    await finish(open);
  });

  it("rotates nothing when the host process is replaced during the wait", async () => {
    const open = await prepare("one process", [SIGN_IN_A]);
    await step(open, "a mint is sent with A", async () => {
      startAsk(open, hostId);
      await untilHeldOn(SIGN_IN_A);
    });
    const release = holdOneReadAfter(1);
    await step(
      open,
      "A is refused: counting; its recovery waits at its adopting read",
      async () => {
        answerRequest(heldOn(SIGN_IN_A, "oldest"), "a 401");
      },
    );
    await step(open, "the host process is replaced", async () => {
      processReleasedHosts.observeInstance(hostId, SECOND_PROCESS);
    });
    await step(open, "the recovery's read is released", async () => {
      release();
    });
    expect(nonTestRotations()).toBe(0);
    await finish(open);
  });
});

describe("model gap 3: the tracker's own overtaken re-ask answers from the cache", () => {
  it("the cache hit moves no watermark: a counting refusal sent after the real purchase still counts", async () => {
    const C = "sign-in-recovery-1";
    const open = await prepare("one process", [SIGN_IN_A, OURS, C]);
    await step(open, "an old mint is sent with A", async () => {
      startAsk(open, hostId);
      await untilHeldOn(SIGN_IN_A);
    });
    await step(open, "our rotation installs B", () => rotateByTest(open));
    await step(
      open,
      "a mint is sent with B and bought: the real purchase",
      async () => {
        startAsk(open, hostId);
        await untilHeldOn(OURS);
        answerRequest(heldOn(OURS, "oldest"), "a token");
      },
    );
    await step(open, "our rotation installs C", () => rotateByTest(open));
    await step(open, "a mint is sent with C, after the purchase", async () => {
      startAsk(open, hostId);
      await untilHeldOn(C);
    });
    await step(
      open,
      "the old mint's refusal of A arrives: outlived, re-asked from the cache",
      async () => {
        answerRequest(heldOn(SIGN_IN_A, "oldest"), "a 401");
      },
    );
    await step(open, "C is refused: counting, and final", async () => {
      answerRequest(heldOn(C, "oldest"), "a 401");
    });
    await finish(open);
  });

  it("two successes resume out of order with a refusal between: the watermark does not roll back", async () => {
    const open = await prepare("one process", [SIGN_IN_A, OURS]);
    await step(open, "X is sent with A", async () => {
      startAsk(open, hostId);
      await untilHeldOn(SIGN_IN_A);
    });
    await step(open, "our rotation installs B", () => rotateByTest(open));
    await step(open, "Z is sent with B", async () => {
      startAsk(open, hostId);
      await untilHeldOn(OURS);
    });
    const release = holdReads();
    const zRequest = heldOn(OURS, "oldest");
    if (zRequest === undefined) throw new Error("Z sent no request");
    zRequest.resumeLater = true;
    await step(
      open,
      "Z is refused; its tracker waits at its adopting read",
      async () => {
        answerRequest(zRequest, "a 401");
      },
    );
    await step(open, "Y is sent with B, a new flight, and bought", async () => {
      startAsk(open, hostId);
      await untilHeldOn(OURS);
      answerRequest(heldOn(OURS, "oldest"), "a token");
    });
    await step(open, "X's token on A resumes late", async () => {
      answerRequest(heldOn(SIGN_IN_A, "oldest"), "a token");
    });
    await step(open, "Z resumes", async () => {
      harness.events.push({
        kind: "resumed",
        request: zRequest,
        storedThen: harness.storedSignIn(),
        askerLive: zRequest.askerLive,
      });
      release();
    });
    await finish(open);
  });
});
