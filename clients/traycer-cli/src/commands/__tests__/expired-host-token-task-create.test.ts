import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import {
  ANSWERS_AT_ONCE,
  FRESH_HOST_TOKEN,
  STORED_SIGN_IN,
  deferred,
  openWorld,
  personOf,
  startNewProcess,
  whenPublishedInProcess,
  type HomeRef,
  type World,
} from "./expired-host-token-harness";
import { UnaryDoor } from "./expired-host-token-unary-door";
import { liveUnary } from "./expired-host-token-seams";
import { buildTaskCreateCommand } from "../task-create";
import { config } from "../../config";
import { createOutput } from "../../runner/output";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import { storedCredentialRejectedCliError } from "../../internal/host-door-words";
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

const MAY_HAVE_BEEN_CREATED = /may have been created/;

describe("task create, signed in as an account that is not this computer's owner", () => {
  // The invitation comes before the mint's answer is published: the person's
  // sign-in goes to the door, which refuses it `not_admitted`.
  it("the host's invitation comes before the mint's answer is published: the probe, then the person's sign-in, which the door refuses", async () => {
    const invitation = deferred();
    unary.probe = { answer: "owner-sign-in", after: invitation.promise };
    const run = runTaskCreate(null);
    await unary.whenOpened(0);
    invitation.settle();
    const ended = await run;
    world.mint.respond("not-admitted");
    // The line the door's refusal of the person's sign-in prints, and its exit code.
    expect(errorOf(ended)).toMatchObject({
      code: "E_AUTH_REJECTED",
      exitCode: 1,
      message: "door refused: not-admitted",
    });
    expect(unary.opens.map((open) => open.token)).toEqual([
      NO_HOST_TOKEN_PROBE,
      STORED_SIGN_IN,
    ]);
    expect(unary.requests).toEqual([]);
  }, 20_000);

  // The invitation comes after the mint's `not-admitted` is published: the
  // sign-in does not go. No request frame was written, and the ending says so.
  it("the host's invitation comes after the mint's answer is published: only the probe is on the wire, and nothing was created", async () => {
    const invitation = deferred();
    unary.probe = { answer: "owner-sign-in", after: invitation.promise };
    const run = runTaskCreate(null);
    await unary.whenOpened(0);
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
      expect(error.message).not.toMatch(MAY_HAVE_BEEN_CREATED);
      expect(error).toMatchObject({
        code: CLI_ERROR_CODES.FORBIDDEN,
        message: "",
        exitCode: 1,
      });
      expect(printedLine(error)).toBe(
        `error:  [code=${CLI_ERROR_CODES.FORBIDDEN}]`,
      );
    } finally {
      person.dispose();
    }
  }, 20_000);
});

type MintAnswerHere = "not-admitted" | "sign-in-rejected" | "unavailable";

/** What the call ends with, for the wire the scenario leaves. */
interface Ending {
  readonly code: string;
  readonly message: string;
  /** The tokens the door read, by open: the held token, the probe, the sign-in. */
  readonly opens: readonly ("held" | "probe" | "sign-in")[];
}

const DOOR_REFUSED_SIGN_IN: Ending["code"] = CLI_ERROR_CODES.AUTH_REJECTED;
const stored = storedCredentialRejectedCliError();

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
const NO_REQUEST_CASES: readonly {
  readonly scenario:
    | "the probe alone"
    | "the probe, then a refused sign-in"
    | "a redial";
  readonly mint: MintAnswerHere;
  readonly ending: Ending;
}[] = [
  {
    scenario: "the probe alone",
    mint: "not-admitted",
    ending: { code: CLI_ERROR_CODES.FORBIDDEN, message: "", opens: ["probe"] },
  },
  {
    scenario: "the probe alone",
    mint: "sign-in-rejected",
    ending: { code: stored.code, message: stored.message, opens: ["probe"] },
  },
  ...(["not-admitted", "sign-in-rejected", "unavailable"] as const).map(
    (mint) => ({
      scenario: "the probe, then a refused sign-in" as const,
      mint,
      ending: {
        code: DOOR_REFUSED_SIGN_IN,
        message: "door refused: not-admitted",
        opens: ["probe", "sign-in"] as const,
      },
    }),
  ),
  {
    scenario: "a redial",
    mint: "not-admitted",
    ending: {
      code: CLI_ERROR_CODES.FORBIDDEN,
      message: "",
      opens: ["held", "probe"],
    },
  },
  {
    scenario: "a redial",
    mint: "sign-in-rejected",
    ending: {
      code: stored.code,
      message: stored.message,
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
      await unary.whenOpened(0);
      const person = await personOf(world);
      try {
        if (scenario === "the probe, then a refused sign-in") {
          // The invitation comes while the mint's answer is not published (or,
          // for `unavailable`, whatever it is: that answer lets the sign-in go).
          if (mint === "unavailable") world.mint.respond(mint);
          invitation.settle();
          const ended = await run;
          if (mint !== "unavailable") world.mint.respond(mint);
          expectEnding(ended, ending);
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
    }, 30_000);
  },
);

function expectEnding(ended: Ended, ending: Ending): void {
  const error = errorOf(ended);
  expect(error.message).not.toMatch(MAY_HAVE_BEEN_CREATED);
  expect(error).toMatchObject({
    code: ending.code,
    message: ending.message,
    exitCode: 1,
  });
  expect(printedLine(error)).toBe(
    `error: ${ending.message} [code=${ending.code}]`,
  );
}
