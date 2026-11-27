import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import {
  ANSWERS_AT_ONCE,
  FRESH_HOST_TOKEN,
  STORED_SIGN_IN,
  deferred,
  heldEndingIn,
  openWorld,
  personOf,
  startNewProcess,
  whenPublishedInProcess,
  type HomeRef,
  type World,
} from "./expired-host-token-harness";
import {
  UnaryDoor,
  whenInvitationActedOn,
} from "./expired-host-token-unary-door";
import { liveUnary } from "./expired-host-token-seams";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import {
  PLAIN_DISPATCH,
  callHostRpcWithDispatch,
} from "../../internal/host-rpc";
import { buildTaskCreateCommand } from "../task-create";
import { config } from "../../config";
import { createOutput } from "../../runner/output";
import { CliError } from "../../runner/errors";
import { cliTaskCreateKeysDir } from "../../store/paths";
import {
  readTaskCreateKey,
  taskCreateKeyRecordPath,
} from "../../store/task-create-keys";

/**
 * `traycer task create`, the fail-fast create, over the real unary client on
 * the fake unary door: a person with no cached grant, whose computer authn
 * does not admit them to (row D), or whose sign-in authn rejects. The refusal
 * is on the call's way out, before any request frame: nothing was created, and
 * the line says no Task may have been created.
 */

const home = vi.hoisted((): HomeRef => ({ path: null }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.path ?? actual.homedir() };
});
vi.mock("../../internal/cli-host-tokens", async (importOriginal) =>
  (await import("./expired-host-token-seams")).cliHostTokensModule(
    await importOriginal<typeof import("../../internal/cli-host-tokens")>(),
  ),
);
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

let world: World;
let unary: UnaryDoor;
let stderrTty: PropertyDescriptor | undefined;

/** A fresh unary door for the next run; it serves the create the host accepts. */
function newUnaryDoor(): void {
  unary = new UnaryDoor(world.mint, world.expiredHeld);
  liveUnary.door = unary;
  unary.serve = (method) => {
    if (method === EPIC_CREATE) return { roomInfo: null, task: null };
    throw new Error(`unexpected host RPC ${method}`);
  };
}

beforeEach(async () => {
  vi.stubEnv("TRAYCER_AGENT_ID", "");
  vi.stubEnv("TRAYCER_EPIC_ID", "");
  stderrTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  // The line as a pipe or a file gets it: `[code=...]` follows the message.
  Object.defineProperty(process.stderr, "isTTY", {
    value: false,
    configurable: true,
  });
  world = await openWorld(home, "none");
  newUnaryDoor();
  // A sign-in presented to the door is refused the way row D's account is.
  unary.signIn = ANSWERS_AT_ONCE("not-admitted");
});

afterEach(async () => {
  liveUnary.door = null;
  if (stderrTty === undefined) Reflect.deleteProperty(process.stderr, "isTTY");
  else Object.defineProperty(process.stderr, "isTTY", stderrTty);
  vi.unstubAllEnvs();
  await world.close();
});

type Ended = { readonly error: CliError } | { readonly done: unknown };

async function runTaskCreate(key: string | null): Promise<Ended> {
  const command = buildTaskCreateCommand({
    title: null,
    message: "ship it",
    workspaces: ["/work/feature"],
    repos: [],
    harness: "claude",
    model: "sonnet",
    reasoningEffort: null,
    permissionMode: null,
    // A named profile: no `providers.list` call goes first.
    profile: "ambient",
    idempotencyKey: key,
  });
  try {
    return { done: await command(world.ctx) };
  } catch (error) {
    if (error instanceof CliError) return { error };
    throw error;
  }
}

function errorOf(ended: Ended): CliError {
  if ("error" in ended) return ended.error;
  return expect.fail("the command completed");
}

