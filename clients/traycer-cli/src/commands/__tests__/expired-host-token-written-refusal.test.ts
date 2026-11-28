import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import {
  RetryEpisodeOutcomeUnknownError,
  finalRefusalOf,
} from "@traycer-clients/shared/host-transport/retrying-messenger";
import {
  ANSWERS_AT_ONCE,
  FRESH_HOST_TOKEN,
  STORED_SIGN_IN,
  deferred,
  heldEndingIn,
  openWorld,
  personOf,
  type DoorScript,
  type HomeRef,
  type World,
} from "./expired-host-token-harness";
import { UnaryDoor } from "./expired-host-token-unary-door";
import {
  BOT_ID_A,
  CONVERSATION_ID,
  botRecord,
  conversationRecord,
} from "./bot-test-support";
import { buildBotPostCommand } from "../bot-post";
import { CliError } from "../../runner/errors";
import { liveUnary } from "./expired-host-token-seams";
import { config } from "../../config";
import {
  observeAttemptRecoveryEvidence,
  type AttemptRecoveryEvidenceObservation,
} from "../../host/update-recovery-evidence";
import { hostHomeDir } from "../../store/paths";
import {
  PLAIN_DISPATCH,
  callHostRpcWithDispatch,
  hostRpcToCliError,
  hostRpcWroteNoRequest,
} from "../../internal/host-rpc";
import { isRefusalAfterRejectedSignIn } from "../../internal/sign-in-rejection";
import type { CliSignInHandle } from "../../internal/cli-host-tokens";

/**
 * A call that wrote a request frame keeps its error as the client threw it,
 * with only the gate's sign-in judgement added: when the host's typed
 * `UNAUTHORIZED` follows the request and the refresh of the stored sign-in is
 * rejected, the refusal is marked as one that followed a rejected sign-in,
 * whether or not a mint refusal was reported meanwhile. The judgement is one
 * adopting read and a synchronous read of recorded facts: it never waits for a
 * refresh that is not answered.
 */

const home = vi.hoisted((): HomeRef => ({ path: null }));
/** Every error the call's messenger ended a request with, in order. */
const messengerEnded = vi.hoisted((): { errors: unknown[] } => ({
  errors: [],
}));

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
vi.mock(
  "../../../../shared/host-transport/retrying-messenger",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../shared/host-transport/retrying-messenger")
      >();
    return {
      ...actual,
      createRetryingMessenger: (
        ...args: Parameters<typeof actual.createRetryingMessenger>
      ) => {
        const real = actual.createRetryingMessenger(...args);
        const kept = <Result>(run: () => Promise<Result>): Promise<Result> =>
          run().catch((error: unknown) => {
            messengerEnded.errors.push(error);
            throw error;
          });
        return {
          request: (...call: Parameters<typeof real.request>) =>
            kept(() => real.request(...call)),
          requestWithResponseTimeout: (
            ...call: Parameters<typeof real.requestWithResponseTimeout>
          ) => kept(() => real.requestWithResponseTimeout(...call)),
        };
      },
    };
  },
);

let world: World;
let unary: UnaryDoor;

