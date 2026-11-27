import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeJsonFileAtomic } from "@traycer/protocol/config/credentials-fs";
import {
  readCredentialsFile,
  type StoredCredentials,
} from "@traycer/protocol/config/credentials";
import { isCredentialsReserveComplete } from "@traycer/protocol/config/credentials-reserve";
import { cliCredentialsPath } from "@traycer/protocol/config/paths";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import { STREAM_CAPABILITY_CREDENTIAL_UPDATE } from "@traycer/protocol/framework/stream-ws-protocol";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { createHostTokenFilePersistence } from "@traycer-clients/shared/auth/host-token-file";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import type { WsStreamClient } from "../../../../shared/host-transport/ws-stream-client";
import { createWhatwgStreamWebSocketFactory } from "../../../../shared/host-transport/whatwg-stream-ws-factory";
import { CLI_CLIENT_IDENTITY } from "../../cli-version";
import { config } from "../../config";
import {
  acquireCliSignIn,
  requireCliHostSession,
  type CliHostSession,
} from "../../internal/cli-host-tokens";
import { nextCasePerson } from "../../internal/__tests__/case-person-test-support";
import { resolveHostAuth } from "../../internal/host-auth";
import {
  olderHostCliError,
  refusalEndingCliError,
  signedOutCliError,
} from "../../internal/host-door-words";
import {
  callHostRpcAtEndpoint,
  callHostRpcAtResolvedEndpoint,
  PLAIN_DISPATCH,
} from "../../internal/host-rpc";
import {
  runLocalStream,
  type LocalStreamDial,
} from "../../internal/local-stream";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import { CliError } from "../../runner/errors";
import { createCliCredentialsStore } from "../../store/credentials-store";
import { buildBotPostCommand } from "../bot-post";
import { BOT_ID_A } from "./bot-test-support";
import {
  ANSWERS_AT_ONCE,
  FRESH_HOST_TOKEN,
  STORED_SIGN_IN,
  claimsOf,
  deferred,
  jwtToken,
  heldEndingIn,
  openWorld,
  prepareHostFor,
  settle,
  type HeldToken,
  type HomeRef,
  type MintAnswer,
  type Outcome,
  type Reading,
  type World,
} from "./expired-host-token-harness";
import { BOT_CHECKINS, BOT_POST_LISTENER } from "./expired-host-token-members";
import { liveUnary, loggedLines, seams } from "./expired-host-token-seams";
import { UnaryDoor } from "./expired-host-token-unary-door";

/**
 * The renewal of a held host-only token before its end: a command or request
 * still in flight when that token ends. The commands, `callHostRpc` and
 * `runLocalStream` are the real ones, on the fake host's doors; authn answers
 * at its HTTP edge.
 *
 * The ordering table, one line per row and the test that pins it:
 *
 *  1  The timer fires and the renewal succeeds: push, and arm again on the new
 *     end.
 *     -> "with the timer firing $firing, pushes the renewed token and arms
 *        again on the new end"
 *  2  The timer fires and the renewal is refused or fails: no push, no new
 *     timer, and no command listener is told.
 *     -> "a renewal authn answers $answer pushes nothing, arms no more, and
 *        does not end the read"
 *  3  The renewal answers after the old end: nothing is pushed to a settled
 *     dial.
 *     -> "pushes nothing to a dial that ended at the old end before authn
 *        answered"
 *  6  The command settles while the timer is armed: no mint and no push after.
 *     -> "clears the armed timer when the command settles: nothing is minted or
 *        pushed after"
 *  9  Another program saved a newer token, which this process has not read: the
 *     timer sends one mint, the write keeps the later-issued of the saved and
 *     the minted token, and that one is pushed and armed on.
 *     -> "after another program's save, mints once, then pushes and arms on the
 *        later-issued token the write keeps: $kept"
 * 11  A timer renewal and a bearer read in the same window: one mint.
 *     -> "shares one mint between the timer's renewal and a bearer read while it
 *        is out"
 * 12  A unary call whose held token ends within the lead: one fresh mint before
 *     the request, which presents the new token; with the mint failing or
 *     unreachable, the request goes on the held token and no gate ends it.
 *     -> "asks once before the request, and the request presents the new token"
 *     -> "sends on the held token when authn answers $answer, and nothing ends
 *        the call"
 * 15  `bot post --wait` counts a renewal before the dial against the person's
 *     wait.
 *     -> "ends at the person's wait, with no dial, while the renewal before it
 *        is out"
 * 17  A renewed token that still ends within the lead: one sign-in refresh, one
 *     more mint, no loop.
 *     -> "before a unary call: refreshes the sign-in once, mints once more,
 *        sends on that token, and no later call waits on it"
 *     -> "on an open stream: refreshes the sign-in once, mints once more, and
 *        does not ask again"
 *
 * Which calls wait. The process keeps, for a host process and a person, the
 * held token a call has waited to renew:
 *
 *  S1  The first call on a due token marks it and waits.
 *      -> "asks once before the request, and the request presents the new token"
 *      -> "while a renewal is out, a second call does not wait for it"
 *  S2  A later token is not marked: the first call on it waits, once.
 *      -> "waits again, once, when the token a renewal bought comes within the
 *         lead"
 *  S3  A token still due after a renewal is marked: no call waits on it.
 *      -> "before a unary call: refreshes the sign-in once, ... and no later
 *         call waits on it"
 *  S4  A failed renewal keeps the mark.
 *      -> "in an outage, a second call within the lead sends no mint and does
 *         not wait"
 *  S6  Another person is not affected by the mark.
 *      -> "keeps one person's waited renewal from another person's call in the
 *         same process"
 *  S7  Another program's save changes the token: the first call on the saved
 *      one waits, once. A sign-out is not driven.
 *      -> "waits, once, on a still-due token another program saved after a
 *         waited renewal"
 *  S9  The mark outlives the handle that set it: each call here ends its own.
 *      -> "in an outage, a second call within the lead sends no mint and does
 *         not wait"
 *  S10 The stream's timer is not held back by the mark.
 *      -> "is still renewed by the stream's timer, and the new token pushed"
 */

/** How long before its end a held token is renewed. */
const LEAD_MS = 120_000;
/** A held token this far from its end is not renewed before the dial. */
const OPEN_BEYOND_LEAD_MS = 130_000;
/** A held token this far from its end is usable, and within the lead. */
const WITHIN_LEAD_MS = 60_000;
/** A held token this far from its end is asked no renewal while a case runs. */
const BEYOND_THE_CASE_MS = 600_000;
/** Longer than any command's own limit on its wait or read in these cases. */
const PAST_EVERY_LIMIT_MS = 120_000;
/**
 * How long after {@link takeTheClockBefore} the lead before the held token's
 * end comes: no other timer of a dial or a read is armed for a span near it.
 */
const UNTIL_THE_LEAD_MS = 14_000;
/**
 * Well past a retry of a renewal, and no longer: a case's renewal comes
 * {@link UNTIL_THE_LEAD_MS} after the clock is taken, and this long after that
 * a `bot checkins` read is 6 s short of its own 35 s deadline. That deadline
 * ends the read long before the token's end.
 */
const PAST_A_RETRY_MS = 15_000;
/** The stream client's wait before its first reconnect. */
const RECONNECT_BACKOFF_MS = 500;
const TIMEOUT = 20_000;
const REFRESHED_SIGN_IN = "refreshed-sign-in";

