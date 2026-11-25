import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import { BOT_ID_A } from "./bot-test-support";
import {
  STORED_SIGN_IN,
  deferred,
  flush,
  openWorld,
  prepareHostFor,
  settle,
  whatThePersonRead,
  type HomeRef,
  type Member,
  type Outcome,
  type World,
} from "./expired-host-token-harness";
import {
  BOT_CHECKINS,
  BOT_LIST,
  BOT_POST_LISTENER,
  WORKTREE_DELETE_BATCH,
  WORKTREE_DELETE_LEGACY,
} from "./expired-host-token-members";
import { rpcCalls } from "./expired-host-token-seams";
import { buildBotPostCommand } from "../bot-post";

/**
 * The caller's own limit starts at the FIRST DIAL, after the mint: a mint that
 * is slow (the real one is bounded at 10 s) is outside `worktree delete`'s
 * 15 s and the bot reads' bound; for `bot post --wait` the wait is the
 * person's total, so the mint counts against it.
 *
 * The real limits are shortened to 2 s so a real clock can run them: the two
 * constants are replaced where the commands import them, `--wait` is asked
 * for as `2s`, and the mint is answered after 3 s (the 10 s of the brief, at
 * the same scale: longer than the limit).
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

const MINT_SLOW_MS = LIMIT_MS + 1_000;

let world: World;

beforeEach(async () => {
  world = await openWorld(home, null);
});

afterEach(async () => {
  await world.close();
});

/** `bot post --wait 2s`: the person's wait is the limit. */
const BOT_POST_WAITING: Member = {
  ...BOT_POST_LISTENER,
  title: "bot post --wait",
  start: (caseWorld) =>
    buildBotPostCommand({ bot: BOT_ID_A, text: "ship it", wait: "2s" })(
      caseWorld.ctx,
    ),
};

function timed(member: Member): {
  readonly startedAt: number;
  readonly run: Promise<Outcome>;
  readonly elapsed: () => Promise<number>;
} {
  const startedAt = Date.now();
  const run = settle(member.start(world));
  return {
    startedAt,
    run,
    elapsed: async () => {
      await run;
      return Date.now() - startedAt;
    },
  };
}

/** What each command ends with when its limit passes before it was answered. */
function expectEndedAtItsLimit(member: Member, outcome: Outcome): void {
  if (member === WORKTREE_DELETE_BATCH) {
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(whatThePersonRead(world, outcome)).toContain(
      "worktree delete stream dropped before the host reported a result",
    );
  } else if (member === BOT_CHECKINS) {
    expect(outcome).toMatchObject({
      kind: "failed",
      code: "E_HOST_UNREACHABLE",
    });
    expect(whatThePersonRead(world, outcome)).toContain("no answer in time");
  } else if (member === BOT_LIST) {
    if (outcome.kind !== "completed")
      expect.fail(`the command threw: ${outcome.message}`);
    expect(outcome.result.exitCode).toBe(1);
    expect(outcome.result.data).toMatchObject({
      environments: [{ bots: [{ botId: BOT_ID_A, readFailed: true }] }],
    });
  } else {
    if (outcome.kind !== "completed")
      expect.fail(`the command failed: ${outcome.message}`);
    expect(outcome.result.data).toMatchObject({
      outcome: { kind: "timed-out" },
    });
  }
  expect(whatThePersonRead(world, outcome)).not.toContain("traycer login");
}

const STREAM_READS: readonly Member[] = [
  WORKTREE_DELETE_BATCH,
  BOT_CHECKINS,
  BOT_LIST,
];

describe.each(STREAM_READS)("$title: a black-holed mint", (member) => {
  it("is outside the limit: the limit starts at the first dial, and the command completes", async () => {
    prepareHostFor(member, world);
    world.mint.respondAfter(MINT_SLOW_MS, "unavailable");
    const run = timed(member);
    const outcome = await run.run;
    member.expectNormalResult(outcome);
    // The command ran longer than its limit end to end, and was not cut by it.
    expect(await run.elapsed()).toBeGreaterThanOrEqual(MINT_SLOW_MS - 100);
    expect(world.host.opens.slice(0, 3).map((open) => open.token)).toEqual([
      world.expiredHeld,
      NO_HOST_TOKEN_PROBE,
      STORED_SIGN_IN,
    ]);
  }, 20_000);
});

