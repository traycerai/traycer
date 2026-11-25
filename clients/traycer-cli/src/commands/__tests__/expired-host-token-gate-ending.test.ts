import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANSWERS_AT_ONCE,
  STORED_SIGN_IN,
  deferred,
  openWorld,
  personOf,
  type HomeRef,
  type World,
} from "./expired-host-token-harness";
import { UnaryDoor } from "./expired-host-token-unary-door";
import { liveUnary, seams } from "./expired-host-token-seams";
import { config } from "../../config";
import {
  observeAttemptRecoveryEvidence,
  type AttemptRecoveryEvidenceObservation,
} from "../../host/update-recovery-evidence";
import { hostHomeDir } from "../../store/paths";
import {
  callHostRpcAtEndpoint,
  hostRpcGateEndingOf,
} from "../../internal/host-rpc";
import { createCliCredentialsStore } from "../../store/credentials-store";

/**
 * How the gate ended a call, read through the updater's real evidence
 * function, which used to read every ending as an unreachable host. Every
 * ending is the gate's own, made by the real call: a mint answered with the
 * refusal while the call waits for its first token. (The doctor's reading is
 * in expired-host-token-gate-ending-doctor.test.ts.)
 */

const home = vi.hoisted((): HomeRef => ({ path: null }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.path ?? actual.homedir() };
});
vi.mock("../../logger", async () =>
  (await import("./expired-host-token-seams")).loggerModule(),
);
vi.mock("../../host/pid-metadata", async (importOriginal) =>
  (await import("./expired-host-token-seams")).pidMetadataModule(
    await importOriginal<typeof import("../../host/pid-metadata")>(),
  ),
);
vi.mock("../../internal/sign-in-environments", async (importOriginal) =>
  (await import("./expired-host-token-seams")).signInEnvironmentsModule(
    await importOriginal<
      typeof import("../../internal/sign-in-environments")
    >(),
  ),
);
vi.mock(
  "@traycer-clients/shared/host-client/host-ownership",
  async (importOriginal) =>
    (await import("./expired-host-token-seams")).hostOwnershipModule(
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-ownership")
      >(),
    ),
);
vi.mock(
  "../../../../shared/host-transport/whatwg-stream-ws-factory",
  async () =>
    (await import("./expired-host-token-seams")).streamFactoryModule(),
);
vi.mock("../../../../shared/host-transport/whatwg-ws-factory", async () =>
  (await import("./expired-host-token-seams")).unaryFactoryModule(),
);
// The messenger seam: the error the call's messenger ends a request with is
// kept as it left, to be compared with the one the call threw.
let world: World;
let unary: UnaryDoor;

beforeEach(async () => {
  vi.stubEnv("TRAYCER_AGENT_ID", "");
  vi.stubEnv("TRAYCER_EPIC_ID", "");
  world = await openWorld(home, "none");
  unary = new UnaryDoor(world.mint, world.expiredHeld);
  liveUnary.door = unary;
  unary.serve = () => {
    throw new Error("the host answers nothing");
  };
});

afterEach(async () => {
  liveUnary.door = null;
  vi.unstubAllEnvs();
  await world.close();
});

type EndingKind =
  | "sign-in-rejected"
  | "not-a-member"
  | "not-admitted"
  | "sandbox-frozen";

const HOST_REFUSALS = [
  "not-a-member",
  "not-admitted",
  "sandbox-frozen",
] as const;

/**
 * `start` makes a call while no host-only token is held; the mint is asked,
 * and answered as the ending requires: the gate ends the call before any
 * request frame is written.
 */
async function endedBy<Result>(
  kind: EndingKind,
  start: () => Promise<Result>,
): Promise<Result> {
  const run = start();
  await vi.waitFor(() => expect(world.mint.requests.length).toBeGreaterThan(0));
  world.mint.respond(kind);
  const result = await run;
  expect(unary.requests).toEqual([]);
  return result;
}

const readEvidence = (): Promise<AttemptRecoveryEvidenceObservation> =>
  observeAttemptRecoveryEvidence(
    config.environment,
    hostHomeDir(config.environment),
    "version-only",
  );

describe("the updater's host.status, ended by the gate", () => {
  it("sign-in-rejected: the diagnosis is sign-in-rejected, which stops the verify loop early", async () => {
    const observation = await endedBy("sign-in-rejected", readEvidence);
    expect(observation.runningDiagnosis).toBe("sign-in-rejected");
    expect(observation.runningRefusal).toBe("sign-in-rejected");
  }, 60_000);

  it.each(HOST_REFUSALS)(
    "%s: stays on today's arm, host-rpc-unreachable, with no refusal carried (a named limit)",
    async (kind) => {
      const observation = await endedBy(kind, readEvidence);
      expect(observation.runningDiagnosis).toBe("host-rpc-unreachable");
      expect(observation.runningRefusal).toBeNull();
    },
    60_000,
  );
});

describe("no-sign-in does not end a call from a live handle (a measured fact)", () => {
  it("a sign-out while the call waits: the credentials store keeps the lease's sign-in, the call goes on with it, and no gate ending is made", async () => {
    // The held token is refused only once the person has signed out meanwhile.
    await world.close();
    world = await openWorld(home, null);
    unary = new UnaryDoor(world.mint, world.expiredHeld);
    liveUnary.door = unary;
    // The door refuses the sign-in it is shown, as row D's account is.
    unary.signIn = ANSWERS_AT_ONCE("not-admitted");
    const refusal = deferred();
    unary.expired = { answer: "token-expired", after: refusal.promise };
    const run = callHostRpcAtEndpoint(
      "host.status",
      {},
      { hostId: world.hostId, websocketUrl: seams.endpoint.websocketUrl },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(unary.opens.length).toBeGreaterThan(0));
    await vi.waitFor(() =>
      expect(world.mint.requests.length).toBeGreaterThan(0),
    );
    const store = createCliCredentialsStore();
    const person = await personOf(world);
    try {
      expect((await store.signOut(null)).outcome).toBe("deleted");
      // This process reads the file: the lease still holds the sign-in.
      await person.tokens.adoptStoredSignIn();
    } finally {
      store.dispose();
      person.dispose();
    }
    world.mint.respond("unavailable");
    refusal.settle();
    const thrown = await run;
    // The call went on and presented the held sign-in to the door.
    expect(unary.opens.map((open) => open.token)).toContain(STORED_SIGN_IN);
    expect(hostRpcGateEndingOf(thrown)).toBeNull();
    expect((thrown as { message: string }).message).toBe(
      "door refused: not-admitted",
    );
  }, 30_000);
});