const home = vi.hoisted((): HomeRef => ({ path: null }));
/** What the case saw of the production code's own calls. */
const observed = vi.hoisted(() => ({
  /** Every renewal asked through a session's `tokens`: the stream's timer. */
  timerRenewals: [] as Promise<number | null>[],
  /** Every host session a command or call opened. */
  sessions: [] as CliHostSession[],
}));
/** Every request that reached authn, by its route: a mint, a refresh or other. */
const askedAuthn: string[] = [];

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.path ?? actual.homedir() };
});
vi.mock("../../logger", async () =>
  (await import("./expired-host-token-seams")).loggerModule(),
);
// The real tokens. A session's `renew` is also recorded, so a case can await
// the very renewal the stream's timer started.
vi.mock("../../internal/cli-host-tokens", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/cli-host-tokens")>();
  const recording: typeof actual.requireCliHostSession = async (
    auth,
    hostId,
    signal,
  ) => {
    const opened = await actual.requireCliHostSession(auth, hostId, signal);
    const session: CliHostSession = {
      ...opened,
      tokens: {
        ...opened.tokens,
        renew: (renewedHostId) => {
          const renewal = opened.tokens.renew(renewedHostId);
          observed.timerRenewals.push(renewal);
          return renewal;
        },
      },
    };
    observed.sessions.push(session);
    return session;
  };
  return { ...actual, requireCliHostSession: recording };
});
vi.mock("../../internal/host-rpc", async (importOriginal) =>
  (await import("./expired-host-token-seams")).hostRpcModule(
    await importOriginal<typeof import("../../internal/host-rpc")>(),
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

let opened: World | null = null;

beforeEach(() => {
  observed.timerRenewals.length = 0;
  observed.sessions.length = 0;
  askedAuthn.length = 0;
  loggedLines.length = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  liveUnary.door = null;
  const world = opened;
  opened = null;
  if (world !== null) await world.close();
});

async function useWorld(held: HeldToken | "none"): Promise<World> {
  const world = await openWorld(home, held);
  opened = world;
  await fillCredentialsReserve();
  // The held token is usable: the host admits it.
  world.host.expired = ANSWERS_AT_ONCE("admit");
  world.host.capabilities = [STREAM_CAPABILITY_CREDENTIAL_UPDATE];
  recordAuthnRequests();
  return world;
}

function recordAuthnRequests(): void {
  const authn = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init: RequestInit | undefined) => {
      const url = new URL(input instanceof Request ? input.url : input);
      askedAuthn.push(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
      return authn(input, init);
    },
  );
}

/**
 * The one authn request of a case that drops a save: the mint whose answer the
 * save was of. Nothing is asked once the person has left the file.
 */
const ONLY_THE_DROPPED_SAVES_MINT = ["session-grant"];

/**
 * Lets a credentials store fill its disk reserve, which it does in the
 * background under the credentials lock. Left to a case's own stores, a save
 * could meet that lock and wait on a retry timer for as long as the disk takes.
 */
async function fillCredentialsReserve(): Promise<void> {
  const path = madeUpCredentialsPath();
  const store = createCliCredentialsStore();
  try {
    await vi.waitFor(
      async () => {
        expect(await isCredentialsReserveComplete(path)).toBe(true);
        expect(existsSync(`${path}.lock`)).toBe(false);
      },
      { timeout: 10_000 },
    );
  } finally {
    store.dispose();
  }
}

/** From here the clock moves only when the case moves it. */
function takeTheClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

/**
 * {@link takeTheClock}, at {@link UNTIL_THE_LEAD_MS} before the lead before
 * `held`'s recorded end: the case's renewal then comes as long after this as in
 * every other run, however long the set-up took.
 */
function takeTheClockBefore(held: HeldToken): void {
  takeTheClock();
  vi.setSystemTime(held.expiresAtMs - LEAD_MS - UNTIL_THE_LEAD_MS);
}

/**
 * {@link takeTheClock}, with `leftMs` left before `held`'s recorded end: the
 * case's calls find that much of the token in every run, however long the
 * set-up took.
 */
function takeTheClockWithLeft(held: HeldToken, leftMs: number): void {
  takeTheClock();
  vi.setSystemTime(held.expiresAtMs - leftMs);
}

/** The source file that asked for the timer being armed. */
function armingFile(): string {
  const frame = (new Error().stack ?? "")
    .split("\n")
    .find((line) => !/node_modules|__tests__/.test(line) && /\.ts:/.test(line));
  return /([\w.-]+\.ts):/.exec(frame ?? "")?.[1] ?? "no source file";
}

/**
 * From here, who arms each timer under the taken clock, whatever its span. An
 * authn request's own limit (`request-abort.ts`) is left out.
 */
function watchArming(): {
  /** Those since the last take. */
  readonly take: () => readonly string[];
  readonly restore: () => void;
} {
  const armed: string[] = [];
  const arm = globalThis.setTimeout;
  const spy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((...args) => {
      const by = armingFile();
      if (by !== "request-abort.ts") armed.push(by);
      return arm(...args);
    });
  return {
    take: () => armed.splice(0),
    restore: () => spy.mockRestore(),
  };
}

/** One turn of the event loop, which a faked clock does not hold back. */
function oneTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Takes turns until `reached`, with the taken clock held where it is: what the
 * real work in between takes is charged to no deadline of the code under test.
 * A case that needs one of that code's timers moves the clock by its span. Five
 * real seconds end a wait that does not come about.
 */
async function turnsUntil(what: string, reached: () => boolean): Promise<void> {
  const giveUpAt = performance.now() + 5_000;
  while (!reached()) {
    if (performance.now() > giveUpAt) throw new Error(`never saw ${what}`);
    await oneTurn();
  }
}

/** `work`'s own answer, awaited under the taken clock. */
async function whenDone<T>(what: string, work: Promise<T>): Promise<T> {
  let done = false;
  const settling = work.finally(() => {
    done = true;
  });
  settling.catch(() => undefined);
  await turnsUntil(what, () => done);
  return settling;
}

/**
 * {@link turnsUntil} `reached`, what is seen from outside of the started
 * `work`. `work` is observed from here, so no rejection of it goes unhandled.
 * A wait that `work`'s end cut short fails with `work`'s own error or answer.
 */
async function untilWhileRunning(
  what: string,
  work: Promise<unknown>,
  reached: () => boolean,
): Promise<void> {
  const ran: {
    end:
      | { readonly threw: false; readonly answer: unknown }
      | { readonly threw: true; readonly error: unknown }
      | null;
  } = { end: null };
  work.then(
    (answer) => {
      ran.end = { threw: false, answer };
    },
    (error: unknown) => {
      ran.end = { threw: true, error };
    },
  );
  await turnsUntil(what, () => reached() || ran.end !== null);
  if (reached()) return;
  if (ran.end?.threw === true) throw ran.end.error;
  throw new Error(
    `ended before ${what}, answering ${JSON.stringify(ran.end?.answer)}`,
  );
}

/** The time left until the lead before `endMs`: what the timer is armed for. */
function untilLeadBefore(endMs: number): number {
  return endMs - LEAD_MS - Date.now();
}

/**
 * Runs the timer armed for the lead before `endMs`, `lateMs` late by the wall
 * clock (negative: early, as a real timer can be). Rows other than 1 pass 1,
 * so what they pin does not rest on a firing on or before the very
 * millisecond, which row 1 pins.
 */
async function fireRenewalTimer(endMs: number, lateMs: number): Promise<void> {
  const armedFor = untilLeadBefore(endMs);
  vi.setSystemTime(Date.now() + lateMs);
  await vi.advanceTimersByTimeAsync(armedFor);
}

/** The renewal at `index` of those the timer started, once it has answered. */
function timerRenewal(index: number): Promise<number | null> {
  const renewal = observed.timerRenewals[index];
  if (renewal === undefined) throw new Error(`no timer renewal ${index}`);
  return whenDone(`timer renewal ${index}`, renewal);
}

/** The newest renewal the timer started, once it has answered. */
function lastTimerRenewal(): Promise<number | null> {
  return timerRenewal(observed.timerRenewals.length - 1);
}

/**
 * Runs the renewal due at the lead before `endMs`, with the timer firing
 * `lateMs` off the wall clock: one that came before the token was due is armed
 * again, and that firing is within these 5 ms.
 */
async function renewalDueBefore(endMs: number, lateMs: number): Promise<void> {
  await fireRenewalTimer(endMs, lateMs);
  await vi.advanceTimersByTimeAsync(5);
  await timerRenewalsDone();
}

/** Every renewal the timer has started so far has answered. */
function timerRenewalsDone(): Promise<unknown> {
  return whenDone("the timer's renewals", Promise.all(observed.timerRenewals));
}

/**
 * A host-only token whose mint answer, given now, reads as ending `ms` from
 * now (the receipt reads 5 s past the signed end), issued `issuedAgoMs` ago.
 */
function mintedEndingIn(tag: string, ms: number, issuedAgoMs: number): string {
  return jwtToken({
    tag,
    iatSec: Math.floor((Date.now() - issuedAgoMs) / 1000),
    expSec: Math.floor((Date.now() + ms - 5_000) / 1000),
  });
}

/**
 * authn accepts the sign-in's refresh from here, and what it mints afterwards
 * is `next`. Counts the refreshes it accepted.
 */
function acceptRefresh(
  world: World,
  next: string,
): { readonly accepted: () => number } {
  const authn = globalThis.fetch;
  let accepted = 0;
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init: RequestInit | undefined) => {
      if (!String(input).endsWith("/auth/refresh")) return authn(input, init);
      accepted += 1;
      world.mint.issued = next;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            token: REFRESHED_SIGN_IN,
            refreshToken: "rt-refreshed",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  );
  return { accepted: () => accepted };
}

/** What each `credentialUpdate` the host read carried, and what it did. */
function pushed(world: World): readonly unknown[] {
  return world.host.updates.map(({ index, token, installed }) => ({
    index,
    token,
    installed,
  }));
}

interface RunningRead {
  readonly outcome: Promise<Outcome>;
  readonly settled: () => boolean;
  /** The host serves the read's snapshot, and the command completes. */
  readonly serve: () => void;
}

/** `bot checkins`, admitted on the held token, its snapshot not yet served. */
async function admittedRead(world: World): Promise<RunningRead> {
  prepareHostFor(BOT_CHECKINS, world);
  const serving = deferred();
  world.host.hold = serving.promise;
  let settled = false;
  try {
    const outcome = settle(BOT_CHECKINS.start(world)).finally(() => {
      settled = true;
    });
    await untilWhileRunning(
      "the read's subscribe",
      outcome,
      () => world.host.subscribes.length > 0,
    );
    return { outcome, settled: () => settled, serve: serving.settle };
  } catch (error) {
    serving.settle();
    throw error;
  }
}

/**
 * `runLocalStream` on a session the case keeps open after the dial ends, which
 * no command does: what a renewal does for an ended dial is then the dial's own
 * doing, not the disposed session's.
 */
function dialOn<T>(
  world: World,
  session: CliHostSession,
  run: (
    client: WsStreamClient<typeof hostStreamRpcRegistry>,
    dial: LocalStreamDial,
  ) => Promise<T>,
): Promise<T> {
  return runLocalStream({
    tokens: session.tokens,
    hostId: world.hostId,
    options: {
      registry: hostStreamRpcRegistry,
      endpoint: () => seams.endpoint,
      releasedSignOn: { ...session.releasedSignOn, recovery: null },
      userId: world.userId,
      clock: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: createWhatwgStreamWebSocketFactory(),
      dialTimeoutMs: 10_000,
      openAckTimeoutMs: 10_000,
      pingIntervalMs: 600_000,
      pongTimeoutMs: 600_000,
      initialBackoffMs: 500,
      maxBackoffMs: 30_000,
      clientIdentity: CLI_CLIENT_IDENTITY,
    },
    limit: {
      span: { kind: "from-first-dial", ms: 60_000 },
      ended: () => Promise.reject(new Error("the dial's limit passed")),
    },
    refused: (ending) => Promise.reject(refusalEndingCliError(ending)),
    run,
  });
}

async function liveSession(world: World): Promise<CliHostSession> {
  const auth = await resolveHostAuth();
  if (auth === null) throw new Error("the case is not signed in");
  return requireCliHostSession(auth, world.hostId, null);
}