beforeEach(async () => {
  vi.stubEnv("TRAYCER_AGENT_ID", "");
  vi.stubEnv("TRAYCER_EPIC_ID", "");
  messengerEnded.errors.length = 0;
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

const CREATE_LIKE = {
  ...PLAIN_DISPATCH,
  failFast: true,
  reauthenticate: "before-request",
  idempotencyKey: "task-1",
} as const;

const ADMITTED_AFTER = (admission: Promise<void>): DoorScript => ({
  answer: "admit",
  after: admission,
});

/**
 * The stored sign-in goes after a released host's answer to the probe: the
 * probe, then the sign-in. It does not wait for the running mint, so the
 * mint's refusal can be reported while it is on the wire (the sign-in a
 * current host invites goes only once that mint has bought nothing).
 */
const RELEASED_SIGN_IN_OPENS = [NO_HOST_TOKEN_PROBE, STORED_SIGN_IN];

async function whenMintRefusalReported(person: CliSignInHandle): Promise<void> {
  await vi.waitFor(async () =>
    expect(
      await person.tokens.refusalEndingCommandNow(world.hostId),
    ).not.toBeNull(),
  );
}

function callWithoutHeldToken(): Promise<unknown> {
  return callHostRpcWithDispatch("bot.list", {}, CREATE_LIKE).then(
    () => undefined,
    (error: unknown) => error,
  );
}

/**
 * A released host admits the person's sign-in once the test lets it, reads the
 * request, and ends the call with a typed `UNAUTHORIZED` (`token_expired`).
 * The mint's refusal is reported to the process before the request is read.
 */
async function reportedMintRefusalCase<Result>(
  start: () => Promise<Result>,
): Promise<Result> {
  const admission = deferred();
  unary.probe = ANSWERS_AT_ONCE("released");
  unary.signIn = ADMITTED_AFTER(admission.promise);
  unary.cutAfterRequest = () => "token-expired";
  const run = start();
  try {
    await unary.whenOpenedAs(RELEASED_SIGN_IN_OPENS);
    expect(unary.opens).toHaveLength(RELEASED_SIGN_IN_OPENS.length);
    const person = await personOf(world);
    try {
      world.mint.respond("sign-in-rejected");
      await whenMintRefusalReported(person);
      expect(unary.requests).toEqual([]);
      admission.settle();
      return await run;
    } finally {
      person.dispose();
    }
  } finally {
    admission.settle();
    await run.catch(() => undefined);
  }
}

/**
 * A held token that has not ended, and a sign-in this process already knows
 * authn rejected (its refresh was refused before the call began): no mint
 * refusal is reported to the call, and the host admits the held token, reads
 * the request and answers it with a typed `UNAUTHORIZED`.
 */
async function knownRejectionCase<Result>(
  start: () => Promise<Result>,
): Promise<Result> {
  await world.close();
  world = await openWorld(home, heldEndingIn(30 * 60 * 1000));
  unary = new UnaryDoor(world.mint, world.expiredHeld);
  liveUnary.door = unary;
  unary.expired = ANSWERS_AT_ONCE("admit");
  unary.cutAfterRequest = () => "token-expired";
  const person = await personOf(world);
  try {
    expect(await person.tokens.refreshSignIn()).toBe("rejected");
    expect(world.mint.refreshes).toBe(1);
    // Nothing the call's observer is told: the refusal is not a report to it.
    expect(
      await person.tokens.refusalEndingCommandNow(world.hostId),
    ).toBeNull();
    return await start();
  } finally {
    person.dispose();
  }
}

function expectWrittenOnSocket(index: number, openTokens: unknown[]): void {
  expect(unary.opens.map((open) => open.token)).toEqual(openTokens);
  expect(unary.requests).toEqual([{ index, method: "bot.list" }]);
}

/** What the call threw is the object its messenger ended the request with. */
function expectSameObjectAsClient(thrown: unknown): void {
  expect(messengerEnded.errors).toHaveLength(1);
  expect(thrown).toBe(messengerEnded.errors[0]);
  expect(hostRpcWroteNoRequest(thrown)).toBe(false);
}

/** The stored-credential line, written out. */
const STORED_CREDENTIAL_LINE =
  "The stored credential was rejected. Run `traycer login` to re-authenticate.";

function expectStoredCredentialLine(thrown: unknown): void {
  expect(isRefusalAfterRejectedSignIn(finalRefusalOf(thrown))).toBe(true);
  expect(hostRpcToCliError(thrown)).toMatchObject({
    message: STORED_CREDENTIAL_LINE,
    exitCode: 1,
  });
}

describe("a request written, then the host's typed UNAUTHORIZED, the sign-in rejected by authn", () => {
  it("a: no mint refusal reported to the call: leaves as the client's own error object, marked as following a rejected sign-in, with the stored credential's line", async () => {
    const thrown = await knownRejectionCase(callWithoutHeldToken);
    expectWrittenOnSocket(0, [world.expiredHeld]);
    expectSameObjectAsClient(thrown);
    expectStoredCredentialLine(thrown);
  }, 30_000);

  it("b: a mint refusal reported meanwhile: the same, and the refresh was asked", async () => {
    const thrown = await reportedMintRefusalCase(callWithoutHeldToken);
    expectWrittenOnSocket(1, RELEASED_SIGN_IN_OPENS);
    expect(world.mint.refreshes).toBeGreaterThan(0);
    expectSameObjectAsClient(thrown);
    expectStoredCredentialLine(thrown);
  }, 30_000);
});

describe("the updater's host.status, through update-recovery-evidence's real evidence function", () => {
  const read = (): Promise<AttemptRecoveryEvidenceObservation> =>
    observeAttemptRecoveryEvidence(
      config.environment,
      hostHomeDir(config.environment),
      "version-only",
    );

  it("c: written, a typed UNAUTHORIZED, the sign-in known rejected: the diagnosis is sign-in-rejected", async () => {
    const observation = await knownRejectionCase(read);
    expect(unary.requests.map((request) => request.method)).toContain(
      "host.status",
    );
    expect(observation.runningDiagnosis).toBe("sign-in-rejected");
  }, 60_000);
});

describe("the bound of the written path's judgement", () => {
  it("e: a refresh that is never answered is not waited for: the error leaves unannotated, with the door's own line, at once", async () => {
    await world.close();
    world = await openWorld(home, heldEndingIn(30 * 60 * 1000));
    unary = new UnaryDoor(world.mint, world.expiredHeld);
    liveUnary.door = unary;
    unary.expired = ANSWERS_AT_ONCE("admit");
    unary.cutAfterRequest = () => "token-expired";
    const releaseRefreshes = world.mint.holdRefreshes();
    const person = await personOf(world);
    let refreshAnswered = false;
    try {
      // The sign-in's refresh is on the wire, and authn does not answer it.
      const refreshing = person.tokens.refreshSignIn().then((rotation) => {
        refreshAnswered = true;
        return rotation;
      });
      await vi.waitFor(() => expect(world.mint.refreshes).toBe(1));
      const startedAt = Date.now();
      const thrown = await callWithoutHeldToken();
      const tookMs = Date.now() - startedAt;
      expectWrittenOnSocket(0, [world.expiredHeld]);
      expectSameObjectAsClient(thrown);
      // The call ended with the refresh still unanswered: the judgement read
      // recorded facts, and waited for nothing.
      expect(refreshAnswered).toBe(false);
      expect(tookMs).toBeLessThan(2_000);
      expect(isRefusalAfterRejectedSignIn(finalRefusalOf(thrown))).toBe(false);
      const line = hostRpcToCliError(thrown) as { message: string };
      expect(line.message).toBe("door refused: token-expired");
      releaseRefreshes();
      expect(await refreshing).toBe("rejected");
    } finally {
      releaseRefreshes();
      person.dispose();
    }
  }, 30_000);
});

describe("known limit (g) on bot post: the send written and its reply lost, then the resend refused at the door", () => {
  it("says an earlier attempt may have reached the host, with the later refusal's mint answer reported and changing nothing", async () => {
    await world.close();
    world = await openWorld(home, heldEndingIn(30 * 60 * 1000));
    unary = new UnaryDoor(world.mint, world.expiredHeld);
    liveUnary.door = unary;
    unary.expired = ANSWERS_AT_ONCE("admit");
    unary.serve = (method) => {
      if (method === "bot.list")
        return {
          bots: [botRecord({ boundHostId: world.hostId })],
          mainBotIds: null,
        };
      if (method === "bot.conversation.list")
        return {
          conversations: [
            conversationRecord({ conversationId: CONVERSATION_ID }),
          ],
        };
      throw new Error(`unexpected host RPC ${method}`);
    };
    // The send is read, and its token's end passes before the reply.
    unary.cutAfterRequest = (method) =>
      method === "bot.conversation.send" ? "token-expired" : null;
    // The recovery's mint is answered; the resend's open waits for the case.
    world.mint.respond("ok");
    const refusal = deferred();
    unary.openAt.set(3, { answer: "not-admitted", after: refusal.promise });
    const run = buildBotPostCommand({
      bot: BOT_ID_A,
      text: "ship it",
      wait: null,
    })(world.ctx).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      const held = world.expiredHeld;
      await unary.whenOpenedAs([held, held, held, FRESH_HOST_TOKEN]);
      const person = await personOf(world);
      try {
        // From here authn says the person is not a member.
        world.mint.respond("not-a-member");
        refusal.settle();
        const thrown = await run;

        // The refusal was reported: it would end a command that wrote nothing.
        expect(world.mint.requests).toHaveLength(2);
        expect(
          await person.tokens.refusalEndingCommandNow(world.hostId),
        ).toMatchObject({ failure: { kind: "not-a-member" } });
        expect(messengerEnded.errors).toHaveLength(1);
        expect(messengerEnded.errors[0]).toBeInstanceOf(
          RetryEpisodeOutcomeUnknownError,
        );
        if (!(thrown instanceof CliError))
          expect.fail("the command did not end with its own line");
        expect({
          code: thrown.code,
          exitCode: thrown.exitCode,
          message: thrown.message,
        }).toEqual({
          code: "E_AUTH_REJECTED",
          exitCode: 1,
          message:
            "door refused: not-admitted An earlier attempt may have gone through. Check before repeating it.",
        });
        expect(unary.requests).toEqual([
          { index: 0, method: "bot.list" },
          { index: 1, method: "bot.conversation.list" },
          { index: 2, method: "bot.conversation.send" },
        ]);
        expect(unary.opens).toHaveLength(4);
      } finally {
        person.dispose();
      }
    } finally {
      refusal.settle();
      await run;
    }
  }, 30_000);
});