describe("bot post --wait: a black-holed mint", () => {
  it("races the person's wait: timed out at the wait, no open sent, and the message line stays", async () => {
    prepareHostFor(BOT_POST_WAITING, world);
    world.mint.respondAfter(MINT_SLOW_MS, "ok");
    const run = timed(BOT_POST_WAITING);
    const outcome = await run.run;
    const elapsed = await run.elapsed();
    expectEndedAtItsLimit(BOT_POST_WAITING, outcome);
    // The wait is the person's total: the command ended at it, not when the
    // mint finally answered.
    expect(elapsed).toBeGreaterThanOrEqual(LIMIT_MS - 150);
    expect(elapsed).toBeLessThan(MINT_SLOW_MS - 300);
    if (outcome.kind !== "completed") expect.fail("the post failed");
    expect(outcome.result.human).toContain("Posted to");
    expect(world.host.opens).toHaveLength(0);
    expect(world.host.subscribes).toHaveLength(0);
    expect(
      rpcCalls.filter((method) => method === "bot.conversation.send"),
    ).toHaveLength(1);
  }, 20_000);

  it("--wait 1s with a mint that never answers returns within its wait", async () => {
    const waitOneSecond: Member = {
      ...BOT_POST_LISTENER,
      title: "bot post --wait 1s",
      start: (caseWorld) =>
        buildBotPostCommand({ bot: BOT_ID_A, text: "ship it", wait: "1s" })(
          caseWorld.ctx,
        ),
    };
    prepareHostFor(waitOneSecond, world);
    const run = timed(waitOneSecond);
    const outcome = await run.run;
    const elapsed = await run.elapsed();
    if (outcome.kind !== "completed") expect.fail("the post failed");
    expect(outcome.result.data).toMatchObject({
      outcome: { kind: "timed-out" },
    });
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(1_800);
    expect(world.host.opens).toHaveLength(0);
  }, 20_000);
});

describe.each([...STREAM_READS, BOT_POST_WAITING])(
  "$title: the dial after a refused held token",
  (member) => {
    it("ends at the original limit, not a fresh allowance", async () => {
      prepareHostFor(member, world);
      // The mint is unavailable at once. The redial's open is never
      // answered: only the limit can end it.
      world.host.openAt.set(member.faultedOpen + 1, {
        answer: "admit",
        after: deferred().promise,
      });
      world.mint.respond("unavailable");
      const run = timed(member);
      const outcome = await run.run;
      const elapsed = await run.elapsed();
      expectEndedAtItsLimit(member, outcome);
      // Ended near the limit counted from the first dial; a fresh allowance
      // for the second dial would end near twice that.
      expect(elapsed).toBeGreaterThanOrEqual(LIMIT_MS - 150);
      expect(elapsed).toBeLessThan(LIMIT_MS + 900);
      await flush(50);
    }, 20_000);
  },
);

// F1: the legacy hand-off checks the limit on the redial only. The first dial
// keeps its own timers, so a host that took longer than the limit to say it has
// no batch method is still asked for the legacy delete.
describe("worktree delete, legacy flow: the first dial outlasts the limit", () => {
  it("still sends the legacy delete", async () => {
    prepareHostFor(WORKTREE_DELETE_LEGACY, world);
    world.mint.respond("ok");
    const late = deferred();
    world.host.openAt.set(0, { answer: "admit", after: late.promise });
    const run = timed(WORKTREE_DELETE_LEGACY);
    await flush(LIMIT_MS + 500);
    late.settle();
    const outcome = await run.run;
    WORKTREE_DELETE_LEGACY.expectNormalResult(outcome);
    expect(
      world.host.subscribes.filter(
        (sub) => sub.method === "worktree.deleteByPath",
      ),
    ).toHaveLength(1);
    expect(await run.elapsed()).toBeGreaterThanOrEqual(LIMIT_MS + 400);
  }, 20_000);
});