describe("a stream still open as its held token nears its end", () => {
  it.each<{ readonly firing: string; readonly lateMs: number }>([
    { firing: "a millisecond late", lateMs: 1 },
    { firing: "on its millisecond", lateMs: 0 },
    { firing: "a millisecond early", lateMs: -1 },
  ])(
    "with the timer firing $firing, pushes the renewed token and arms again on the new end",
    async ({ lateMs }) => {
      const held = heldEndingIn(OPEN_BEYOND_LEAD_MS);
      const world = await useWorld(held);
      takeTheClockBefore(held);
      let read: RunningRead | null = null;
      try {
        read = await admittedRead(world);
        // Short of the lead by more than the firing can be early.
        await vi.advanceTimersByTimeAsync(
          untilLeadBefore(held.expiresAtMs) - 2,
        );
        expect(observed.timerRenewals).toHaveLength(0);
        expect(world.mint.requests).toHaveLength(0);

        // It ends soon enough for the case to reach its own renewal, and not
        // within the lead as it is answered.
        const second = mintedEndingIn("second", LEAD_MS + 8_000, 60_000);
        world.mint.issued = second;
        world.mint.respond("ok");
        await renewalDueBefore(held.expiresAtMs, lateMs);
        expect(world.mint.requests).toHaveLength(1);
        const secondEndMs = await lastTimerRenewal();
        if (secondEndMs === null) expect.fail("the renewal left no token");
        expect(secondEndMs).toBeGreaterThan(held.expiresAtMs);
        expect(pushed(world)).toEqual([
          { index: 0, token: second, installed: true },
        ]);

        await vi.advanceTimersByTimeAsync(untilLeadBefore(secondEndMs) - 2);
        expect(world.mint.requests).toHaveLength(1);
        world.mint.issued = FRESH_HOST_TOKEN;
        await renewalDueBefore(secondEndMs, lateMs);
        expect(world.mint.requests).toHaveLength(2);
        expect(pushed(world)).toEqual([
          { index: 0, token: second, installed: true },
          { index: 0, token: FRESH_HOST_TOKEN, installed: true },
        ]);

        // The host's watch now ends the stream at the last token's end: the
        // first token's end passes it by.
        world.host.watchReaches(0, held.expiresAtMs);
        expect(world.host.connections[0]?.cut).toBe(false);
        read.serve();
        BOT_CHECKINS.expectNormalResult(
          await whenDone("the command's end", read.outcome),
        );
        expect(world.host.opens).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        read?.serve();
        await read?.outcome.catch(() => undefined);
      }
    },
    TIMEOUT,
  );

  it.each<{ readonly answer: MintAnswer }>([
    { answer: "not-a-member" },
    { answer: "sign-in-rejected" },
    { answer: "unavailable" },
  ])(
    "a renewal authn answers $answer pushes nothing, arms no more, and does not end the read",
    async ({ answer }) => {
      const held = heldEndingIn(OPEN_BEYOND_LEAD_MS);
      const world = await useWorld(held);
      takeTheClockBefore(held);
      const arming = watchArming();
      let read: RunningRead | null = null;
      try {
        read = await admittedRead(world);
        // The admission arms the dial's one renewal timer.
        expect(
          arming.take().filter((by) => by === "local-stream.ts"),
        ).toHaveLength(1);
        world.mint.respond(answer);
        await fireRenewalTimer(held.expiresAtMs, 1);
        expect(observed.timerRenewals).toHaveLength(1);
        expect(await timerRenewal(0)).toBe(held.expiresAtMs);
        await vi.advanceTimersByTimeAsync(PAST_A_RETRY_MS);
        await timerRenewalsDone();
        // A told listener asks the gate, whose first step is this read of the
        // credentials file; one asked after it answers after it.
        const session = observed.sessions.at(-1);
        if (session === undefined) expect.fail("the read opened no session");
        await whenDone("the file read", session.tokens.adoptStoredSignIn());

        expect(observed.timerRenewals).toHaveLength(1);
        // Nor is a retry armed for later than the clock was moved.
        expect(arming.take()).toEqual([]);
        expect(world.mint.requests).toHaveLength(1);
        expect(world.host.updates).toEqual([]);
        expect(read.settled()).toBe(false);
        read.serve();
        BOT_CHECKINS.expectNormalResult(
          await whenDone("the command's end", read.outcome),
        );
        expect(world.host.opens.map((open) => open.token)).toEqual([
          world.expiredHeld,
        ]);
      } finally {
        arming.restore();
        vi.useRealTimers();
        read?.serve();
        await read?.outcome.catch(() => undefined);
      }
    },
    TIMEOUT,
  );

  it(
    "pushes nothing to a dial that ended at the old end before authn answered",
    async () => {
      const held = heldEndingIn(OPEN_BEYOND_LEAD_MS);
      const world = await useWorld(held);
      const session = await liveSession(world);
      takeTheClockBefore(held);
      let dialled: Promise<string> | null = null;
      try {
        dialled = dialOn(
          world,
          session,
          (client) =>
            new Promise<string>((resolve) => {
              client
                .subscribe("bot.subscribe", { botId: BOT_ID_A })
                .onStatusChange((status) => {
                  if (status === "closed") resolve("closed");
                });
            }),
        );
        await untilWhileRunning(
          "the subscribe",
          dialled,
          () => world.host.subscribes.length > 0,
        );
        await fireRenewalTimer(held.expiresAtMs, 1);
        expect(observed.timerRenewals).toHaveLength(1);
        await untilWhileRunning(
          "the mint",
          dialled,
          () => world.mint.requests.length > 0,
        );
        expect(world.mint.requests).toHaveLength(1);

        // The held token's end passes with authn silent: the host cuts the
        // stream, and the dial ends.
        vi.setSystemTime(held.expiresAtMs + 1_000);
        world.host.watchReaches(0, held.expiresAtMs);
        expect(await whenDone("the dial's end", dialled)).toBe("closed");
        world.mint.respond("ok");
        const renewedEndMs = await timerRenewal(0);
        if (renewedEndMs === null) expect.fail("the renewal left no token");
        expect(renewedEndMs).toBeGreaterThan(held.expiresAtMs);

        await vi.advanceTimersByTimeAsync(
          untilLeadBefore(renewedEndMs) + 1_000,
        );
        expect(world.host.updates).toEqual([]);
        expect(observed.timerRenewals).toHaveLength(1);
        expect(world.mint.requests).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        world.mint.respond("unavailable");
        world.host.watchReaches(0, held.expiresAtMs);
        await dialled?.catch(() => undefined);
        session.dispose();
      }
    },
    TIMEOUT,
  );

  it(
    "clears the armed timer when the command settles: nothing is minted or pushed after",
    async () => {
      const held = heldEndingIn(OPEN_BEYOND_LEAD_MS);
      const world = await useWorld(held);
      takeTheClockBefore(held);
      const arm = vi.spyOn(globalThis, "setTimeout");
      const clear = vi.spyOn(globalThis, "clearTimeout");
      let read: RunningRead | null = null;
      try {
        const untilTheLead = untilLeadBefore(held.expiresAtMs);
        read = await admittedRead(world);
        // Armed at the admission, which the set-up reaches within these. No
        // other timer of the dial or the read is armed for a span like it.
        const armed = arm.mock.calls.flatMap(([, delay], call) =>
          delay !== undefined &&
          delay <= untilTheLead &&
          delay > untilTheLead - 2_000
            ? [arm.mock.results[call]?.value]
            : [],
        );
        // One timer holds the process to the lead before the token's end.
        expect(armed).toHaveLength(1);

        read.serve();
        BOT_CHECKINS.expectNormalResult(
          await whenDone("the command's end", read.outcome),
        );
        expect(clear.mock.calls.map(([timer]) => timer)).toContain(armed[0]);
        await vi.advanceTimersByTimeAsync(OPEN_BEYOND_LEAD_MS);
        expect(observed.timerRenewals).toHaveLength(0);
        expect(world.mint.requests).toHaveLength(0);
        expect(world.host.updates).toEqual([]);
      } finally {
        arm.mockRestore();
        clear.mockRestore();
        vi.useRealTimers();
        read?.serve();
        await read?.outcome.catch(() => undefined);
      }
    },
    TIMEOUT,
  );

  it.each<{
    readonly kept: string;
    readonly savedIssuedAgoMs: number;
    readonly mintedIssuedAgoMs: number;
  }>([
    {
      kept: "the saved one",
      savedIssuedAgoMs: 20_000,
      mintedIssuedAgoMs: 40_000,
    },
    {
      kept: "the minted one",
      savedIssuedAgoMs: 40_000,
      mintedIssuedAgoMs: 20_000,
    },
  ])(
    "after another program's save, mints once, then pushes and arms on the later-issued token the write keeps: $kept",
    async ({ savedIssuedAgoMs, mintedIssuedAgoMs }) => {
      const held = heldEndingIn(OPEN_BEYOND_LEAD_MS);
      const world = await useWorld(held);
      takeTheClockBefore(held);
      let read: RunningRead | null = null;
      try {
        read = await admittedRead(world);
        // Short of the lead by more than the firing can be early.
        await vi.advanceTimersByTimeAsync(
          untilLeadBefore(held.expiresAtMs) - 2,
        );
        // Only the later-issued of the two ends soon enough for the case to
        // reach its renewal: a timer armed on the other one's end stays quiet.
        const savedIsLater = savedIssuedAgoMs < mintedIssuedAgoMs;
        const keptEndsInMs = LEAD_MS + 8_000;
        const saved = mintedEndingIn(
          "another-program",
          savedIsLater ? keptEndsInMs : 3_600_000,
          savedIssuedAgoMs,
        );
        const minted = mintedEndingIn(
          "own",
          savedIsLater ? 3_600_000 : keptEndsInMs,
          mintedIssuedAgoMs,
        );
        const kept = savedIsLater ? saved : minted;
        const keptSignedEndMs = (claimsOf(kept)?.expSec ?? 0) * 1000;
        // The desktop writes the shared file, as its own process would.
        await whenDone(
          "the other program's save",
          saveHostToken(world.userId, world.hostId, {
            token: saved,
            expiresAtMs: (claimsOf(saved)?.expSec ?? 0) * 1000 + 5_000,
          }),
        );
        world.mint.issued = minted;
        world.mint.respond("ok");
        await renewalDueBefore(held.expiresAtMs, 1);

        expect({
          mints: world.mint.requests.length,
          pushed: pushed(world),
        }).toEqual({
          mints: 1,
          pushed: [{ index: 0, token: kept, installed: true }],
        });
        const keptEndMs = await lastTimerRenewal();
        if (keptEndMs === null) expect.fail("the renewal left no token");
        const file = await whenDone(
          "the file's read",
          createHostTokenFilePersistence({
            environment: config.environment,
            lockWaitMs: 2_000,
            lockPollIntervalMs: 10,
          }).load(),
        );
        expect(file.get(world.userId)?.get(world.hostId)).toMatchObject({
          token: kept,
          expiresAtMs: keptEndMs,
        });

        // The host's watch is on the pushed token's end: the first token's end
        // passes it by.
        world.host.watchReaches(0, held.expiresAtMs);
        expect(world.host.connections[0]).toMatchObject({
          token: kept,
          endMs: keptSignedEndMs,
          cut: false,
        });
        // And so is the timer: it asks again at that end's lead, not before.
        await vi.advanceTimersByTimeAsync(untilLeadBefore(keptEndMs) - 2);
        expect(world.mint.requests).toHaveLength(1);
        const next = mintedEndingIn("next", 3_600_000, 0);
        world.mint.issued = next;
        await renewalDueBefore(keptEndMs, 1);
        expect(world.mint.requests).toHaveLength(2);
        expect(pushed(world)).toEqual([
          { index: 0, token: kept, installed: true },
          { index: 0, token: next, installed: true },
        ]);

        read.serve();
        BOT_CHECKINS.expectNormalResult(
          await whenDone("the command's end", read.outcome),
        );
      } finally {
        vi.useRealTimers();
        read?.serve();
        await read?.outcome.catch(() => undefined);
      }
    },
    TIMEOUT,
  );

  it(
    "shares one mint between the timer's renewal and a bearer read while it is out",
    async () => {
      const held = heldEndingIn(OPEN_BEYOND_LEAD_MS);
      const world = await useWorld(held);
      const session = await liveSession(world);
      takeTheClockBefore(held);
      const done = deferred();
      const stream: {
        client: WsStreamClient<typeof hostStreamRpcRegistry> | null;
      } = { client: null };
      let dialled: Promise<void> | null = null;
      try {
        dialled = dialOn(world, session, (client) => {
          stream.client = client;
          client.subscribe("bot.subscribe", { botId: BOT_ID_A });
          return done.promise;
        });
        await untilWhileRunning(
          "the subscribe",
          dialled,
          () => world.host.subscribes.length > 0,
        );
        await fireRenewalTimer(held.expiresAtMs, 1);
        expect(observed.timerRenewals).toHaveLength(1);
        await untilWhileRunning(
          "the mint",
          dialled,
          () => world.mint.requests.length > 0,
        );
        expect(world.mint.requests).toHaveLength(1);

        // A second stream on the client opens: its open reads the bearer.
        stream.client?.subscribe("bot.subscribe", { botId: BOT_ID_A });
        await untilWhileRunning(
          "the second subscribe",
          dialled,
          () => world.host.subscribes.length >= 2,
        );
        expect(world.host.subscribes).toHaveLength(2);
        expect(world.host.opens[1]).toMatchObject({
          token: world.expiredHeld,
          mintStillOut: true,
        });
        // Its admission arms the timer again, due at once: it joins too.
        await vi.advanceTimersByTimeAsync(0);
        await untilWhileRunning(
          "the second timer renewal",
          dialled,
          () => observed.timerRenewals.length >= 2,
        );
        expect(observed.timerRenewals).toHaveLength(2);
        world.mint.respond("ok");
        await timerRenewalsDone();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(world.mint.requests).toHaveLength(1);
        expect(
          new Set(
            world.host.updates.map(({ index, token }) => `${index} ${token}`),
          ),
        ).toEqual(new Set([`0 ${FRESH_HOST_TOKEN}`, `1 ${FRESH_HOST_TOKEN}`]));
        done.settle();
        await whenDone("the dial's end", dialled);
      } finally {
        vi.useRealTimers();
        world.mint.respond("unavailable");
        done.settle();
        await dialled?.catch(() => undefined);
        session.dispose();
      }
    },
    TIMEOUT,
  );

  it(
    "on an open stream: refreshes the sign-in once, mints once more, and does not ask again",
    async () => {
      const held = heldEndingIn(OPEN_BEYOND_LEAD_MS);
      const world = await useWorld(held);
      takeTheClockBefore(held);
      const arming = watchArming();
      let read: RunningRead | null = null;
      try {
        read = await admittedRead(world);
        // The admission arms the dial's one renewal timer.
        expect(
          arming.take().filter((by) => by === "local-stream.ts"),
        ).toHaveLength(1);
        await fireRenewalTimer(held.expiresAtMs, 1);
        expect(observed.timerRenewals).toHaveLength(1);
        await untilWhileRunning(
          "the mint",
          read.outcome,
          () => world.mint.requests.length > 0,
        );
        expect(world.mint.requests).toHaveLength(1);
        // authn answers 10 s later. Both tokens end after the held one, and
        // still within the lead: the sign-in that buys them ends then.
        vi.setSystemTime(Date.now() + 10_000);
        const first = mintedEndingIn("capped", LEAD_MS - 5_000, 2_000);
        const second = mintedEndingIn("capped-again", LEAD_MS - 3_000, 0);
        world.mint.issued = first;
        const refresh = acceptRefresh(world, second);
        world.mint.respond("ok");
        expect(await timerRenewal(0)).toBeGreaterThan(held.expiresAtMs);
        // Whatever the renewal's push leads to, or a retry, is due within this.
        await vi.advanceTimersByTimeAsync(PAST_A_RETRY_MS);
        await timerRenewalsDone();

        expect(observed.timerRenewals).toHaveLength(1);
        // The admission's timer stays the one armed, whatever the span.
        expect(arming.take()).toEqual([]);
        expect({
          mints: world.mint.requests.length,
          refreshes: refresh.accepted(),
        }).toEqual({ mints: 2, refreshes: 1 });
        expect(pushed(world)).toEqual([
          { index: 0, token: second, installed: true },
        ]);
        read.serve();
        BOT_CHECKINS.expectNormalResult(
          await whenDone("the command's end", read.outcome),
        );
      } finally {
        arming.restore();
        vi.useRealTimers();
        read?.serve();
        await read?.outcome.catch(() => undefined);
      }
    },
    TIMEOUT,
  );
});

