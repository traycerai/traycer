import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_ID_A } from "./bot-test-support";
import {
  ANSWERS_AT_ONCE,
  heldEndingIn,
  openWorld,
  prepareHostFor,
  settle,
  type HomeRef,
  type Member,
  type World,
} from "./expired-host-token-harness";
import { BOT_POST_LISTENER } from "./expired-host-token-members";
import { seams } from "./expired-host-token-seams";
import { buildBotPostCommand } from "../bot-post";

/**
 * `bot post --wait` with a usable host-only token held: no mint is needed, so
 * the wait starts after set-up, as the first dial's run starts (as at
 * 45829027). Set-up that takes a while is not counted against it.
 */
const LIMIT_MS = vi.hoisted(() => 2_000);
const home = vi.hoisted((): HomeRef => ({ path: null }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.path ?? actual.homedir() };
});
vi.mock("../../logger", async () =>
  (await import("./expired-host-token-seams")).loggerModule(),
);
vi.mock("../../internal/host-rpc", async (importOriginal) => ({
  ...(await import("./expired-host-token-seams")).hostRpcModule(
    await importOriginal<typeof import("../../internal/host-rpc")>(),
  ),
  FRAME_TIMEOUT_MS: LIMIT_MS,
}));
vi.mock("../../internal/bot-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../internal/bot-host")>()),
  BOT_SNAPSHOT_DEADLINE_MS: LIMIT_MS,
}));
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

const SETUP_MS = 700;
const WAIT_MS = 1_000;

let world: World;

beforeEach(async () => {
  world = await openWorld(home, heldEndingIn(60 * 60_000));
});

afterEach(async () => {
  await world.close();
});

/** `bot post --wait 1s`, whose reply never comes. */
const WAITING: Member = {
  ...BOT_POST_LISTENER,
  title: "bot post --wait 1s",
  start: (caseWorld) =>
    buildBotPostCommand({ bot: BOT_ID_A, text: "ship it", wait: "1s" })(
      caseWorld.ctx,
    ),
};

describe("bot post --wait with a usable token held", () => {
  it("starts the wait after set-up and waits the full time from there, with no mint", async () => {
    prepareHostFor(WAITING, world);
    world.host.serve = () => [];
    // The held token is usable: the host admits it.
    world.host.expired = ANSWERS_AT_ONCE("admit");
    const route = seams.rpc;
    let setUpEndedAt = 0;
    seams.rpc = async (method, params) => {
      const answer = await route(method, params);
      if (method === "bot.conversation.send") {
        await new Promise((resolve) => setTimeout(resolve, SETUP_MS));
        setUpEndedAt = Date.now();
      }
      return answer;
    };
    const outcome = await settle(WAITING.start(world));
    const waited = Date.now() - setUpEndedAt;

    if (outcome.kind !== "completed") expect.fail("the post failed");
    expect(outcome.result.data).toMatchObject({
      outcome: { kind: "timed-out" },
    });
    // The full wait counted from the run's start, not from the command's.
    expect(waited).toBeGreaterThanOrEqual(WAIT_MS - 150);
    expect(waited).toBeLessThan(WAIT_MS + 900);
    expect(world.host.opens.length).toBeGreaterThan(0);
    expect(world.host.opens[0]?.token).toBe(world.expiredHeld);
    expect(world.mint.requests).toHaveLength(0);
  }, 20_000);
});
