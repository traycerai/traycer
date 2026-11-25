import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mayHaveReachedHost } from "@traycer/protocol/host-transport/remote/rpc-types";
import {
  ANSWERS_AT_ONCE,
  deferred,
  openWorld,
  personOf,
  type DoorScript,
  type HomeRef,
  type World,
} from "./expired-host-token-harness";
import { UnaryDoor } from "./expired-host-token-unary-door";
import { liveUnary, seams } from "./expired-host-token-seams";
import { buildTaskCreateCommand } from "../task-create";
import { config } from "../../config";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import {
  PLAIN_DISPATCH,
  callHostRpcAtResolvedEndpoint,
  callHostRpcWithDispatch,
  callHostRpcWithAgentCredential,
  hostRpcWroteNoRequest,
} from "../../internal/host-rpc";
import { readAgentCommandCredential } from "../../internal/agent-session-capability";
import { resolveHostAuth } from "../../internal/host-auth";
import {
  observeHostInstance,
  type CliSignInHandle,
} from "../../internal/cli-host-tokens";
import { cliTaskCreateKeysDir } from "../../store/paths";
import {
  readTaskCreateKey,
  taskCreateKeyRecordPath,
} from "../../store/task-create-keys";

/**
 * A call that wrote a request frame is not a call that wrote none, whatever
 * the mint reported meanwhile: the host may have carried the request out, so
 * the call's own failure leaves as the client produced it, and `task create`
 * keeps its key record. What the call wrote is read at the socket.
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

const KEY = "key-1";
const EPIC_CREATE = "epic.create";
/** The failure the client ends a dropped transport with, as `task create` words it. */
const OWN_FAILURE_LINE =
  "traycer: WebSocket closed before next frame (code=1006, reason='connection lost') - the request was sent and the host may have carried it out; check before sending it again. Task ";

let world: World;
let unary: UnaryDoor;

function newUnaryDoor(): void {
  unary = new UnaryDoor(world.mint, world.expiredHeld);
  liveUnary.door = unary;
  unary.serve = () => {
    throw new Error("the host answers nothing");
  };
}

async function reopen(held: boolean): Promise<void> {
  await world.close();
  world = await openWorld(home, held ? null : "none");
  newUnaryDoor();
}

beforeEach(async () => {
  vi.stubEnv("TRAYCER_AGENT_ID", "");
  vi.stubEnv("TRAYCER_EPIC_ID", "");
  world = await openWorld(home, "none");
  newUnaryDoor();
});

afterEach(async () => {
  liveUnary.door = null;
  vi.unstubAllEnvs();
  await world.close();
});

const CREATE_LIKE = {
  ...PLAIN_DISPATCH,
  failFast: true,
  reauthenticate: "before-request",
  idempotencyKey: "task-1",
} as const;

type Ended = { readonly error: CliError } | { readonly done: unknown };

async function runTaskCreate(): Promise<Ended> {
  const command = buildTaskCreateCommand({
    title: null,
    message: "ship it",
    workspaces: ["/work/feature"],
    repos: [],
    harness: "claude",
    model: "sonnet",
    reasoningEffort: null,
    permissionMode: null,
    profile: "ambient",
    idempotencyKey: KEY,
  });
  try {
    return { done: await command(world.ctx) };
  } catch (error) {
    if (error instanceof CliError) return { error };
    throw error;
  }
}

function recordOfKey(): Promise<{ readonly kind: string }> {
  return readTaskCreateKey(
    taskCreateKeyRecordPath(
      cliTaskCreateKeysDir(config.environment),
      world.userId,
      KEY,
    ),
    Date.now(),
  );
}

/** What the host admits the call with, and the open it waits on. */
interface Authority {
  readonly name: string;
  /** A token past its end is held: the call's first open presents it. */
  readonly held: boolean;
  /** The open (by index) the admission is gated on. */
  readonly admittedOpen: number;
  arrange(door: UnaryDoor, admission: Promise<void>): void;
}

const ADMITTED_AFTER = (admission: Promise<void>): DoorScript => ({
  answer: "admit",
  after: admission,
});

const AUTHORITIES: readonly Authority[] = [
  {
    name: "the host token",
    held: true,
    admittedOpen: 0,
    arrange: (door, admission) => {
      door.expired = ADMITTED_AFTER(admission);
    },
  },
  {
    name: "the stored sign-in, after a released host's refusal of the token",
    held: true,
    admittedOpen: 1,
    arrange: (door, admission) => {
      door.expired = ANSWERS_AT_ONCE("released");
      door.signIn = ADMITTED_AFTER(admission);
    },
  },
  {
    name: "the owner's sign-in, on the host's invitation",
    held: false,
    admittedOpen: 1,
    arrange: (door, admission) => {
      door.signIn = ADMITTED_AFTER(admission);
    },
  },
  {
    name: "the stored sign-in, in released-host mode (the probe answered as a released host)",
    held: false,
    admittedOpen: 1,
    arrange: (door, admission) => {
      door.probe = ANSWERS_AT_ONCE("released");
      door.signIn = ADMITTED_AFTER(admission);
    },
  },
];

/**
 * Settles when the mint's refusal ends a command in this process: the read the
 * call's gate makes at its exit (`refusalEndingCommandNow`) answers it.
 */
async function whenMintRefusalReported(person: CliSignInHandle): Promise<void> {
  await vi.waitFor(async () =>
    expect(
      await person.tokens.refusalEndingCommandNow(world.hostId),
    ).not.toBeNull(),
  );
}

/**
 * The call's open is admitted, its request frame written, and the transport
 * dropped: all while the mint's refusal has been reported to the process.
 */