/** Writes the shared host-token file, as another program of the person's would. */
async function saveHostToken(
  userId: string,
  hostId: string,
  saved: HeldToken,
): Promise<void> {
  await createHostTokenFilePersistence({
    environment: config.environment,
    lockWaitMs: 2_000,
    lockPollIntervalMs: 10,
  }).update((table) => {
    const users = new Map(table);
    users.set(userId, new Map([[hostId, saved]]));
    return new Map(users);
  });
}

/** The host-token file's token for `userId` on `hostId`. */
async function heldTokenOf(
  userId: string,
  hostId: string,
): Promise<string | null> {
  const table = await createHostTokenFilePersistence({
    environment: config.environment,
    lockWaitMs: 2_000,
    lockPollIntervalMs: 10,
  }).load();
  return table.get(userId)?.get(hostId)?.token ?? null;
}

/** Signs this machine in as `userId`, replacing whoever is signed in. */
async function signInAs(userId: string, token: string): Promise<void> {
  const store = createCliCredentialsStore();
  try {
    await store.signIn(
      {
        token,
        refreshToken: `rt-${token}`,
        savedAt: "2026-01-02T00:00:00.000Z",
        user: { id: userId, email: "other@example.test", name: "Other" },
      },
      false,
      null,
    );
  } finally {
    store.dispose();
  }
}

/** Settles once `call` has taken its next step: a mint request or an open. */
async function whenNextStep(
  world: World,
  unary: UnaryDoor,
  call: Promise<unknown>,
  stepsBefore: number,
): Promise<void> {
  await untilWhileRunning(
    "the call's next step",
    call,
    () => world.mint.requests.length + unary.opens.length > stepsBefore,
  );
}

describe("a stream admitted on a token the call before its dial already waited on", () => {
  it(
    "is still renewed by the stream's timer, and the new token pushed",
    async () => {
      const held = heldEndingIn(WITHIN_LEAD_MS);
      const world = await useWorld(held);
      prepareHostFor(BOT_CHECKINS, world);
      const serving = deferred();
      world.host.hold = serving.promise;
      const admission = deferred();
      world.host.openAt.set(0, { answer: "admit", after: admission.promise });
      // The renewal before the dial meets an unreachable authn.
      world.mint.respond("unavailable");
      takeTheClockWithLeft(held, WITHIN_LEAD_MS);
      let run: Promise<Outcome> | null = null;
      try {
        run = settle(BOT_CHECKINS.start(world));
        await untilWhileRunning(
          "the read's open",
          run,
          () => world.host.opens.length > 0,
        );
        await world.host.whenOpenedAs([world.expiredHeld]);
        expect(world.mint.requests).toHaveLength(1);
        // authn is back by the time the host admits.
        world.mint.respond("ok");
        admission.settle();
        await untilWhileRunning(
          "the subscribe",
          run,
          () => world.host.subscribes.length > 0,
        );
        // The admission arms the renewal timer, due at once.
        await vi.advanceTimersByTimeAsync(0);
        await untilWhileRunning(
          "the timer's renewal",
          run,
          () => observed.timerRenewals.length > 0,
        );
        await timerRenewal(0);
        expect(world.mint.requests).toHaveLength(2);
        expect(pushed(world)).toEqual([
          { index: 0, token: FRESH_HOST_TOKEN, installed: true },
        ]);
        serving.settle();
        BOT_CHECKINS.expectNormalResult(
          await whenDone("the command's end", run),
        );
      } finally {
        // A command still running ends at its own limit, so a failure shows.
        vi.advanceTimersByTime(PAST_EVERY_LIMIT_MS);
        vi.useRealTimers();
        admission.settle();
        serving.settle();
        world.mint.respond("unavailable");
        await run?.catch(() => undefined);
      }
    },
    TIMEOUT,
  );
});