/** The line the person reads for this ending: the runner's own writer. */
function printedLine(error: CliError): string {
  const before = world.output.lines.length;
  createOutput(world.ctx.runtime).emitError(
    error.code,
    error.message,
    error.details,
  );
  // A write is recorded with its completion callback after the text.
  const written = world.output.lines.slice(before)[0] ?? "";
  return written.split("\n")[0] ?? "";
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

const createRequests = (): number =>
  unary.requests.filter((request) => request.method === EPIC_CREATE).length;

describe("task create, signed in as an account that is not this computer's owner", () => {
  // The invitation comes while the mint is still out: the call waits for the
  // mint's answer, and ends as it does when that answer comes first (below).
  it("the host's invitation comes before the mint's answer: the call waits for it, nothing is created, and the sign-in never leaves", async () => {
    const invitation = deferred();
    unary.probe = { answer: "owner-sign-in", after: invitation.promise };
    const run = runTaskCreate(null);
    try {
      await unary.whenOpenedAs([NO_HOST_TOKEN_PROBE]);
      invitation.settle();
      await whenInvitationActedOn(unary);
      expect(unary.opens.map((open) => open.token)).toEqual([
        NO_HOST_TOKEN_PROBE,
      ]);
      world.mint.respond("not-admitted");
      const error = errorOf(await run);
      expect(unary.opens.map((open) => open.token)).toEqual([
        NO_HOST_TOKEN_PROBE,
      ]);
      expect(unary.requests).toEqual([]);
      expect(error).toMatchObject({
        code: "E_FORBIDDEN",
        message: "",
        exitCode: 1,
      });
      expect(printedLine(error)).toBe("error:  [code=E_FORBIDDEN]");
    } finally {
      invitation.settle();
      world.mint.respond("unavailable");
      await run.catch(() => undefined);
    }
  }, 20_000);

  // The invitation comes after the mint's `not-admitted` is published: the
  // sign-in does not go. No request frame was written, and the ending says so.
  it("the host's invitation comes after the mint's answer is published: only the probe is on the wire, and nothing was created", async () => {
    const invitation = deferred();
    unary.probe = { answer: "owner-sign-in", after: invitation.promise };
    const run = runTaskCreate(null);
    try {
      await unary.whenOpenedAs([NO_HOST_TOKEN_PROBE]);
      const person = await personOf(world);
      try {
        world.mint.respond("not-admitted");
        await whenPublishedInProcess(person, world);
        invitation.settle();
        const error = errorOf(await run);
        expect(unary.opens.map((open) => open.token)).toEqual([
          NO_HOST_TOKEN_PROBE,
        ]);
        expect(unary.requests).toEqual([]);
        expect(error).toMatchObject({
          code: "E_FORBIDDEN",
          message: "",
          exitCode: 1,
        });
        expect(printedLine(error)).toBe("error:  [code=E_FORBIDDEN]");
      } finally {
        person.dispose();
      }
    } finally {
      invitation.settle();
      await run.catch(() => undefined);
    }
  }, 20_000);
});

describe("task create, a usable held token the host refuses at the open", () => {
  // A guard: a call that wrote no request frame leaves the client marked so,
  // and that mark is what task create reads, whatever refused the open.
  it("is not created: the door's line, the key's record cleared, and the rerun creates once", async () => {
    await world.close();
    world = await openWorld(home, heldEndingIn(30 * 60_000));
    newUnaryDoor();
    // The held token has not ended: the host refuses it for another reason,
    // and authn cannot be reached for a new one.
    unary.expired = ANSWERS_AT_ONCE("not-admitted");
    world.mint.respond("unavailable");

    expectEnding(await runTaskCreate(KEY), {
      code: DOOR_REFUSED_SIGN_IN,
      message: "door refused: not-admitted",
      opens: ["held"],
    });
    expect(opensSeen()).toEqual(["held"]);
    expect(unary.requests).toEqual([]);
    expect(await recordOfKey()).toEqual({ kind: "absent" });
    await rerunCreatesExactlyOnce();
  }, 30_000);
});

describe("task create, the host's invitation heard while the mint is out, then a newer refusal naming its reason from the same host process", () => {
  it("the mint then answering unavailable: no frame carries the stored sign-in, and nothing is created", async () => {
    // A host that is handed the sign-in takes it.
    unary.signIn = ANSWERS_AT_ONCE("admit");
    const invitation = deferred();
    unary.probe = { answer: "owner-sign-in", after: invitation.promise };
    // The other request's probe is the host's newer answer.
    unary.openAt.set(1, ANSWERS_AT_ONCE("not-admitted"));
    const run = runTaskCreate(KEY);
    let other: Promise<unknown> | null = null;
    try {
      await unary.whenOpenedAs([NO_HOST_TOKEN_PROBE]);
      invitation.settle();
      await whenInvitationActedOn(unary);
      expect(unary.opens.map((open) => open.token)).toEqual([
        NO_HOST_TOKEN_PROBE,
      ]);

      other = callHostRpcWithDispatch(
        "bot.list",
        {},
        { ...PLAIN_DISPATCH, failFast: true },
      ).catch(() => undefined);
      await unary.whenRefused(1);
      // This process has read that refusal, with the mint still out.
      await vi.waitFor(() =>
        expect(
          processReleasedHosts.probeDeclined(world.userId, world.hostId),
        ).toBe(true),
      );
      expect(world.mint.requests).toHaveLength(1);

      world.mint.respond("unavailable");
      const ended = await run;
      await other;
      expect(
        unary.frames.filter((frame) => frame.includes(STORED_SIGN_IN)),
      ).toEqual([]);
      expect(unary.opens.map((open) => open.token)).toEqual([
        NO_HOST_TOKEN_PROBE,
        NO_HOST_TOKEN_PROBE,
      ]);
      expect(unary.requests).toEqual([]);
      expect(errorOf(ended).message).not.toMatch(/may have been created/);
      expect(await recordOfKey()).toEqual({ kind: "absent" });
    } finally {
      invitation.settle();
      world.mint.respond("unavailable");
      await run.catch(() => undefined);
      await other;
    }
  }, 20_000);
});

describe("task create, a host that admits the open and serves a manifest this CLI cannot work with", () => {
  it("is not created: the client's fatalError is no written request, the key's record is cleared, and the rerun creates once", async () => {
    await world.close();
    world = await openWorld(home, heldEndingIn(30 * 60_000));
    newUnaryDoor();
    unary.expired = ANSWERS_AT_ONCE("admit");
    // A method this CLI requires, and not the one it calls.
    unary.servedManifest = (asked) => {
      expect(asked).toHaveProperty(["agent.list"]);
      return Object.fromEntries(
        Object.entries(asked).filter(([method]) => method !== "agent.list"),
      );
    };

    const error = errorOf(await runTaskCreate(KEY));

    // The open was admitted, the client's own check failed, and it said so
    // to the host before any request.
    expect(
      unary.frames.map((frame) => {
        const sent: unknown = JSON.parse(frame);
        return typeof sent === "object" && sent !== null && "kind" in sent
          ? sent.kind
          : null;
      }),
    ).toEqual(["open", "fatalError"]);
    expect(unary.requests).toEqual([]);
    expect(error.message).not.toMatch(/may have been created/);
    expect(error.message).toContain("agent.list");
    expect(await recordOfKey()).toEqual({ kind: "absent" });
    await rerunCreatesExactlyOnce();
  }, 30_000);
});

type MintAnswerHere = "not-admitted" | "sign-in-rejected" | "unavailable";

/** What the call ends with, for the wire the scenario leaves. */
interface Ending {
  readonly code: string;
  readonly message: string;
  /** The tokens the door read, by open: the held token, the probe, the sign-in. */
  readonly opens: readonly ("held" | "probe" | "sign-in")[];
}

const DOOR_REFUSED_SIGN_IN: Ending["code"] = "E_AUTH_REJECTED";
/** The stored-credential line, written out. */
const STORED_REJECTED: Pick<Ending, "code" | "message"> = {
  code: "E_AUTH_REJECTED",
  message:
    "The stored credential was rejected. Run `traycer login` to re-authenticate.",
};

function opensSeen(): readonly string[] {
  return unary.opens.map((open) =>
    open.token === world.expiredHeld
      ? "held"
      : open.token === NO_HOST_TOKEN_PROBE
        ? "probe"
        : open.token === STORED_SIGN_IN
          ? "sign-in"
          : "other",
  );
}

/** Once the cause is fixed, a rerun with the same key creates exactly once. */
async function rerunCreatesExactlyOnce(): Promise<void> {
  startNewProcess();
  world.mint.respond("ok");
  newUnaryDoor();
  expect(await runTaskCreate(KEY)).toMatchObject({
    done: { data: { alreadyCreated: false } },
  });
  expect(createRequests()).toBe(1);
  expect(await recordOfKey()).toMatchObject({ kind: "done" });
}

/**
 * A call that writes no request frame (the open only: the probe, a refused
 * sign-in, a redial) is a Task not created: the existing line for what ended
 * it, no "may have been created", the key's record cleared, and the same key
 * run again creates exactly once.
 */
/** What a refusal ends the create with when the mint answers first. */
const NOT_ADMITTED_ENDING: Ending = {
  code: "E_FORBIDDEN",
  message: "",
  opens: ["probe"],
};
const REJECTED_ENDING: Ending = { ...STORED_REJECTED, opens: ["probe"] };

const NO_REQUEST_CASES: readonly {
  readonly scenario:
    | "the probe alone"
    | "the invitation before the mint's answer"
    | "the probe, then a refused sign-in"
    | "a redial";
  readonly mint: MintAnswerHere;
  readonly ending: Ending;
}[] = [
  // "The probe alone" has the mint's answer first: the host's invitation is
  // heard after it. The order decides nothing, so each ending is both rows'.
  {
    scenario: "the probe alone",
    mint: "not-admitted",
    ending: NOT_ADMITTED_ENDING,
  },
  {
    scenario: "the invitation before the mint's answer",
    mint: "not-admitted",
    ending: NOT_ADMITTED_ENDING,
  },
  {
    scenario: "the probe alone",
    mint: "sign-in-rejected",
    ending: REJECTED_ENDING,
  },
  {
    scenario: "the invitation before the mint's answer",
    mint: "sign-in-rejected",
    ending: REJECTED_ENDING,
  },
  {
    scenario: "the probe, then a refused sign-in",
    mint: "unavailable",
    ending: {
      code: DOOR_REFUSED_SIGN_IN,
      message: "door refused: not-admitted",
      opens: ["probe", "sign-in"],
    },
  },
  {
    scenario: "a redial",
    mint: "not-admitted",
    ending: {
      code: "E_FORBIDDEN",
      message: "",
      opens: ["held", "probe"],
    },
  },
  {
    scenario: "a redial",
    mint: "sign-in-rejected",
    ending: {
      ...STORED_REJECTED,
      opens: ["held", "probe"],
    },
  },
  {
    scenario: "a redial",
    mint: "unavailable",
    ending: {
      code: DOOR_REFUSED_SIGN_IN,
      message: "door refused: not-admitted",
      opens: ["held", "probe", "sign-in"],
    },
  },
];

describe.each(NO_REQUEST_CASES)(
  "task create, $scenario, mint answers $mint",
  ({ scenario, mint, ending }) => {
    it("is not created: the existing line, the key's record cleared, and the rerun creates once", async () => {
      if (scenario === "a redial") {
        // The held token is past its end: open 0 is refused, the redial probes.
        await world.close();
        world = await openWorld(home, null);
        newUnaryDoor();
        unary.signIn = ANSWERS_AT_ONCE("not-admitted");
      }
      const invitation = deferred();
      unary.probe = { answer: "owner-sign-in", after: invitation.promise };
      const run = runTaskCreate(KEY);
      try {
        // A redial's first open is the held token; the others' is the probe.
        await unary.whenOpenedAs([
          scenario === "a redial" ? world.expiredHeld : NO_HOST_TOKEN_PROBE,
        ]);
        const person = await personOf(world);
        try {
          if (scenario === "the probe, then a refused sign-in") {
            // An unreachable authn lets the sign-in go, whenever it answers.
            world.mint.respond(mint);
            invitation.settle();
            expectEnding(await run, ending);
          } else if (scenario === "the invitation before the mint's answer") {
            invitation.settle();
            await whenInvitationActedOn(unary);
            expect(opensSeen()).toEqual(["probe"]);
            world.mint.respond(mint);
            expectEnding(await run, ending);
          } else {
            if (scenario === "a redial") {
              await unary.whenRefused(0);
              // The refused held token is marked, and the mint is not answered.
              await vi.waitFor(() =>
                expect(person.tokens.ownerSignInEligible(world.hostId)).toBe(
                  true,
                ),
              );
            }
            world.mint.respond(mint);
            if (mint !== "unavailable")
              await whenPublishedInProcess(person, world);
            invitation.settle();
            expectEnding(await run, ending);
          }
          expect(opensSeen()).toEqual(ending.opens);
          expect(unary.requests).toEqual([]);
          expect(await recordOfKey()).toEqual({ kind: "absent" });
        } finally {
          person.dispose();
        }
        await rerunCreatesExactlyOnce();
      } finally {
        invitation.settle();
        world.mint.respond("unavailable");
        await run.catch(() => undefined);
      }
    }, 30_000);
  },
);

function expectEnding(ended: Ended, ending: Ending): void {
  const error = errorOf(ended);
  expect(error).toMatchObject({
    code: ending.code,
    message: ending.message,
    exitCode: 1,
  });
  expect(printedLine(error)).toBe(
    `error: ${ending.message} [code=${ending.code}]`,
  );
}