async function writeThenDrop<Result>(
  authority: Authority,
  start: () => Promise<Result>,
  whenRequestRead: () => void,
  check: (ended: Result) => Promise<void> | void,
): Promise<void> {
  await reopen(authority.held);
  const admission = deferred();
  authority.arrange(unary, admission.promise);
  unary.cutAfterRequest = () => {
    whenRequestRead();
    return "drop";
  };
  const run = start();
  await unary.whenOpened(authority.admittedOpen);
  const person = await personOf(world);
  try {
    world.mint.respond("sign-in-rejected");
    await whenMintRefusalReported(person);
    admission.settle();
    await check(await run);
  } finally {
    person.dispose();
  }
}

describe.each(AUTHORITIES)(
  "a call admitted on $name, then its request written and the transport dropped, the mint's refusal reported meanwhile",
  (authority) => {
    it("fails with the client's own failure, which is not marked as written-nothing", async () => {
      await writeThenDrop(
        authority,
        () =>
          callHostRpcWithDispatch("bot.list", {}, CREATE_LIKE).then(
            (value) => ({ ok: value }),
            (error: unknown) => ({ error }),
          ),
        () => undefined,
        (ended) => {
          if (!("error" in ended)) expect.fail("the call completed");
          expect(hostRpcWroteNoRequest(ended.error)).toBe(false);
          expect(ended.error).not.toBeInstanceOf(CliError);
          expect(mayHaveReachedHost(ended.error)).toBe(true);
          expect(unary.requests.map((request) => request.method)).toEqual([
            "bot.list",
          ]);
        },
      );
    }, 20_000);

    it("task create: the outcome is unknown, the line says a Task may have been created, the key's record is kept", async () => {
      await writeThenDrop(
        authority,
        runTaskCreate,
        () => undefined,
        async (ended) => {
          if (!("error" in ended)) expect.fail("the command completed");
          expect(ended.error).toMatchObject({
            code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
            exitCode: 1,
          });
          expect(ended.error.message.startsWith(OWN_FAILURE_LINE)).toBe(true);
          expect(ended.error.message).toMatch(/ may have been created\. /);
          expect(await recordOfKey()).toMatchObject({ kind: "intent" });
          expect(unary.requests.map((request) => request.method)).toEqual([
            EPIC_CREATE,
          ]);
        },
      );
    }, 20_000);
  },
);

const OWNER_SIGN_IN = AUTHORITIES[2];

describe("an admission that is no longer the current instance's", () => {
  it("the host process is replaced after the open is admitted and before the request is read, then the transport drops: the outcome is unknown, the key's record is kept", async () => {
    await writeThenDrop(
      OWNER_SIGN_IN,
      runTaskCreate,
      // Another process instance is observed for this host id mid-call: the
      // instance that admitted is not the current one when the call ends. The
      // first observation names the instance the call read; the second
      // replaces it.
      () => {
        const host = { hostId: world.hostId, pid: 4001, startedAt: "a" };
        observeHostInstance(host);
        observeHostInstance({ ...host, pid: 4002, startedAt: "b" });
      },
      async (ended) => {
        if (!("error" in ended)) expect.fail("the command completed");
        expect(ended.error.message.startsWith(OWN_FAILURE_LINE)).toBe(true);
        expect(await recordOfKey()).toMatchObject({ kind: "intent" });
        expect(unary.requests.map((request) => request.method)).toEqual([
          EPIC_CREATE,
        ]);
      },
    );
  }, 20_000);
});

describe("a call on a door this client never handles (an agent session's capability)", () => {
  it("is marked as nothing: its refusal is not the gate's to word", async () => {
    // The capability's value stands in for a token the host refuses.
    const credential = readAgentCommandCredential((name) =>
      name === "TRAYCER_AGENT_SESSION_CAPABILITY"
        ? world.expiredHeld
        : undefined,
    );
    const ended = await callHostRpcWithAgentCredential(
      "bot.list",
      {},
      credential,
      CREATE_LIKE,
    ).then(
      (value) => ({ ok: value }),
      (error: unknown) => ({ error }),
    );
    if (!("error" in ended)) expect.fail("the call completed");
    expect(unary.opens).toHaveLength(1);
    expect(unary.requests).toEqual([]);
    expect(hostRpcWroteNoRequest(ended.error)).toBe(false);
  }, 20_000);
});

describe("install's environment.move.start", () => {
  it("reads a lost reply as one that may have reached the host, though a mint refusal was reported: what startReplyLost is set from", async () => {
    await reopen(OWNER_SIGN_IN.held);
    const admission = deferred();
    OWNER_SIGN_IN.arrange(unary, admission.promise);
    unary.cutAfterRequest = () => "drop";
    const auth = await resolveHostAuth();
    if (auth === null) expect.fail("no stored sign-in");
    const run = callHostRpcAtResolvedEndpoint(
      "environment.move.start",
      {
        attemptId: "6f1c1b6e-0000-4000-8000-000000000001",
        planHash: "plan-hash",
        acceptanceId: "6f1c1b6e-0000-4000-8000-000000000002",
      },
      seams.endpoint,
      auth,
      { ...PLAIN_DISPATCH, failFast: true },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    await unary.whenOpened(OWNER_SIGN_IN.admittedOpen);
    const person = await personOf(world);
    try {
      world.mint.respond("sign-in-rejected");
      await whenMintRefusalReported(person);
      admission.settle();
      const error = await run;
      expect(error).not.toBeNull();
      // install-auth.ts reads `startReplyLost = mayHaveReachedHost(error)`.
      expect(mayHaveReachedHost(error)).toBe(true);
      expect(unary.requests.map((request) => request.method)).toEqual([
        "environment.move.start",
      ]);
    } finally {
      person.dispose();
    }
  }, 20_000);
});