describe("a unary call whose held token ends within the lead", () => {
  async function unaryCase(): Promise<{
    readonly held: HeldToken;
    readonly world: World;
    readonly unary: UnaryDoor;
    readonly call: () => Promise<unknown>;
  }> {
    const held = heldEndingIn(WITHIN_LEAD_MS);
    const world = await useWorld(held);
    const unary = new UnaryDoor(world.mint, world.expiredHeld);
    liveUnary.door = unary;
    unary.expired = ANSWERS_AT_ONCE("admit");
    unary.serve = () => ({ bots: [], mainBotIds: null });
    // No production deadline moves but by a case's own hand: not the call's
    // budget for the work before its request, and not the held token's end.
    takeTheClockWithLeft(held, WITHIN_LEAD_MS);
    return {
      held,
      world,
      unary,
      call: () => callHostRpcAtEndpoint("bot.list", {}, seams.endpoint),
    };
  }

  it(
    "asks once before the request, and the request presents the new token",
    async () => {
      const { world, unary, call } = await unaryCase();
      let run: Promise<unknown> | null = null;
      try {
        run = call();
        await whenNextStep(world, unary, run, 0);
        expect(world.mint.requests).toHaveLength(1);
        expect(unary.opens).toEqual([]);
        world.mint.respond("ok");
        expect(await whenDone("the call's end", run)).toMatchObject({
          bots: [],
        });
        expect(unary.opens.map((open) => open.token)).toEqual([
          FRESH_HOST_TOKEN,
        ]);
        expect(unary.requests).toEqual([{ index: 0, method: "bot.list" }]);
        expect(world.mint.requests).toHaveLength(1);
      } finally {
        world.mint.respond("unavailable");
        await run?.catch(() => undefined);
      }
    },
    TIMEOUT,
  );

  it.each<{ readonly answer: MintAnswer }>([
    { answer: "unavailable" },
    { answer: "not-a-member" },
    { answer: "sign-in-rejected" },
  ])(
    "sends on the held token when authn answers $answer, and nothing ends the call",
    async ({ answer }) => {
      const { world, unary, call } = await unaryCase();
      world.mint.respond(answer);
      expect(await whenDone("the call's end", call())).toMatchObject({
        bots: [],
      });
      expect(world.mint.requests).toHaveLength(1);
      expect(unary.opens.map((open) => open.token)).toEqual([
        world.expiredHeld,
      ]);
      expect(unary.requests).toEqual([{ index: 0, method: "bot.list" }]);
    },
    TIMEOUT,
  );

  it(
    "in an outage, a second call within the lead sends no mint and does not wait",
    async () => {
      const { world, unary, call } = await unaryCase();
      world.mint.respond("unavailable");
      expect(await whenDone("the call's end", call())).toMatchObject({
        bots: [],
      });
      expect(world.mint.requests).toHaveLength(1);
      // From here authn answers nothing: a call that asked would wait on it.
      world.mint.hold();
      let second: Promise<unknown> | null = null;
      try {
        second = call();
        await whenNextStep(world, unary, second, 2);
        expect(world.mint.requests).toHaveLength(1);
        expect(await whenDone("the second call's end", second)).toMatchObject({
          bots: [],
        });
        expect(unary.opens.map((open) => open.token)).toEqual([
          world.expiredHeld,
          world.expiredHeld,
        ]);
      } finally {
        world.mint.respond("unavailable");
        await second?.catch(() => undefined);
      }
    },
    TIMEOUT,
  );

  it(
    "while a renewal is out, a second call does not wait for it",
    async () => {
      const { world, unary, call } = await unaryCase();
      let first: Promise<unknown> | null = null;
      let second: Promise<unknown> | null = null;
      try {
        first = call();
        await untilWhileRunning(
          "the first call's mint",
          first,
          () => world.mint.requests.length > 0,
        );
        expect(world.mint.requests).toHaveLength(1);
        second = call();
        await untilWhileRunning(
          "the second call's request",
          second,
          () => unary.requests.length > 0,
        );
        expect(unary.requests).toHaveLength(1);
        expect(unary.opens).toEqual([
          { index: 0, token: world.expiredHeld, mintStillOut: true },
        ]);
        expect(await whenDone("the second call's end", second)).toMatchObject({
          bots: [],
        });

        world.mint.respond("ok");
        expect(await whenDone("the first call's end", first)).toMatchObject({
          bots: [],
        });
        expect(unary.opens.map((open) => open.token)).toEqual([
          world.expiredHeld,
          FRESH_HOST_TOKEN,
        ]);
        expect(world.mint.requests).toHaveLength(1);
      } finally {
        world.mint.respond("unavailable");
        await first?.catch(() => undefined);
        await second?.catch(() => undefined);
      }
    },
    TIMEOUT,
  );

  it(
    "before a unary call: refreshes the sign-in once, mints once more, sends on that token, and no later call waits on it",
    async () => {
      const { world, unary, call } = await unaryCase();
      const first = mintedEndingIn("capped", WITHIN_LEAD_MS + 10_000, 2_000);
      const second = mintedEndingIn("capped-again", WITHIN_LEAD_MS + 20_000, 0);
      world.mint.issued = first;
      const refresh = acceptRefresh(world, second);
      world.mint.respond("ok");
      unary.openAt.set(0, ANSWERS_AT_ONCE("admit"));

      expect(await whenDone("the call's end", call())).toMatchObject({
        bots: [],
      });

      expect(
        world.mint.requests.map((request) => request.authorization),
      ).toEqual([`Bearer ${STORED_SIGN_IN}`, `Bearer ${REFRESHED_SIGN_IN}`]);
      expect(refresh.accepted()).toBe(1);
      expect(unary.opens.map((open) => open.token)).toEqual([second]);
      expect(unary.requests).toEqual([{ index: 0, method: "bot.list" }]);

      // The token bought last is still within the lead.
      world.mint.hold();
      unary.openAt.set(1, ANSWERS_AT_ONCE("admit"));
      let later: Promise<unknown> | null = null;
      try {
        later = call();
        await whenNextStep(world, unary, later, 3);
        expect(world.mint.requests).toHaveLength(2);
        expect(await whenDone("the later call's end", later)).toMatchObject({
          bots: [],
        });
        expect(unary.opens.map((open) => open.token)).toEqual([second, second]);
      } finally {
        world.mint.respond("unavailable");
        await later?.catch(() => undefined);
      }
    },
    TIMEOUT,
  );

  it(
    "waits again, once, when the token a renewal bought comes within the lead",
    async () => {
      const { world, unary, call } = await unaryCase();
      // It ends outside the lead: the renewal that buys it leaves it unmarked.
      const bought = mintedEndingIn("bought", LEAD_MS + 30_000, 0);
      world.mint.issued = bought;
      world.mint.respond("ok");
      for (const index of [0, 1, 2])
        unary.openAt.set(index, ANSWERS_AT_ONCE("admit"));
      expect(await whenDone("the call's end", call())).toMatchObject({
        bots: [],
      });
      expect(unary.opens.map((open) => open.token)).toEqual([bought]);

      let waiting: Promise<unknown> | null = null;
      let later: Promise<unknown> | null = null;
      try {
        // Only the wall clock moves: the bought token now ends within the lead.
        vi.setSystemTime(Date.now() + 90_000);
        world.mint.hold();
        waiting = call();
        await whenNextStep(world, unary, waiting, 2);
        // It asked, and sends nothing while authn has not answered.
        expect(world.mint.requests).toHaveLength(2);
        expect(unary.opens).toHaveLength(1);
        world.mint.respond("unavailable");
        expect(await whenDone("the waiting call's end", waiting)).toMatchObject(
          {
            bots: [],
          },
        );

        world.mint.hold();
        later = call();
        await whenNextStep(world, unary, later, 4);
        expect(world.mint.requests).toHaveLength(2);
        expect(await whenDone("the later call's end", later)).toMatchObject({
          bots: [],
        });
        expect(unary.opens.map((open) => open.token)).toEqual([
          bought,
          bought,
          bought,
        ]);
      } finally {
        world.mint.respond("unavailable");
        await waiting?.catch(() => undefined);
        await later?.catch(() => undefined);
      }
    },
    TIMEOUT,
  );

  it(
    "keeps one person's waited renewal from another person's call in the same process",
    async () => {
      const { held, world, unary, call } = await unaryCase();
      const other = nextCasePerson();
      world.mint.respond("unavailable");
      await whenDone("the first person's call", call());
      await signInAs(other.userId, other.signIn);
      // Both people hold the one bearer, to the one end, on the one host: only
      // the person can tell whose renewal was waited on.
      await saveHostToken(other.userId, world.hostId, held);
      // The second person's own first call waits on their own renewal.
      await whenDone("the second person's call", call());
      expect(
        world.mint.requests.map((request) => request.authorization),
      ).toEqual([`Bearer ${STORED_SIGN_IN}`, `Bearer ${other.signIn}`]);

      await signInAs(world.userId, STORED_SIGN_IN);
      await saveHostToken(world.userId, world.hostId, held);
      world.mint.hold();
      let again: Promise<unknown> | null = null;
      try {
        again = call();
        await whenNextStep(world, unary, again, 4);
        expect(world.mint.requests).toHaveLength(2);
        await whenDone("the last call's end", again);
        expect(unary.opens.map((open) => open.token)).toEqual([
          world.expiredHeld,
          world.expiredHeld,
          world.expiredHeld,
        ]);
      } finally {
        world.mint.respond("unavailable");
        await again?.catch(() => undefined);
      }
    },
    TIMEOUT,
  );

  it(
    "waits, once, on a still-due token another program saved after a waited renewal",
    async () => {
      const { world, unary, call } = await unaryCase();
      const saved: HeldToken = {
        token: mintedEndingIn("another-program", WITHIN_LEAD_MS, 0),
        expiresAtMs: Date.now() + WITHIN_LEAD_MS,
      };
      for (const index of [1, 2])
        unary.openAt.set(index, ANSWERS_AT_ONCE("admit"));
      world.mint.respond("unavailable");
      expect(await whenDone("the call's end", call())).toMatchObject({
        bots: [],
      });
      expect(world.mint.requests).toHaveLength(1);

      // No call is running: the next one's handle loads the file anew.
      await saveHostToken(world.userId, world.hostId, saved);
      world.mint.hold();
      let waiting: Promise<unknown> | null = null;
      let later: Promise<unknown> | null = null;
      try {
        waiting = call();
        await whenNextStep(world, unary, waiting, 2);
        // It asked, and sends nothing while authn has not answered.
        expect(world.mint.requests).toHaveLength(2);
        expect(unary.opens).toHaveLength(1);
        world.mint.respond("unavailable");
        expect(await whenDone("the waiting call's end", waiting)).toMatchObject(
          {
            bots: [],
          },
        );

        world.mint.hold();
        later = call();
        await whenNextStep(world, unary, later, 4);
        expect(world.mint.requests).toHaveLength(2);
        expect(await whenDone("the later call's end", later)).toMatchObject({
          bots: [],
        });
        expect(unary.opens.map((open) => open.token)).toEqual([
          world.expiredHeld,
          saved.token,
          saved.token,
        ]);
      } finally {
        world.mint.respond("unavailable");
        await waiting?.catch(() => undefined);
        await later?.catch(() => undefined);
      }
    },
    TIMEOUT,
  );
});

describe("bot post --wait with a held token within the lead", () => {
  it(
    "ends at the person's wait, with no dial, while the renewal before it is out",
    async () => {
      const world = await useWorld(heldEndingIn(WITHIN_LEAD_MS));
      prepareHostFor(BOT_POST_LISTENER, world);
      world.host.serve = () => [];
      // authn answers nothing until the case says.
      world.mint.hold();
      takeTheClock();
      let run: Promise<Outcome> | null = null;
      try {
        let ended = false;
        run = settle(
          buildBotPostCommand({ bot: BOT_ID_A, text: "ship it", wait: "1s" })(
            world.ctx,
          ),
        ).finally(() => {
          ended = true;
        });
        // The clock has not moved since it was taken, so the wait's second is
        // counted from the time it still reads.
        await untilWhileRunning(
          "the renewal's mint",
          run,
          () => world.mint.requests.length > 0,
        );

        await vi.advanceTimersByTimeAsync(999);
        await oneTurn();
        expect(ended).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await turnsUntil("the command's end at one second", () => ended);

        const outcome = await run;
        if (outcome.kind !== "completed") expect.fail(outcome.message);
        expect(outcome.result.data).toMatchObject({
          outcome: { kind: "timed-out" },
        });
        expect(world.host.opens).toEqual([]);
        expect(world.mint.requests).toHaveLength(1);
      } finally {
        // A wait still running ends at its own limit, so a failure shows.
        vi.advanceTimersByTime(PAST_EVERY_LIMIT_MS);
        vi.useRealTimers();
        world.mint.respond("unavailable");
        await run?.catch(() => undefined);
      }
    },
    TIMEOUT,
  );
});

/** The made-up credentials file of `world`, under its temporary home. */
function madeUpCredentialsPath(): string {
  const path = cliCredentialsPath(config.environment);
  const underTestHome = home.path;
  if (underTestHome === null || !path.startsWith(underTestHome))
    throw new Error("the credentials path is not under the case's home");
  return path;
}

/**
 * What no log line and no line the person reads may carry: who is signed in,
 * and every credential of theirs. Read while the made-up file is there.
 */
async function privateStrings(world: World): Promise<readonly string[]> {
  const stored = await readCredentialsFile(madeUpCredentialsPath());
  if (stored === null) throw new Error("the case is not signed in");
  return [...privateStringsOf(stored), world.expiredHeld, FRESH_HOST_TOKEN];
}

/** Who a stored sign-in names, and its credentials. */
function privateStringsOf(stored: StoredCredentials): readonly string[] {
  return [stored.user.id, stored.user.email, stored.token, stored.refreshToken];
}

