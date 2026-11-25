import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import {
  ANSWERS_AT_ONCE,
  FRESH_HOST_TOKEN,
  STORED_SIGN_IN,
  deferred,
  openWorld,
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
    const startedAt = Date.now();
    const run = callHostRpc("bot.list", {});
    await unary.whenOpened(0);
    const wentAfterMs = Date.now() - startedAt;
    expect(wentAfterMs).toBeGreaterThanOrEqual(9_500);
    expect(wentAfterMs).toBeLessThanOrEqual(15_500);
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

describe("a create-like call with no cached grant, on a personal host", () => {
  it("goes on the grant the mint bought before the host's owner_sign_in, and the stored sign-in never leaves", async () => {
    await world.close();
    world = await openWorld(home, "none");
    unary = new UnaryDoor(world.mint, world.expiredHeld);
    liveUnary.door = unary;
    unary.serve = () => ({ bots: [], mainBotIds: null });
    // The host answers the probe with its owner-sign-in invitation only after
    // the mint has answered.
    const invitation = deferred();
    unary.probe = { answer: "owner-sign-in", after: invitation.promise };
    const run = callHostRpcWithDispatch(
      "bot.list",
      {},
      {
        ...PLAIN_DISPATCH,
        failFast: true,
        reauthenticate: "before-request",
        idempotencyKey: "task-1",
      },
    );
    await unary.whenOpened(0);
    world.mint.respond("ok");
    await vi.waitFor(
      () => expect(world.mint.requests.length).toBeGreaterThan(0),
      { timeout: 5_000, interval: 5 },
    );
    // The grant is saved before the host speaks.
    await vi.waitFor(
      async () => expect(await world.heldToken()).toBe(FRESH_HOST_TOKEN),
      { timeout: 5_000, interval: 5 },
    );
    invitation.settle();
    await run;
    expect(unary.opens.map((open) => open.token)).toEqual([
      NO_HOST_TOKEN_PROBE,
      FRESH_HOST_TOKEN,
    ]);
    expect(unary.opens.map((open) => open.token)).not.toContain(STORED_SIGN_IN);
    expect(
      unary.requests.filter((request) => request.method === "bot.list"),
    ).toHaveLength(1);
  }, 20_000);
});
