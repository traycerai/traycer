import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import {
  ANSWERS_AT_ONCE,
  FRESH_HOST_TOKEN,
  STORED_SIGN_IN,
  deferred,
  holdPublication,
  openWorld,
  personOf,
  whenPublishedInProcess,
  type HomeRef,
  type World,
} from "./expired-host-token-harness";
import { UnaryDoor } from "./expired-host-token-unary-door";
import { liveUnary } from "./expired-host-token-seams";
import {
  PLAIN_DISPATCH,
  callHostRpc,
  callHostRpcWithDispatch,
} from "../../internal/host-rpc";

/**
 * A unary call with a held host-only token past its end waits for the mint
 * before the call (bounded), then goes with what the token rules give. A call
 * that must not wait (`failFast`) goes at once. The calls go through the real
 * `callHostRpc`, on a fake unary socket.
 */

const home = vi.hoisted((): HomeRef => ({ path: null }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.path ?? actual.homedir() };
});
vi.mock(
  "@traycer-clients/shared/auth/host-token-file",
  async (importOriginal) =>
    (await import("./expired-host-token-seams")).hostTokenFileModule(
      await importOriginal<
        typeof import("@traycer-clients/shared/auth/host-token-file")
      >(),
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

let world: World;
let unary: UnaryDoor;

beforeEach(async () => {
  world = await openWorld(home, null);
  unary = new UnaryDoor(world.mint, world.expiredHeld);
  liveUnary.door = unary;
  unary.serve = (method) => {
    switch (method) {
      case "bot.list":
        return { bots: [], mainBotIds: null };
      case "providers.cancelLogin":
        return { cancelled: true };
      default:
        throw new Error(`unexpected host RPC ${method}`);
    }
  };
});

afterEach(async () => {
  liveUnary.door = null;
  await world.close();
});

async function whenMintAsked(): Promise<void> {
  await vi.waitFor(
    () => expect(world.mint.requests.length).toBeGreaterThan(0),
    {
      timeout: 5_000,
      interval: 5,
    },
  );
}

/** One turn of the event loop, which a faked clock does not hold back. */
function oneTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("a unary call with a held token past its end", () => {
  it("waits for the mint within its budget and presents the fresh token: the host sees one request", async () => {
    const run = callHostRpc("bot.list", {});
    await whenMintAsked();
    expect(unary.opens).toHaveLength(0);
    world.mint.respond("ok");
    await run;
    expect(unary.opens.map((open) => open.token)).toEqual([FRESH_HOST_TOKEN]);
    expect(unary.requests.map((request) => request.method)).toEqual([
      "bot.list",
    ]);
    expect(world.mint.requests).toHaveLength(1);
  }, 30_000);

  it("goes with the held token when the mint outlasts its bound", async () => {
    // The host cannot reach authn either, so it admits the held token.
    unary.expired = ANSWERS_AT_ONCE("admit");
    // The clock is the test's: it moves only when the test moves it. File and
    // socket work still runs, a turn of the event loop at a time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let run: Promise<unknown>;
    try {
      const startedAt = Date.now();
      run = callHostRpc("bot.list", {});
      while (world.mint.requests.length === 0) await oneTurn();
      let wentAfterMs: number | null = null;
      void unary.whenOpenedAs([world.expiredHeld]).then(() => {
        wentAfterMs = Date.now() - startedAt;
      });
      await vi.advanceTimersByTimeAsync(9_499);
      for (let turn = 0; turn < 50; turn += 1) await oneTurn();
      expect(unary.opens).toHaveLength(0);
      while (wentAfterMs === null && Date.now() - startedAt < 15_500) {
        await vi.advanceTimersByTimeAsync(100);
        for (let turn = 0; turn < 10; turn += 1) await oneTurn();
      }
      expect(wentAfterMs).toBeGreaterThanOrEqual(9_500);
      expect(wentAfterMs).toBeLessThanOrEqual(15_500);
    } finally {
      vi.useRealTimers();
    }
    await run;
    expect(unary.opens.map((open) => open.token)).toEqual([world.expiredHeld]);
    expect(unary.requests).toHaveLength(1);
    expect(world.mint.requests).toHaveLength(1);
  }, 40_000);

  it("is recovered by a failFast call from the mint already running: one mint request, within the 3 s a release is given", async () => {
    // The host refuses the held token before the request is sent.
    const startedAt = Date.now();
    const run = callHostRpcWithDispatch(
      "providers.cancelLogin",
      { providerId: "claude" } as never,
      { ...PLAIN_DISPATCH, failFast: true },
    );
    await unary.whenRefused(0);
    // The open started the mint without waiting; the recovery finds it.
    world.mint.respondAfter(300, "ok");
    expect(await run).toMatchObject({ cancelled: true });
    // One mint, started by the open: the recovery did not start another.
    expect(world.mint.requests).toHaveLength(1);
    expect(unary.opens[0]?.token).toBe(world.expiredHeld);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  }, 20_000);

  it("is not waited for by a failFast call: it goes at once with the held token", async () => {
    unary.expired = ANSWERS_AT_ONCE("admit");
    const startedAt = Date.now();
    const answer = await callHostRpcWithDispatch(
      "providers.cancelLogin",
      { providerId: "claude" } as never,
      { ...PLAIN_DISPATCH, failFast: true },
    );
    expect(answer).toMatchObject({ cancelled: true });
    // Well inside the 3 s a release is given, with the mint still out.
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(unary.opens.map((open) => open.token)).toEqual([world.expiredHeld]);
  }, 20_000);
});

/**
 * A create-like call with no cached grant, on a host whose answer to the
 * no-token probe is its `owner_sign_in` invitation. What the call presents
 * after the invitation is read in this process, at the moment the invitation
 * arrives (`ownerSignInEligible`): the grant the mint bought counts once it is
 * published in the process, not once it is on disk.
 */
const CREATE_LIKE = {
  ...PLAIN_DISPATCH,
  failFast: true,
  reauthenticate: "before-request",
  idempotencyKey: "task-1",
} as const;

async function reopenWithoutHeldToken(): Promise<void> {
  await world.close();
  world = await openWorld(home, "none");
  unary = new UnaryDoor(world.mint, world.expiredHeld);
  liveUnary.door = unary;
  unary.serve = () => ({ bots: [], mainBotIds: null });
}

function startCreateLikeCall(): Promise<unknown> {
  return callHostRpcWithDispatch("bot.list", {}, CREATE_LIKE).then(
    (value) => ({ ok: value }),
    (error: unknown) => ({ error }),
  );
}

const botListRequests = (): number =>
  unary.requests.filter((request) => request.method === "bot.list").length;

describe("a create-like call with no cached grant, on this person's own computer", () => {
  it("goes on the grant the mint bought once it is published in the process, before the host's owner_sign_in: the sign-in never leaves", async () => {
    await reopenWithoutHeldToken();
    // The host answers the probe with its owner-sign-in invitation only after
    // the mint has answered.
    const invitation = deferred();
    unary.probe = { answer: "owner-sign-in", after: invitation.promise };
    const run = startCreateLikeCall();
    await unary.whenOpenedAs([NO_HOST_TOKEN_PROBE]);
    const person = await personOf(world);
    try {
      world.mint.respond("ok");
      // What the choice reads: the grant is published in this process.
      await whenPublishedInProcess(person, world);
      invitation.settle();
      expect(await run).toMatchObject({ ok: { bots: [] } });
      expect(unary.opens.map((open) => open.token)).toEqual([
        NO_HOST_TOKEN_PROBE,
        FRESH_HOST_TOKEN,
      ]);
      expect(botListRequests()).toBe(1);
    } finally {
      person.dispose();
    }
  }, 20_000);

  it("goes on the person's sign-in when the host's invitation comes while the grant is on disk but not yet published in the process: one request, nothing else sent", async () => {
    await reopenWithoutHeldToken();
    const lag = holdPublication();
    const invitation = deferred();
    unary.probe = { answer: "owner-sign-in", after: invitation.promise };
    const run = startCreateLikeCall();
    await unary.whenOpenedAs([NO_HOST_TOKEN_PROBE]);
    const person = await personOf(world);
    try {
      world.mint.respond("ok");
      await lag.written;
      // On disk, and not yet published: the state the choice reads still
      // says no grant is held.
      expect(await world.heldToken()).toBe(FRESH_HOST_TOKEN);
      expect(person.tokens.ownerSignInEligible(world.hostId)).toBe(true);
      invitation.settle();
      await unary.whenOpenedAs([NO_HOST_TOKEN_PROBE, STORED_SIGN_IN]);
      lag.release();
      expect(await run).toMatchObject({ ok: { bots: [] } });
      expect(unary.opens.map((open) => open.token)).toEqual([
        NO_HOST_TOKEN_PROBE,
        STORED_SIGN_IN,
      ]);
      expect(unary.requests).toEqual([{ index: 1, method: "bot.list" }]);
      expect(world.mint.requests).toHaveLength(1);
    } finally {
      lag.release();
      person.dispose();
    }
  }, 20_000);
});