/** Of `secrets`, those some log line or written line carries. */
function carried(world: World, secrets: readonly string[]): readonly string[] {
  const text = [...loggedLines, ...world.output.lines].join("\n");
  return secrets.filter((secret) => text.includes(secret));
}

/**
 * A unary door that admits the held token and, to an open with no token,
 * invites the person's sign-in and admits it: whatever a call may send, this
 * host takes.
 */
function invitingDoor(world: World): UnaryDoor {
  const unary = new UnaryDoor(world.mint, world.expiredHeld);
  liveUnary.door = unary;
  unary.expired = ANSWERS_AT_ONCE("admit");
  unary.serve = () => ({ bots: [], mainBotIds: null });
  return unary;
}

/** What each open the host read presented, by name: stream, then unary. */
function presented(world: World, unary: UnaryDoor | null): readonly string[] {
  const names = new Map<unknown, string>([
    [world.expiredHeld, "held token"],
    [FRESH_HOST_TOKEN, "minted token"],
    [STORED_SIGN_IN, "stored sign-in"],
    [NO_HOST_TOKEN_PROBE, "no-token probe"],
  ]);
  return [...world.host.opens, ...(unary?.opens ?? [])].map(
    (open) => names.get(open.token) ?? "unnamed",
  );
}

/** How many frames the host read, on either door, carry the stored sign-in. */
function signInFrames(world: World, unary: UnaryDoor | null): number {
  return [...world.host.frames, ...(unary?.frames ?? [])].filter((frame) =>
    frame.includes(STORED_SIGN_IN),
  ).length;
}

/** How a call ended: its answer, or what the runner reads of its error. */
async function endingOf(run: Promise<unknown>): Promise<unknown> {
  try {
    return { answered: await run };
  } catch (error) {
    if (error instanceof CliError)
      return {
        code: error.code,
        message: error.message,
        details: error.details,
        exitCode: error.exitCode,
      };
    if (error instanceof HostRpcError)
      return {
        error: "HostRpcError",
        code: error.code,
        message: error.message,
        method: error.method,
        fatalDetails: error.fatalDetails,
      };
    return {
      threw: error instanceof Error ? error.message : String(error),
    };
  }
}

/** What the host saw, on either door. */
function hostSaw(world: World, unary: UnaryDoor | null): unknown {
  return {
    framesWithTheStoredSignIn: signInFrames(world, unary),
    opens: presented(world, unary),
  };
}

/** The host saw the held token's one open, and no sign-in. */
const ONLY_THE_HELD_TOKEN = {
  framesWithTheStoredSignIn: 0,
  opens: ["held token"],
};

/** The person's row, and what the host saw. */
async function leftBehind(world: World, unary: UnaryDoor): Promise<unknown> {
  return {
    row: await world.heldToken(),
    framesWithTheStoredSignIn: signInFrames(world, unary),
    opens: presented(world, unary),
  };
}

/** No row, and nothing sent to the host: no token, sign-in or probe. */
const NOTHING_STORED_OR_SENT = {
  row: null,
  framesWithTheStoredSignIn: 0,
  opens: [],
};

const SIGNED_OUT_ENDING = {
  code: "E_AUTH_NO_CREDENTIALS",
  message: signedOutCliError().message,
  details: null,
  exitCode: 1,
};

/** The person's host-token row goes, as logout's forget removes it. */
async function clearHostTokenRow(world: World): Promise<void> {
  await createHostTokenFilePersistence({
    environment: config.environment,
    lockWaitMs: 2_000,
    lockPollIntervalMs: 10,
  }).update((table) => {
    const next = new Map(table);
    next.delete(world.userId);
    return next;
  });
}

/** `traycer logout` in another process: the file, then the person's row. */
async function logOutElsewhere(world: World): Promise<void> {
  await rm(madeUpCredentialsPath());
  await clearHostTokenRow(world);
}

const ANOTHER_PERSON: StoredCredentials = {
  token: "another-persons-sign-in",
  refreshToken: "another-persons-refresh-token",
  savedAt: "2026-01-01T00:00:00.000Z",
  user: {
    id: "another-person",
    email: "another@example.test",
    name: "Another",
  },
};

/** Another person's login: their file, and this person's row removed. */
async function signInAnotherPersonElsewhere(world: World): Promise<void> {
  await writeJsonFileAtomic(madeUpCredentialsPath(), ANOTHER_PERSON, 0o600);
  await clearHostTokenRow(world);
}

/**
 * Runs `change` while a call's mint is out, then lets authn answer a token:
 * what follows is the token's save, over what `change` left. The case has
 * taken the clock, so what `change` takes is charged to no limit of the call.
 */
async function answeredAfter(
  world: World,
  start: () => Promise<unknown>,
  change: () => Promise<void>,
): Promise<unknown> {
  let run: Promise<unknown> | null = null;
  try {
    run = start();
    await untilWhileRunning(
      "the call's mint",
      run,
      () => world.mint.requests.length > 0,
    );
    expect(world.mint.requests).toHaveLength(1);
    await change();
    loggedLines.length = 0;
    world.output.lines.length = 0;
    world.mint.respond("ok");
    return await whenDone("the call's end", run);
  } finally {
    world.mint.respond("unavailable");
    await run?.catch(() => undefined);
  }
}

/** The kind of every refusal any open session is told of from now on. */
function reportsHeardBySessions(): readonly string[] {
  const heard: string[] = [];
  for (const session of observed.sessions)
    session.tokens.onRefusalEndingCommand((evidence) => {
      heard.push(evidence.failure.kind);
    });
  return heard;
}

