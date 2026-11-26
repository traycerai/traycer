import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STREAM_CAPABILITY_CREDENTIAL_UPDATE } from "@traycer/protocol/framework/stream-ws-protocol";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { createHostTokenFilePersistence } from "@traycer-clients/shared/auth/host-token-file";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import type { WsStreamClient } from "../../../../shared/host-transport/ws-stream-client";
import { createWhatwgStreamWebSocketFactory } from "../../../../shared/host-transport/whatwg-stream-ws-factory";
import { CLI_CLIENT_IDENTITY } from "../../cli-version";
import { config } from "../../config";
import {
  requireCliHostSession,
  type CliHostSession,
} from "../../internal/cli-host-tokens";
import { nextCasePerson } from "../../internal/__tests__/case-person-test-support";
import { resolveHostAuth } from "../../internal/host-auth";
import { callHostRpcAtEndpoint } from "../../internal/host-rpc";
import {
  runLocalStream,
  type LocalStreamDial,
} from "../../internal/local-stream";
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
  type World,
} from "./expired-host-token-harness";
import { BOT_CHECKINS, BOT_POST_LISTENER } from "./expired-host-token-members";
import { liveUnary, seams } from "./expired-host-token-seams";
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
});

afterEach(async () => {
  vi.useRealTimers();
  liveUnary.door = null;
  const world = opened;
  opened = null;
  if (world !== null) await world.close();
});

async function useWorld(held: HeldToken): Promise<World> {
  const world = await openWorld(home, held);
  opened = world;
  // The held token is usable: the host admits it.
  world.host.expired = ANSWERS_AT_ONCE("admit");
  world.host.capabilities = [STREAM_CAPABILITY_CREDENTIAL_UPDATE];
  return world;
}

/** From here the clock moves only when the case moves it. */
function takeTheClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

