import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import {
  STORED_SIGN_IN,
  openWorld,
  prepareHostFor,
  settle,
  type HomeRef,
  type World,
} from "./expired-host-token-harness";
import { WORKTREE_DELETE_BATCH } from "./expired-host-token-members";

/**
 * The bound, measured on the production numbers (nothing shortened): a mint
 * authn never answers is bounded by the mint's own timeout, and the command's
 * own 15 s starts at the first dial, after it.
 */

const home = vi.hoisted((): HomeRef => ({ path: null }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.path ?? actual.homedir() };
});
vi.mock("../../logger", async () =>
  (await import("./expired-host-token-seams")).loggerModule(),
);
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

let world: World;

beforeEach(async () => {
  world = await openWorld(home, null);
});

afterEach(async () => {
  await world.close();
});

describe("worktree delete with a mint authn never answers", () => {
  it("opens its first stream after the mint's own bound, and the 15 s then starts", async () => {
    prepareHostFor(WORKTREE_DELETE_BATCH, world);
    const startedAt = Date.now();
    const run = settle(WORKTREE_DELETE_BATCH.start(world));
    await world.host.whenOpenedAs([world.expiredHeld]);
    const firstOpenAfterMs = Date.now() - startedAt;
    // The one mint before the dial is the only request until the host first answers.
    const requestsBeforeAnswer = world.mint.requests.length;
    // Measured at 10012 ms (worktree) and 10005 ms (unary) on c1-v2.
    // The mint is bounded at 10 s; nothing waits longer than that for it.
    expect(firstOpenAfterMs).toBeGreaterThanOrEqual(9_500);
    expect(firstOpenAfterMs).toBeLessThan(13_000);
    const outcome = await run;
    WORKTREE_DELETE_BATCH.expectNormalResult(outcome);
    // The mint failed, so the held token went first, then the probe, then the
    // stored sign-in as the host named it, all inside the command's own 15 s
    // counted from the first dial.
    expect(world.host.opens.slice(0, 3).map((open) => open.token)).toEqual([
      world.expiredHeld,
      NO_HOST_TOKEN_PROBE,
      STORED_SIGN_IN,
    ]);
    expect(requestsBeforeAnswer).toBe(1);
    // The host's typed `token_expired` refusal of the held token is answered
    // with a fresh mint, as at 45829027: exactly one after the first answer.
    expect(world.mint.requests).toHaveLength(2);
  }, 40_000);
});
