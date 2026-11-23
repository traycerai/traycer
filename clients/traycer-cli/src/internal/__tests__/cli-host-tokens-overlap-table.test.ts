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
import { completeCredentialsReserve } from "./credentials-reserve-test-support";

// Two overlapping mints, in either completion order, over the real token path
// (`createCliHostTokens`) and a real credentials file, against a scripted authn.
// The rule under test: a `sign-in-rejected` leaves `tracked.obtain` only if, at
// the moment it leaves, (1) it was sent with the sign-in that is the stored one
// now, and (2) no mint for that host process that started after it has bought a
// token. Any other refusal is not a refusal for anyone: it judges, records,
// refreshes and reports nothing, and what goes upward is the answer of an ask on
// the stored sign-in.

const USER_ID = "user-1";
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
  | { readonly kind: "rotation-started"; readonly byTest: boolean };

const harness = vi.hoisted(() => ({
  requests: [] as MintRequest[],
  events: [] as Event[],
  table: new Map() as HostTokenTable,
  /** How many of the first requests are held; every later one is answered ok. */
  hold: 0,
  /** Set while the test itself refreshes the sign-in. */
  testRotating: false,
  /** Called whenever authn is sent a request. */
  onRequest: null as (() => void) | null,
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
      const token = credentialsFile.refreshed.shift();
      if (token === undefined)
        throw new Error("authn was asked for a refresh no test expected");
      return { kind: "refreshed", token, refreshToken: `rt-${token}` };
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
            answer: (outcome) => {
              request.given = outcome;
              resolve(outcome);
            },
          };
          harness.requests.push(request);
          harness.onRequest?.();
          if (seq >= harness.hold)
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
  ioInFlight = 0;
  ioIdle = null;
  harness.table = new Map();
  harness.hold = 0;
  harness.testRotating = false;
  hostCount += 1;
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
  user: { id: USER_ID, email: "user@example.test", name: "User" },
});

// The credentials file work the code under test starts on its own (a rotation,
// an adopting read): counted from the moment it starts until it settles.
let ioInFlight = 0;
let ioIdle: (() => void) | null = null;

function counted<T>(operation: Promise<T>): Promise<T> {
  ioInFlight += 1;
  return operation.finally(() => {
    ioInFlight -= 1;
    if (ioInFlight === 0) ioIdle?.();
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
    if (ioInFlight === 0) return;
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
}

const opened: OpenTokens[] = [];

async function openTokens(): Promise<OpenTokens> {
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
  const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
  const revalidator = createStoreBackedRevalidator({
    store,
    lease,
    signal: null,
  });
  const tokens = createCliHostTokens({
    lease,
    refresh: () => counted(revalidator.rotateSignIn()),
    adoptStored: () => counted(revalidator.adoptStoredSignIn()),
    signal: null,
  });
  await tokens.whenLoaded();
  harness.signInRejected = () => tokens.signInRejected();
  const reports: string[] = [];
  tokens.onRefusalEndingCommand((reportedHostId) => {
    reports.push(reportedHostId);
  });
  const open = { store, otherProcess, lease, tokens, reports };
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
        await tokens.streamRecovery(otherHostId).revalidateRefused(REVOKED);
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

    await tokens.streamRecovery(hostId).revalidateRefused(REVOKED);

    expect(rotationsStarted() - rotationsBefore).toBe(1);
  });
});