/** Why each stream client a command built was closed, in order. */
function clientCloseReasons(world: World): readonly string[] {
  return world.output.lines.flatMap((line) => {
    const closed = /WsStreamClient closed \(client=[^,]+, reason=([^,]+),/.exec(
      line,
    );
    return closed?.[1] === undefined ? [] : [closed[1]];
  });
}

/**
 * How a `bot checkins` read ends when the host holds its first open while
 * another call in this process drops a save, then refuses that open with
 * `answer`. Only the other call finds the person gone: the read's own session
 * is told nothing before the refusal.
 */
async function readRefusedOnceThePersonIsGone(
  world: World,
  answer: Reading,
  logOut: () => Promise<void>,
): Promise<unknown> {
  const other = await liveSession(world);
  prepareHostFor(BOT_CHECKINS, world);
  const refusing = deferred();
  world.host.openAt.set(0, { answer, after: refusing.promise });
  takeTheClock();
  let ending: unknown = null;
  let run: Promise<unknown> | null = null;
  try {
    run = endingOf(BOT_CHECKINS.start(world)).then((value) => {
      ending = value;
      return value;
    });
    await untilWhileRunning(
      "the read's first open",
      run,
      () => world.host.opens.length > 0,
    );
    expect(world.host.opens).toHaveLength(1);
    await whenDone("the logout", logOut());
    world.mint.respond("ok");
    // authn answers a token; the other call's save of it is what is dropped.
    const dropped = await whenDone(
      "the other call's mint",
      other.tokens.mintFresh(world.hostId, null),
    );
    expect(dropped.kind).toBe("failed");
    // An outage from here, for whatever would ask next.
    world.mint.respond("unavailable");
    refusing.settle();
    await turnsUntil(
      "the read's end, or the sign-in at the host",
      () => ending !== null || signInFrames(world, null) > 0,
    );
    return await whenDone("the read's end", run);
  } finally {
    // A read still running ends at its own limit, so a failure shows.
    vi.advanceTimersByTime(PAST_EVERY_LIMIT_MS);
    vi.useRealTimers();
    world.mint.respond("unavailable");
    refusing.settle();
    await run;
    other.dispose();
  }
}

describe("a command still running when the credentials file no longer holds its person", () => {
  it(
    "after another process's logout, the stream's renewal timer stores and pushes nothing, and the stream ends at the held token's end with no sign-in line",
    async () => {
      const held = heldEndingIn(OPEN_BEYOND_LEAD_MS);
      const world = await useWorld(held);
      takeTheClockBefore(held);
      const arming = watchArming();
      let read: RunningRead | null = null;
      try {
        read = await admittedRead(world);
        // The admission arms the dial's one renewal timer.
        expect(
          arming.take().filter((by) => by === "local-stream.ts"),
        ).toHaveLength(1);
        const secrets = await whenDone("the file read", privateStrings(world));
        await whenDone("the logout", logOutElsewhere(world));
        loggedLines.length = 0;
        world.output.lines.length = 0;

        world.mint.respond("ok");
        await fireRenewalTimer(held.expiresAtMs, 1);
        expect(observed.timerRenewals).toHaveLength(1);
        const renewed = await timerRenewal(0);
        // authn answered a token: what follows is the write's own doing.
        expect(world.mint.requests).toHaveLength(1);
        expect(await whenDone("the row", world.heldToken())).toBeNull();
        expect(renewed).toBeNull();
        await vi.advanceTimersByTimeAsync(PAST_A_RETRY_MS);
        await timerRenewalsDone();
        expect(world.host.updates).toEqual([]);
        expect(observed.timerRenewals).toHaveLength(1);
        expect(arming.take()).toEqual([]);
        expect(read.settled()).toBe(false);

        world.host.watchReaches(0, held.expiresAtMs);
        expect(world.host.connections[0]?.cut).toBe(true);
        const outcome = await whenDone("the command's end", read.outcome);
        // The read ends on the host's cut, with no sign-in ending.
        expect(outcome).toEqual({
          kind: "failed",
          code: "E_HOST_UNREACHABLE",
          message:
            "traycer: could not read the bot from this host - door refused: token-expired. Try again.",
        });
        expect(world.host.opens.map((open) => open.token)).toEqual([
          world.expiredHeld,
        ]);
        expect(world.mint.requests).toHaveLength(1);
        const everyLine = [
          ...loggedLines,
          ...world.output.lines,
          JSON.stringify(outcome),
        ].join("\n");
        expect(loggedLines.filter((line) => line.startsWith("error "))).toEqual(
          [],
        );
        expect(everyLine).not.toMatch(/sign in again|traycer login/i);
        expect(carried(world, secrets)).toEqual([]);
      } finally {
        arming.restore();
        vi.useRealTimers();
        read?.serve();
        await read?.outcome.catch(() => undefined);
      }
    },
    TIMEOUT,
  );

  it(
    "after another process's logout, a second dial on the held session ends signed-out before any open, with authn set to answer 503",
    async () => {
      const held = heldEndingIn(OPEN_BEYOND_LEAD_MS);
      const world = await useWorld(held);
      const session = await liveSession(world);
      const callerEnds = deferred();
      takeTheClockBefore(held);
      let first: Promise<string> | null = null;
      let redial: Promise<string> | null = null;
      try {
        first = dialOn(
          world,
          session,
          (client) =>
            new Promise<string>((resolve) => {
              client
                .subscribe("bot.subscribe", { botId: BOT_ID_A })
                .onStatusChange((status) => {
                  if (status === "closed") resolve("closed");
                });
            }),
        );
        await untilWhileRunning(
          "the subscribe",
          first,
          () => world.host.subscribes.length > 0,
        );
        await whenDone("the logout", logOutElsewhere(world));
        loggedLines.length = 0;
        world.output.lines.length = 0;
        world.mint.respond("ok");
        await fireRenewalTimer(held.expiresAtMs, 1);
        expect(await timerRenewal(0)).toBeNull();
        vi.setSystemTime(held.expiresAtMs + 1_000);
        world.host.watchReaches(0, held.expiresAtMs);
        expect(await whenDone("the dial's end", first)).toBe("closed");

        // An outage from here: what would let a call that had not seen the
        // dropped save offer the stored sign-in.
        world.mint.respond("unavailable");
        redial = dialOn(world, session, (client) => {
          client.subscribe("bot.subscribe", { botId: BOT_ID_A });
          return callerEnds.promise.then(() => "ended by its caller");
        });
        let ending: unknown = null;
        void endingOf(redial).then((value) => {
          ending = value;
        });
        await turnsUntil(
          "the redial's end, or the sign-in at the host",
          () => ending !== null || signInFrames(world, null) > 0,
        );

        // The one open is the first dial's: the redial ended before any.
        expect(hostSaw(world, null)).toEqual(ONLY_THE_HELD_TOKEN);
        expect(askedAuthn).toEqual(ONLY_THE_DROPPED_SAVES_MINT);
        expect(ending).toEqual(SIGNED_OUT_ENDING);
        expect({
          row: await whenDone("the row", world.heldToken()),
          updates: world.host.updates,
        }).toEqual({ row: null, updates: [] });
      } finally {
        vi.useRealTimers();
        world.mint.respond("unavailable");
        // Cuts the first dial whatever token its connection ended up holding.
        world.host.watchReaches(0, Number.POSITIVE_INFINITY);
        callerEnds.settle();
        await first?.catch(() => undefined);
        await redial?.catch(() => undefined);
        session.dispose();
      }
    },
    TIMEOUT,
  );

  it(
    "a unary call's renewal before work, answered after another process's logout deleted the file, stores nothing, and the call goes on the held token",
    async () => {
      const held = heldEndingIn(WITHIN_LEAD_MS);
      const world = await useWorld(held);
      const unary = new UnaryDoor(world.mint, world.expiredHeld);
      liveUnary.door = unary;
      unary.expired = ANSWERS_AT_ONCE("admit");
      unary.serve = () => ({ bots: [], mainBotIds: null });
      const secrets = await privateStrings(world);
      takeTheClockWithLeft(held, WITHIN_LEAD_MS);
      let run: Promise<unknown> | null = null;
      try {
        run = callHostRpcAtEndpoint("bot.list", {}, seams.endpoint);
        await untilWhileRunning(
          "the call's mint",
          run,
          () => world.mint.requests.length > 0,
        );
        expect(world.mint.requests).toHaveLength(1);
        // Logout has deleted the file; its forget has not reached the row yet.
        await rm(madeUpCredentialsPath());
        loggedLines.length = 0;
        world.mint.respond("ok");
        expect(await whenDone("the call's end", run)).toMatchObject({
          bots: [],
        });
        expect(await world.heldToken()).toBe(world.expiredHeld);
        expect(unary.opens.map((open) => open.token)).toEqual([
          world.expiredHeld,
        ]);
        expect(unary.requests).toEqual([{ index: 0, method: "bot.list" }]);
        expect(world.mint.requests).toHaveLength(1);
        expect(carried(world, secrets)).toEqual([]);
      } finally {
        world.mint.respond("unavailable");
        await run?.catch(() => undefined);
      }
    },
    TIMEOUT,
  );

  it(
    "a logout in another process after the renewed token was stored: its forget removes the row",
    async () => {
      const world = await useWorld(heldEndingIn(WITHIN_LEAD_MS));
      const session = await liveSession(world);
      try {
        world.mint.respond("ok");
        await session.tokens.mintFresh(world.hostId, null);
        expect(await world.heldToken()).toBe(FRESH_HOST_TOKEN);

        // The other process: its own modules, so it holds no token of this
        // person in memory. The file is gone before its forget runs.
        await rm(madeUpCredentialsPath());
        vi.resetModules();
        const otherProcess = await vi.importActual<
          typeof import("../../internal/cli-host-tokens")
        >("../../internal/cli-host-tokens");
        expect(otherProcess.acquireCliSignIn).not.toBe(acquireCliSignIn);
        await otherProcess.forgetCliHostTokens(world.userId);

        expect(await world.heldToken()).toBeNull();
      } finally {
        session.dispose();
      }
    },
    TIMEOUT,
  );

  it(
    "with another person in the credentials file, a mint's token is not stored for this one",
    async () => {
      const world = await useWorld(heldEndingIn(WITHIN_LEAD_MS));
      const session = await liveSession(world);
      try {
        const secrets = await privateStrings(world);
        await signInAnotherPersonElsewhere(world);
        loggedLines.length = 0;
        world.mint.respond("ok");

        const answer = await session.tokens.mintFresh(world.hostId, null);

        expect(world.mint.requests).toHaveLength(1);
        expect(await world.heldToken()).toBeNull();
        expect(answer).toEqual({
          kind: "failed",
          failure: { kind: "no-sign-in" },
        });
        expect(
          carried(world, [...secrets, ...privateStringsOf(ANOTHER_PERSON)]),
        ).toEqual([]);
        expect(JSON.stringify(answer)).not.toContain(world.userId);
      } finally {
        session.dispose();
      }
    },
    TIMEOUT,
  );
});

describe("a waiting command after another program's logout", () => {
  it(
    "admitted, its renewal's save dropped, then its connection dropped with authn set to answer 503: bot post --wait ends signed-out on its own no-sign-in report, before the token's end",
    async () => {
      const held = heldEndingIn(OPEN_BEYOND_LEAD_MS);
      const world = await useWorld(held);
      prepareHostFor(BOT_POST_LISTENER, world);
      const serving = deferred();
      world.host.hold = serving.promise;
      takeTheClockBefore(held);
      let run: Promise<unknown> | null = null;
      try {
        let ending: unknown = null;
        let endedAtMs = Number.POSITIVE_INFINITY;
        run = endingOf(BOT_POST_LISTENER.start(world)).then((value) => {
          endedAtMs = Date.now();
          ending = value;
          return value;
        });
        await untilWhileRunning(
          "the wait's subscribe",
          run,
          () => world.host.subscribes.length > 0,
        );
        const reports = reportsHeardBySessions();
        await whenDone("the logout", logOutElsewhere(world));
        world.mint.respond("ok");
        await fireRenewalTimer(held.expiresAtMs, 1);
        expect(await timerRenewal(0)).toBeNull();
        // The renewal's own save was dropped, and a renewal reports to nobody:
        // the wait goes on, on the connection it has.
        expect({ reports, ending }).toEqual({ reports: [], ending: null });

        // The client's own reconnect, with the 503 ready for whatever it asks.
        world.mint.respond("unavailable");
        world.host.drop(0);
        await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF_MS);
        await turnsUntil(
          "the command's end, or the sign-in at the host",
          () => ending !== null || signInFrames(world, null) > 0,
        );

        expect(hostSaw(world, null)).toEqual(ONLY_THE_HELD_TOKEN);
        expect(askedAuthn).toEqual(ONLY_THE_DROPPED_SAVES_MINT);
        // The post went out first, so the ending also names what was sent.
        expect(ending).toEqual({
          ...SIGNED_OUT_ENDING,
          details: expect.objectContaining({ messageId: "msg-sent" }),
        });
        expect(endedAtMs).toBeLessThan(held.expiresAtMs);
        // The wait ended it: told of no sign-in, it closed its own client.
        expect(reports).toEqual(["no-sign-in"]);
        expect(clientCloseReasons(world)).toEqual(["host-token-refused"]);
        expect(await whenDone("the row", world.heldToken())).toBeNull();
      } finally {
        // A wait still running ends at its own limit, so a failure shows.
        vi.advanceTimersByTime(PAST_EVERY_LIMIT_MS);
        vi.useRealTimers();
        world.mint.respond("unavailable");
        serving.settle();
        await run;
      }
    },
    TIMEOUT,
  );

  it(
    "a command that asks for no mint goes on after the logout, succeeds on its held token, and leaves the person not marked: signed in again, their next call mints",
    async () => {
      const held = heldEndingIn(BEYOND_THE_CASE_MS);
      const world = await useWorld(held);
      const signedIn = await readCredentialsFile(madeUpCredentialsPath());
      if (signedIn === null) throw new Error("the case is not signed in");
      prepareHostFor(BOT_POST_LISTENER, world);
      const serving = deferred();
      world.host.hold = serving.promise;
      takeTheClockWithLeft(held, BEYOND_THE_CASE_MS);
      let run: Promise<unknown> | null = null;
      try {
        run = endingOf(BOT_POST_LISTENER.start(world));
        await untilWhileRunning(
          "the wait's subscribe",
          run,
          () => world.host.subscribes.length > 0,
        );
        expect(world.host.subscribes).toHaveLength(1);
        await logOutElsewhere(world);
        // Still running: it loses its connection, redials and reads again.
        world.host.drop(0);
        await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF_MS);
        await untilWhileRunning(
          "the redial's subscribe",
          run,
          () => world.host.subscribes.length >= 2,
        );
        expect(world.host.subscribes).toHaveLength(2);
        serving.settle();
        const ending = await whenDone("the command's end", run);

        // The channel's follow, its redial, then the reply thread's follow.
        expect(hostSaw(world, null)).toEqual({
          framesWithTheStoredSignIn: 0,
          opens: ["held token", "held token", "held token"],
        });
        expect(askedAuthn).toEqual([]);
        expect(ending).toMatchObject({
          answered: {
            data: { outcome: { kind: "replied", text: "All shipped." } },
            exitCode: 0,
          },
        });
        expect(await world.heldToken()).toBeNull();
      } finally {
        serving.settle();
        // A wait still running ends at its own limit, so a failure shows.
        vi.advanceTimersByTime(PAST_EVERY_LIMIT_MS);
        await run;
      }

      // Nothing was saved, so nothing found the person gone from the file. Had
      // the process marked them, this call would end signed-out, asking nothing.
      await writeJsonFileAtomic(madeUpCredentialsPath(), signedIn, 0o600);
      const unary = invitingDoor(world);
      world.mint.respond("ok");
      const next = await whenDone(
        "the next call's end",
        endingOf(callHostRpcAtEndpoint("bot.list", {}, seams.endpoint)),
      );

      // The command's three, then the next call's one.
      expect(presented(world, unary)).toEqual([
        "held token",
        "held token",
        "held token",
        "minted token",
      ]);
      expect(signInFrames(world, unary)).toBe(0);
      expect(askedAuthn).toEqual(["session-grant"]);
      expect(next).toEqual({ answered: { bots: [], mainBotIds: null } });
      expect(await world.heldToken()).toBe(FRESH_HOST_TOKEN);
    },
    TIMEOUT,
  );

  it.each<{
    readonly row: string;
    readonly logOut: (world: World) => Promise<void>;
    readonly opens: readonly string[];
    readonly closes: readonly string[];
    readonly ends: unknown;
  }>([
    {
      row: "removed with the file, so no token is held: nothing",
      logOut: logOutElsewhere,
      opens: ["held token"],
      // The redial's client closes on its own report, before any open.
      closes: ["bot-checkins-settled", "host-token-refused"],
      ends: SIGNED_OUT_ENDING,
    },
    {
      row: "not yet removed, so the token is still held: that token",
      logOut: () => rm(madeUpCredentialsPath()),
      opens: ["held token", "held token"],
      closes: ["bot-checkins-settled", "bot-checkins-settled"],
      ends: {
        answered: expect.objectContaining({
          data: expect.objectContaining({ botId: BOT_ID_A }),
          exitCode: 0,
        }),
      },
    },
  ])(
    "the redial after an expired-token refusal, once the person has left the file, with the row $row alone is sent, with no sign-in and no no-token probe",
    async ({ logOut, opens, closes, ends }) => {
      const world = await useWorld(heldEndingIn(BEYOND_THE_CASE_MS));

      const ending = await readRefusedOnceThePersonIsGone(
        world,
        "token-expired",
        () => logOut(world),
      );

      expect(hostSaw(world, null)).toEqual({
        framesWithTheStoredSignIn: 0,
        opens,
      });
      expect(askedAuthn).toEqual(ONLY_THE_DROPPED_SAVES_MINT);
      expect(ending).toEqual(ends);
      // Two clients: the read did dial again.
      expect(clientCloseReasons(world)).toEqual(closes);
    },
    TIMEOUT,
  );

  it(
    "an older host's bare refusal of a waiting stream's held token after a dropped save: the stream does not redial with the sign-in, and the read ends on the older-host line",
    async () => {
      const world = await useWorld(heldEndingIn(BEYOND_THE_CASE_MS));

      const ending = await readRefusedOnceThePersonIsGone(
        world,
        "released",
        () => logOutElsewhere(world),
      );

      expect(hostSaw(world, null)).toEqual(ONLY_THE_HELD_TOKEN);
      expect(askedAuthn).toEqual(ONLY_THE_DROPPED_SAVES_MINT);
      expect(ending).toEqual({
        code: "E_HOST_INCOMPATIBLE",
        message: olderHostCliError().message,
        details: null,
        exitCode: 1,
      });
      // One client: the read did not dial again.
      expect(clientCloseReasons(world)).toEqual(["bot-checkins-settled"]);
    },
    TIMEOUT,
  );
});

