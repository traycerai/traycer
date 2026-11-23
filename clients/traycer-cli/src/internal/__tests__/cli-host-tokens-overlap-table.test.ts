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
import type { Environment } from "../../runner/environment";
import {
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../../store/credentials-store";
import { createCliHostTokens } from "../cli-host-tokens";

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
      readonly refusalOf: MintRequest | null;
      readonly obeysRule: boolean;
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
  storedSignIn: (): string => "",
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
            harness.events.push({ kind: "left", refusalOf, obeysRule });
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
    scenario.hostProcesses === 1 && scenario.transition !== "rotated by us"
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
for (const hostProcesses of [1, 2] as const)
  for (const transition of TRANSITIONS)
    for (const first of ANSWERS)
      for (const second of ANSWERS)
        for (const order of ORDERS) {
          const scenario = { hostProcesses, transition, first, second, order };
          // One request, answered once: the second answer and the order mean nothing.
          if (
            sharesOneRequest(scenario) &&
            (second !== "a token" || order !== "first mint first")
          )
            continue;
          scenarios.push(scenario);
        }

const nameOf = (scenario: Scenario): string =>
  sharesOneRequest(scenario)
    ? `${scenario.hostProcesses} host process, sign-in ${scenario.transition} between, one shared request answered with ${scenario.first}`
    : `${scenario.hostProcesses} host process${scenario.hostProcesses === 1 ? "" : "es"}, sign-in ${scenario.transition} between, first mint answered with ${scenario.first}, second with ${scenario.second}, ${scenario.order}`;

let hostCount = 0;
let hostId = "";
let workDir = "";

beforeEach(async () => {
  harness.requests.splice(0);
  harness.events.splice(0);
  harness.table = new Map();
  harness.hold = 0;
  harness.testRotating = false;
  hostCount += 1;
  hostId = `66666666-6666-4666-8666-${String(hostCount).padStart(12, "0")}`;
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

/**
 * Waits until nothing the test watches has changed for a run of event-loop
 * turns: what an answer set going (credentials file reads, a refresh, a retried
 * mint) has then finished or is waiting on a held request.
 */
async function settled(): Promise<void> {
  const watched = (): string =>
    `${harness.requests.length}/${harness.events.length}`;
  let last = watched();
  let steady = 0;
  while (steady < 25) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const now = watched();
    steady = now === last ? steady + 1 : 0;
    last = now;
  }
}

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

describe.each(scenarios)(
  "two overlapping mints: $hostProcesses host process(es), sign-in $transition",
  (scenario) => {
    it(nameOf(scenario), async () => {
      const store = createCliCredentialsStore();
      // A second handle on the same file: another process's save.
      const otherProcess = createCliCredentialsStore();
      await store.signIn(credentialsOf(SIGN_IN_A), false, null);
      credentialsFile.refreshed.push(
        OURS,
        "sign-in-recovery-1",
        "sign-in-recovery-2",
        "sign-in-recovery-3",
      );
      const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
      const revalidator = createStoreBackedRevalidator({
        store,
        lease,
        signal: null,
      });
      const tokens = createCliHostTokens({
        lease,
        refresh: () => revalidator.rotateSignIn(),
        adoptStored: () => revalidator.adoptStoredSignIn(),
        signal: null,
      });
      await tokens.whenLoaded();
      processReleasedHosts.observeInstance(hostId, FIRST_PROCESS);
      const requestsExpected = sharesOneRequest(scenario) ? 1 : 2;
      harness.hold = requestsExpected;

      // The first mint starts and is held.
      const first = tokens.mintFresh(hostId, null);
      await vi.waitFor(() => expect(harness.requests).toHaveLength(1));

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
      const second = tokens.mintFresh(hostId, null);
      await vi.waitFor(() =>
        expect(harness.requests).toHaveLength(requestsExpected),
      );
      await settled();

      // Authn answers, in the order the case names.
      const firstRequest = harness.requests[0];
      const secondRequest = harness.requests[1] ?? firstRequest;
      if (firstRequest === undefined || secondRequest === undefined)
        throw new Error("the mints sent no request");
      if (sharesOneRequest(scenario)) {
        firstRequest.answer(answerOf(scenario.first, 0));
        await settled();
      } else if (scenario.order === "first mint first") {
        firstRequest.answer(answerOf(scenario.first, 0));
        await settled();
        secondRequest.answer(answerOf(scenario.second, 1));
        await settled();
      } else {
        secondRequest.answer(answerOf(scenario.second, 1));
        await settled();
        firstRequest.answer(answerOf(scenario.first, 0));
        await settled();
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

      tokens.dispose();
      store.dispose();
      otherProcess.dispose();
    });
  },
);
