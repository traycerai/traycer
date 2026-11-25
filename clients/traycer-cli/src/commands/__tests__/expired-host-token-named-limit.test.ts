import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import {
  STORED_SIGN_IN,
  openWorld,
  prepareHostFor,
  settle,
  whatThePersonRead,
  type HomeRef,
  type Member,
  type World,
} from "./expired-host-token-harness";
import {
  BOT_CHECKINS,
  WORKTREE_DELETE_BATCH,
} from "./expired-host-token-members";

/**
 * A named limit: a team computer, a held token past its end, the command
 * line's mint unavailable, and the computer refusing the held token
 * `token_expired` before admitting anything. The redial probes, and the team
 * host answers `not_admitted`: it invites no sign-in. Nothing then can be
 * presented, and the command ends at its own bound with that bound's line, not
 * with sign-in advice. The real limits are shortened to 2 s.
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

let world: World;

beforeEach(async () => {
  world = await openWorld(home, null);
});

afterEach(async () => {
  await world.close();
});

describe.each([WORKTREE_DELETE_BATCH, BOT_CHECKINS] as readonly Member[])(
  "$title: a team host that refuses the probe not_admitted",
  (member) => {
    it("writes no sign-in, prints no login line, and ends at its own bound", async () => {
      prepareHostFor(member, world);
      world.host.probe = "not-admitted";
      world.mint.respond("unavailable");
      const startedAt = Date.now();
      const outcome = await settle(member.start(world));
      const elapsed = Date.now() - startedAt;

      // The held token went first, then the probe; no open ever carried the sign-in.
      expect(world.host.opens[0]?.token).toBe(world.expiredHeld);
      expect(world.host.opens[1]?.token).toBe(NO_HOST_TOKEN_PROBE);
      expect(world.host.opens.map((open) => open.token)).not.toContain(
        STORED_SIGN_IN,
      );
      expect(whatThePersonRead(world, outcome)).not.toContain("traycer login");
      expect(outcome).toMatchObject({ kind: "failed" });
      expect(elapsed).toBeGreaterThanOrEqual(LIMIT_MS - 150);
      expect(elapsed).toBeLessThan(LIMIT_MS + 900);
      // The line the code gives at the bound.
      if (member === WORKTREE_DELETE_BATCH) {
        expect(outcome).toMatchObject({
          code: "E_UNEXPECTED",
          message: expect.stringContaining(
            "worktree delete stream dropped before the host reported a result",
          ),
        });
      } else {
        expect(outcome).toMatchObject({
          code: "E_HOST_UNREACHABLE",
          message: expect.stringContaining("no answer in time"),
        });
      }
    }, 20_000);
  },
);