describe("a unary call whose token is answered when the credentials file cannot say it is this person's", () => {
  it(
    "after another program's logout during a command, it ends signed-out: stores nothing, asks authn nothing more, opens nothing",
    async () => {
      const held = heldEndingIn(WITHIN_LEAD_MS);
      const world = await useWorld(held);
      takeTheClockWithLeft(held, WITHIN_LEAD_MS);
      const unary = invitingDoor(world);
      const call = (): Promise<unknown> =>
        endingOf(callHostRpcAtEndpoint("bot.list", {}, seams.endpoint));

      const ending = await answeredAfter(world, call, () =>
        logOutElsewhere(world),
      );

      expect(await leftBehind(world, unary)).toEqual(NOTHING_STORED_OR_SENT);
      expect(askedAuthn).toEqual(ONLY_THE_DROPPED_SAVES_MINT);
      expect(ending).toEqual(SIGNED_OUT_ENDING);
    },
    TIMEOUT,
  );

  it(
    "another person signed in during a command: stores nothing, opens nothing, names neither person, and ends signed-out",
    async () => {
      const held = heldEndingIn(WITHIN_LEAD_MS);
      const world = await useWorld(held);
      takeTheClockWithLeft(held, WITHIN_LEAD_MS);
      const unary = invitingDoor(world);
      const secrets = [
        ...(await privateStrings(world)),
        ...privateStringsOf(ANOTHER_PERSON),
      ];
      const call = (): Promise<unknown> =>
        endingOf(callHostRpcAtEndpoint("bot.list", {}, seams.endpoint));

      const ending = await answeredAfter(world, call, () =>
        signInAnotherPersonElsewhere(world),
      );

      expect(await leftBehind(world, unary)).toEqual(NOTHING_STORED_OR_SENT);
      expect(
        unary.frames.filter((frame) => frame.includes(ANOTHER_PERSON.token)),
      ).toEqual([]);
      expect(carried(world, secrets)).toEqual([]);
      const told = JSON.stringify(ending);
      expect(secrets.filter((secret) => told.includes(secret))).toEqual([]);
      expect(askedAuthn).toEqual(ONLY_THE_DROPPED_SAVES_MINT);
      expect(ending).toEqual(SIGNED_OUT_ENDING);
    },
    TIMEOUT,
  );

  it.each<{ readonly then: MintAnswer }>([
    { then: "ok" },
    { then: "unavailable" },
  ])(
    "after a dropped save, with authn set to answer $then, the next call in the same process ends signed-out: it asks authn nothing and the host sees no open",
    async ({ then }) => {
      const held = heldEndingIn(WITHIN_LEAD_MS);
      const world = await useWorld(held);
      takeTheClockWithLeft(held, WITHIN_LEAD_MS);
      const unary = invitingDoor(world);
      const auth = await resolveHostAuth();
      if (auth === null) throw new Error("the case is not signed in");
      // Held across both calls, so the second reads what the first left in
      // memory. Its sign-in was resolved before the logout.
      const handle = await acquireCliSignIn(auth, null);
      const call = (): Promise<unknown> =>
        endingOf(
          callHostRpcAtResolvedEndpoint(
            "bot.list",
            {},
            seams.endpoint,
            auth,
            PLAIN_DISPATCH,
          ),
        );
      try {
        const first = await answeredAfter(world, call, () =>
          logOutElsewhere(world),
        );
        world.mint.respond(then);

        const next = await whenDone("the next call's end", call());

        expect(await leftBehind(world, unary)).toEqual(NOTHING_STORED_OR_SENT);
        expect(askedAuthn).toEqual(ONLY_THE_DROPPED_SAVES_MINT);
        expect({ first, next }).toEqual({
          first: SIGNED_OUT_ENDING,
          next: SIGNED_OUT_ENDING,
        });
      } finally {
        handle.dispose();
      }
    },
    TIMEOUT,
  );

  it(
    "an older host's bare refusal of the held token after a dropped save: the host sees the held token alone, and the call ends on that refusal",
    async () => {
      const held = heldEndingIn(WITHIN_LEAD_MS);
      const world = await useWorld(held);
      takeTheClockWithLeft(held, WITHIN_LEAD_MS);
      const unary = invitingDoor(world);
      unary.expired = ANSWERS_AT_ONCE("released");
      const call = (): Promise<unknown> =>
        endingOf(callHostRpcAtEndpoint("bot.list", {}, seams.endpoint));

      // The file is gone and logout's forget has not reached the row, so the
      // call still holds a token to go on.
      const ending = await answeredAfter(world, call, () =>
        rm(madeUpCredentialsPath()),
      );

      expect(await leftBehind(world, unary)).toEqual({
        row: world.expiredHeld,
        ...ONLY_THE_HELD_TOKEN,
      });
      expect(askedAuthn).toEqual(ONLY_THE_DROPPED_SAVES_MINT);
      expect(ending).toEqual({
        error: "HostRpcError",
        code: "UNAUTHORIZED",
        message: "door refused: released",
        method: "bot.list",
        fatalDetails: {
          code: "UNAUTHORIZED",
          reason: "door refused: released",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
    },
    TIMEOUT,
  );

  it(
    "a dropped save marks that person alone: a call in the same process for the person the file now holds mints, saves and goes on",
    async () => {
      const held = heldEndingIn(WITHIN_LEAD_MS);
      const world = await useWorld(held);
      takeTheClockWithLeft(held, WITHIN_LEAD_MS);
      const unary = invitingDoor(world);
      const other = nextCasePerson();
      const otherStored: StoredCredentials = {
        ...ANOTHER_PERSON,
        token: other.signIn,
        refreshToken: `rt-${other.signIn}`,
        user: { ...ANOTHER_PERSON.user, id: other.userId },
      };
      const call = (): Promise<unknown> =>
        endingOf(callHostRpcAtEndpoint("bot.list", {}, seams.endpoint));
      const first = await answeredAfter(world, call, async () => {
        await writeJsonFileAtomic(madeUpCredentialsPath(), otherStored, 0o600);
        await clearHostTokenRow(world);
      });
      expect(first).toEqual(SIGNED_OUT_ENDING);
      expect(await leftBehind(world, unary)).toEqual(NOTHING_STORED_OR_SENT);
      expect(askedAuthn).toEqual(ONLY_THE_DROPPED_SAVES_MINT);
      askedAuthn.length = 0;
      world.mint.respond("ok");

      const next = await whenDone("the next call's end", call());

      expect(hostSaw(world, unary)).toEqual({
        framesWithTheStoredSignIn: 0,
        opens: ["minted token"],
      });
      // One mint, bought on the second person's own sign-in.
      expect(askedAuthn).toEqual(["session-grant"]);
      expect(world.mint.requests.at(-1)?.authorization).toBe(
        `Bearer ${other.signIn}`,
      );
      expect(next).toEqual({ answered: { bots: [], mainBotIds: null } });
      expect(await heldTokenOf(other.userId, world.hostId)).toBe(
        FRESH_HOST_TOKEN,
      );
      expect(await world.heldToken()).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "known limit: an unreadable credentials file at the token's save saves nothing, sends no sign-in, and ends on the signed-out line",
    async () => {
      const world = await useWorld("none");
      takeTheClock();
      const unary = invitingDoor(world);
      const call = (): Promise<unknown> =>
        endingOf(callHostRpcAtEndpoint("bot.list", {}, seams.endpoint));

      const ending = await answeredAfter(world, call, async () => {
        // A directory where the file was: a read fails, and not as missing.
        const path = madeUpCredentialsPath();
        await rm(path);
        await mkdir(path);
        await expect(readCredentialsFile(path)).rejects.toMatchObject({
          code: "EISDIR",
        });
      });

      expect(await leftBehind(world, unary)).toEqual(NOTHING_STORED_OR_SENT);
      expect(askedAuthn).toEqual(ONLY_THE_DROPPED_SAVES_MINT);
      expect(ending).toEqual(SIGNED_OUT_ENDING);
    },
    TIMEOUT,
  );
});