/** One turn of the event loop, which a faked clock does not hold back. */
function oneTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Lets the taken clock follow the real one until `reached`: a real operation in
 * between may wait on a timer of its own (the credentials lock's retry).
 */
async function until(what: string, reached: () => boolean): Promise<void> {
  const giveUpAt = performance.now() + 5_000;
  let followedTo = performance.now();
  while (!reached()) {
    if (performance.now() > giveUpAt) throw new Error(`never saw ${what}`);
    await oneTurn();
    const elapsedMs = Math.floor(performance.now() - followedTo);
    followedTo += elapsedMs;
    await vi.advanceTimersByTimeAsync(elapsedMs);
  }
}

/** `work`'s own answer, awaited under the taken clock. */
async function whenDone<T>(what: string, work: Promise<T>): Promise<T> {
  let done = false;
  const settling = work.finally(() => {
    done = true;
  });
  settling.catch(() => undefined);
  await until(what, () => done);
  return settling;
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
  const outcome = settle(BOT_CHECKINS.start(world)).finally(() => {
    settled = true;
  });
  await until("the read's subscribe", () => world.host.subscribes.length > 0);
  return { outcome, settled: () => settled, serve: serving.settle };
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
    refused: () => Promise.reject(new Error("a mint refusal ended the dial")),
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
      takeTheClock();
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
        await read?.outcome;
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
      takeTheClock();
      let read: RunningRead | null = null;
      try {
        read = await admittedRead(world);
        world.mint.respond(answer);
        await fireRenewalTimer(held.expiresAtMs, 1);
        expect(observed.timerRenewals).toHaveLength(1);
        expect(await timerRenewal(0)).toBe(held.expiresAtMs);
        // A told listener asks the gate, whose first step is this read of the
        // credentials file; one asked after it answers after it.
        const session = observed.sessions.at(-1);
        if (session === undefined) expect.fail("the read opened no session");
        await whenDone("the file read", session.tokens.adoptStoredSignIn());
        await vi.advanceTimersByTimeAsync(3_000);

        expect(observed.timerRenewals).toHaveLength(1);
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
        vi.useRealTimers();
        read?.serve();
        await read?.outcome;
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
      takeTheClock();
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
        await until("the subscribe", () => world.host.subscribes.length > 0);
        await fireRenewalTimer(held.expiresAtMs, 1);
        expect(observed.timerRenewals).toHaveLength(1);
        await until("the mint", () => world.mint.requests.length === 1);

        // The held token's end passes with authn silent: the host cuts the
        // stream, and the dial ends.
        vi.setSystemTime(held.expiresAtMs + 1_000);
        world.host.watchReaches(0, held.expiresAtMs);
        expect(await whenDone("the dial's end", dialled)).toBe("closed");
        world.mint.respond("ok");
        const renewedEndMs = await timerRenewal(0);
        if (renewedEndMs === null) expect.fail("the renewal left no token");
        expect(renewedEndMs).toBeGreaterThan(held.expiresAtMs);

        expect(world.host.updates).toEqual([]);
        await vi.advanceTimersByTimeAsync(
          untilLeadBefore(renewedEndMs) + 1_000,
        );
        expect(observed.timerRenewals).toHaveLength(1);
        expect(world.mint.requests).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        world.mint.respond("unavailable");
        world.host.watchReaches(0, held.expiresAtMs);
        await dialled;
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
      takeTheClock();
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
        await read?.outcome;
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
      takeTheClock();
      let read: RunningRead | null = null;
      try {
        read = await admittedRead(world);
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
        await read?.outcome;
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
      takeTheClock();
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
        await until("the subscribe", () => world.host.subscribes.length > 0);
        await fireRenewalTimer(held.expiresAtMs, 1);
        expect(observed.timerRenewals).toHaveLength(1);
        await until("the mint", () => world.mint.requests.length === 1);

        // A second stream on the client opens: its open reads the bearer.
        stream.client?.subscribe("bot.subscribe", { botId: BOT_ID_A });
        await until(
          "the second subscribe",
          () => world.host.subscribes.length === 2,
        );
        expect(world.host.opens[1]).toMatchObject({
          token: world.expiredHeld,
          mintStillOut: true,
        });
        // Its admission arms the timer again, due at once: it joins too.
        await until(
          "the second timer renewal",
          () => observed.timerRenewals.length === 2,
        );
        world.mint.respond("ok");
        await timerRenewalsDone();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(world.mint.requests).toHaveLength(1);
        expect(
          new Set(
            world.host.updates.map(({ index, token }) => `${index} ${token}`),
          ),
        ).toEqual(new Set([`0 ${FRESH_HOST_TOKEN}`, `1 ${FRESH_HOST_TOKEN}`]));
      } finally {
        vi.useRealTimers();
        world.mint.respond("unavailable");
        done.settle();
        await dialled;
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
      takeTheClock();
      let read: RunningRead | null = null;
      try {
        read = await admittedRead(world);
        await fireRenewalTimer(held.expiresAtMs, 1);
        expect(observed.timerRenewals).toHaveLength(1);
        await until("the mint", () => world.mint.requests.length === 1);
        // authn answers 10 s later. Both tokens end after the held one, and
        // still within the lead: the sign-in that buys them ends then.
        vi.setSystemTime(Date.now() + 10_000);
        const first = mintedEndingIn("capped", LEAD_MS - 5_000, 2_000);
        const second = mintedEndingIn("capped-again", LEAD_MS - 3_000, 0);
        world.mint.issued = first;
        const refresh = acceptRefresh(world, second);
        world.mint.respond("ok");
        expect(await timerRenewal(0)).toBeGreaterThan(held.expiresAtMs);
        // Whatever the renewal's push leads to is due within these.
        for (let pass = 0; pass < 2; pass += 1) {
          await vi.advanceTimersByTimeAsync(500);
          await timerRenewalsDone();
        }

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
        vi.useRealTimers();
        read?.serve();
        await read?.outcome;
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

/** Settles once a call has taken its next step: a mint request or an open. */
async function whenNextStep(
  world: World,
  unary: UnaryDoor,
  stepsBefore: number,
): Promise<void> {
  await vi.waitFor(() =>
    expect(world.mint.requests.length + unary.opens.length).toBeGreaterThan(
      stepsBefore,
    ),
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
      const run = settle(BOT_CHECKINS.start(world));
      try {
        await world.host.whenOpenedAs([world.expiredHeld]);
        expect(world.mint.requests).toHaveLength(1);
        // authn is back by the time the host admits.
        world.mint.respond("ok");
        admission.settle();
        await vi.waitFor(() =>
          expect(observed.timerRenewals.length).toBeGreaterThan(0),
        );
        await observed.timerRenewals[0];
        expect(world.mint.requests).toHaveLength(2);
        expect(pushed(world)).toEqual([
          { index: 0, token: FRESH_HOST_TOKEN, installed: true },
        ]);
        serving.settle();
        BOT_CHECKINS.expectNormalResult(await run);
      } finally {
        admission.settle();
        serving.settle();
        world.mint.respond("unavailable");
        await run;
      }
    },
    TIMEOUT,
  );
});

describe("a unary call whose held token ends within the lead", () => {
  async function unaryCase(): Promise<{
    readonly world: World;
    readonly unary: UnaryDoor;
    readonly call: () => Promise<unknown>;
  }> {
    const world = await useWorld(heldEndingIn(WITHIN_LEAD_MS));
    const unary = new UnaryDoor(world.mint, world.expiredHeld);
    liveUnary.door = unary;
    unary.expired = ANSWERS_AT_ONCE("admit");
    unary.serve = () => ({ bots: [], mainBotIds: null });
    return {
      world,
      unary,
      call: () => callHostRpcAtEndpoint("bot.list", {}, seams.endpoint),
    };
  }

  it(
    "asks once before the request, and the request presents the new token",
    async () => {
      const { world, unary, call } = await unaryCase();
      const run = call();
      try {
        await vi.waitFor(() =>
          expect(
            world.mint.requests.length + unary.opens.length,
          ).toBeGreaterThan(0),
        );
        expect(world.mint.requests).toHaveLength(1);
        expect(unary.opens).toEqual([]);
        world.mint.respond("ok");
        expect(await run).toMatchObject({ bots: [] });
        expect(unary.opens.map((open) => open.token)).toEqual([
          FRESH_HOST_TOKEN,
        ]);
        expect(unary.requests).toEqual([{ index: 0, method: "bot.list" }]);
        expect(world.mint.requests).toHaveLength(1);
      } finally {
        world.mint.respond("unavailable");
        await run.catch(() => undefined);
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
      expect(await call()).toMatchObject({ bots: [] });
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
      expect(await call()).toMatchObject({ bots: [] });
      expect(world.mint.requests).toHaveLength(1);
      // From here authn answers nothing: a call that asked would wait on it.
      world.mint.hold();
      const second = call();
      try {
        await whenNextStep(world, unary, 2);
        expect(world.mint.requests).toHaveLength(1);
        expect(await second).toMatchObject({ bots: [] });
        expect(unary.opens.map((open) => open.token)).toEqual([
          world.expiredHeld,
          world.expiredHeld,
        ]);
      } finally {
        world.mint.respond("unavailable");
        await second.catch(() => undefined);
      }
    },
    TIMEOUT,
  );

  it(
    "while a renewal is out, a second call does not wait for it",
    async () => {
      const { world, unary, call } = await unaryCase();
      const first = call();
      let second: Promise<unknown> | null = null;
      try {
        await vi.waitFor(() => expect(world.mint.requests).toHaveLength(1));
        second = call();
        await vi.waitFor(() => expect(unary.requests).toHaveLength(1));
        expect(unary.opens).toEqual([
          { index: 0, token: world.expiredHeld, mintStillOut: true },
        ]);
        expect(await second).toMatchObject({ bots: [] });

        world.mint.respond("ok");
        expect(await first).toMatchObject({ bots: [] });
        expect(unary.opens.map((open) => open.token)).toEqual([
          world.expiredHeld,
          FRESH_HOST_TOKEN,
        ]);
        expect(world.mint.requests).toHaveLength(1);
      } finally {
        world.mint.respond("unavailable");
        await first.catch(() => undefined);
        await second?.catch(() => undefined);
      }
    },
    // Were the second call to wait, both would open only once the mint timed
    // out: the case ends on its assertion, not on this.
    2 * TIMEOUT,
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

      expect(await call()).toMatchObject({ bots: [] });

      expect(
        world.mint.requests.map((request) => request.authorization),
      ).toEqual([`Bearer ${STORED_SIGN_IN}`, `Bearer ${REFRESHED_SIGN_IN}`]);
      expect(refresh.accepted()).toBe(1);
      expect(unary.opens.map((open) => open.token)).toEqual([second]);
      expect(unary.requests).toEqual([{ index: 0, method: "bot.list" }]);

      // The token bought last is still within the lead.
      world.mint.hold();
      unary.openAt.set(1, ANSWERS_AT_ONCE("admit"));
      const later = call();
      try {
        await whenNextStep(world, unary, 3);
        expect(world.mint.requests).toHaveLength(2);
        expect(await later).toMatchObject({ bots: [] });
        expect(unary.opens.map((open) => open.token)).toEqual([second, second]);
      } finally {
        world.mint.respond("unavailable");
        await later.catch(() => undefined);
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
      expect(await call()).toMatchObject({ bots: [] });
      expect(unary.opens.map((open) => open.token)).toEqual([bought]);

      // Only the wall clock moves: the bought token now ends within the lead.
      vi.useFakeTimers({ toFake: ["Date"] });
      let waiting: Promise<unknown> | null = null;
      let later: Promise<unknown> | null = null;
      try {
        vi.setSystemTime(Date.now() + 90_000);
        world.mint.hold();
        waiting = call();
        await whenNextStep(world, unary, 2);
        // It asked, and sends nothing while authn has not answered.
        expect(world.mint.requests).toHaveLength(2);
        expect(unary.opens).toHaveLength(1);
        world.mint.respond("unavailable");
        expect(await waiting).toMatchObject({ bots: [] });

        world.mint.hold();
        later = call();
        await whenNextStep(world, unary, 4);
        expect(world.mint.requests).toHaveLength(2);
        expect(await later).toMatchObject({ bots: [] });
        expect(unary.opens.map((open) => open.token)).toEqual([
          bought,
          bought,
          bought,
        ]);
      } finally {
        vi.useRealTimers();
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
      const { world, unary, call } = await unaryCase();
      const other = nextCasePerson();
      const otherHeld: HeldToken = {
        token: mintedEndingIn("other-person", WITHIN_LEAD_MS, 600_000),
        expiresAtMs: Date.now() + WITHIN_LEAD_MS,
      };
      for (const index of [1, 2])
        unary.openAt.set(index, ANSWERS_AT_ONCE("admit"));
      world.mint.respond("unavailable");
      await call();
      await signInAs(other.userId, other.signIn);
      await saveHostToken(other.userId, world.hostId, otherHeld);
      // The second person's own first call waits on their own renewal.
      await call();
      expect(
        world.mint.requests.map((request) => request.authorization),
      ).toEqual([`Bearer ${STORED_SIGN_IN}`, `Bearer ${other.signIn}`]);

      await signInAs(world.userId, STORED_SIGN_IN);
      await saveHostToken(world.userId, world.hostId, {
        token: world.expiredHeld,
        expiresAtMs: Date.now() + WITHIN_LEAD_MS,
      });
      world.mint.hold();
      const again = call();
      try {
        await whenNextStep(world, unary, 4);
        expect(world.mint.requests).toHaveLength(2);
        await again;
        expect(unary.opens.map((open) => open.token)).toEqual([
          world.expiredHeld,
          otherHeld.token,
          world.expiredHeld,
        ]);
      } finally {
        world.mint.respond("unavailable");
        await again.catch(() => undefined);
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
      expect(await call()).toMatchObject({ bots: [] });
      expect(world.mint.requests).toHaveLength(1);

      // No call is running: the next one's handle loads the file anew.
      await saveHostToken(world.userId, world.hostId, saved);
      world.mint.hold();
      const waiting = call();
      let later: Promise<unknown> | null = null;
      try {
        await whenNextStep(world, unary, 2);
        // It asked, and sends nothing while authn has not answered.
        expect(world.mint.requests).toHaveLength(2);
        expect(unary.opens).toHaveLength(1);
        world.mint.respond("unavailable");
        expect(await waiting).toMatchObject({ bots: [] });

        world.mint.hold();
        later = call();
        await whenNextStep(world, unary, 4);
        expect(world.mint.requests).toHaveLength(2);
        expect(await later).toMatchObject({ bots: [] });
        expect(unary.opens.map((open) => open.token)).toEqual([
          world.expiredHeld,
          saved.token,
          saved.token,
        ]);
      } finally {
        world.mint.respond("unavailable");
        await waiting.catch(() => undefined);
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
      try {
        // authn answers nothing while the command runs.
        const outcome = await settle(
          buildBotPostCommand({ bot: BOT_ID_A, text: "ship it", wait: "1s" })(
            world.ctx,
          ),
        );
        if (outcome.kind !== "completed") expect.fail(outcome.message);
        expect(outcome.result.data).toMatchObject({
          outcome: { kind: "timed-out" },
        });
        expect(world.host.opens).toEqual([]);
        expect(world.mint.requests).toHaveLength(1);
      } finally {
        world.mint.respond("unavailable");
      }
    },
    TIMEOUT,
  );
});
