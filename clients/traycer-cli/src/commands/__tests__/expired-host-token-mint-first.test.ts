import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import {
  ANSWERS_AT_ONCE,
  FRESH_HOST_TOKEN,
  STORED_SIGN_IN,
  deferred,
  heldEndingIn,
  holdPublication,
  openWorld,
  personOf,
  prepareHostFor,
  settle,
  whatThePersonRead,
  whenPublishedInProcess,
  type HeldToken,
  type HomeRef,
  type Member,
  type World,
} from "./expired-host-token-harness";
import { hostTokenFailureCliError } from "../../internal/host-door-words";
import {
  BOT_CHECKINS,
  BOT_LIST,
  BOT_POST_LISTENER,
  WORKTREE_DELETE_BATCH,
  WORKTREE_DELETE_LEGACY,
} from "./expired-host-token-members";

/**
 * A one-shot local stream renews the host-only token it presents BEFORE it
 * dials, when that token is past its end, refused, or within 60 s of it.
 * Everything here drives the commands; nothing names how a stream is opened.
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

const ALL: readonly Member[] = [
  WORKTREE_DELETE_BATCH,
  WORKTREE_DELETE_LEGACY,
  BOT_LIST,
  BOT_CHECKINS,
  BOT_POST_LISTENER,
];

let world: World;

/** Gives each describe its own world; `held` is the token the file holds. */
function useWorld(held: HeldToken | "none" | null): void {
  beforeEach(async () => {
    world = await openWorld(home, held);
  });
  afterEach(async () => {
    await world.close();
  });
}

/** Settles once the mint's first request is out. */
async function whenMintAsked(): Promise<void> {
  await vi.waitFor(
    () => expect(world.mint.requests.length).toBeGreaterThan(0),
    {
      timeout: 5_000,
      interval: 5,
    },
  );
}

const TIMEOUT = 20_000;

// ---- T4: the outcomes of the mint ----------------------------------------- //

describe.each(ALL)("$title: the mint answers ok", (member) => {
  useWorld(null);

  it(
    "is dialed once with the fresh token: no refusal, no second dial",
    async () => {
      prepareHostFor(member, world);
      const run = settle(member.start(world));
      await whenMintAsked();
      expect(world.host.opens).toHaveLength(0);
      world.mint.respond("ok");
      const outcome = await run;
      member.expectNormalResult(outcome);
      expect(world.host.opens.map((open) => open.token)).toEqual(
        world.host.opens.map(() => FRESH_HOST_TOKEN),
      );
      if (member === WORKTREE_DELETE_BATCH)
        expect(world.host.opens).toHaveLength(1);
      expect(world.mint.requests).toHaveLength(1);
      expect(whatThePersonRead(world, outcome)).not.toContain("traycer login");
    },
    TIMEOUT,
  );
});

describe.each(ALL)("$title: the mint is unavailable", (member) => {
  useWorld(null);

  it(
    "dials the held token, then redials once with no token, and awaits no mint for it",
    async () => {
      prepareHostFor(member, world);
      const run = settle(member.start(world));
      await whenMintAsked();
      world.mint.respond("unavailable");
      // Whatever asks for a mint from here on is never answered: the redial
      // must not wait for one.
      world.mint.hold();
      const outcome = await run;
      member.expectNormalResult(outcome);
      expect(world.host.opens.slice(0, 3).map((open) => open.token)).toEqual([
        world.expiredHeld,
        NO_HOST_TOKEN_PROBE,
        STORED_SIGN_IN,
      ]);
      expect(whatThePersonRead(world, outcome)).not.toContain("traycer login");
    },
    TIMEOUT,
  );

  it(
    "answers a retryable refusal of the held token by the client's own retry, and the terminal token_expired by one redial",
    async () => {
      prepareHostFor(member, world);
      world.host.expiredAt.set(
        member.faultedOpen,
        ANSWERS_AT_ONCE("retryable"),
      );
      const run = settle(member.start(world));
      await whenMintAsked();
      world.mint.respond("unavailable");
      world.mint.hold();
      const outcome = await run;
      member.expectNormalResult(outcome);
      const at = member.faultedOpen;
      expect(
        world.host.opens.slice(at, at + 4).map((open) => open.token),
      ).toEqual([
        world.expiredHeld,
        world.expiredHeld,
        NO_HOST_TOKEN_PROBE,
        STORED_SIGN_IN,
      ]);
      expect(whatThePersonRead(world, outcome)).not.toContain("traycer login");
    },
    TIMEOUT,
  );
});

describe.each([WORKTREE_DELETE_BATCH, BOT_CHECKINS])(
  "$title: the mint answers ok and the host's first answer is a retryable refusal",
  (member) => {
    useWorld(null);

    it(
      "is retried by the client on the same fresh token: no redial, no second mint",
      async () => {
        prepareHostFor(member, world);
        world.host.openAt.set(0, ANSWERS_AT_ONCE("retryable"));
        const run = settle(member.start(world));
        await whenMintAsked();
        world.mint.respond("ok");
        const outcome = await run;
        member.expectNormalResult(outcome);
        expect(world.host.opens.map((open) => open.token)).toEqual([
          FRESH_HOST_TOKEN,
          FRESH_HOST_TOKEN,
        ]);
        expect(world.mint.requests).toHaveLength(1);
      },
      TIMEOUT,
    );
  },
);

describe.each([WORKTREE_DELETE_BATCH, BOT_LIST])(
  "$title: the mint is refused for the sign-in",
  (member) => {
    useWorld(null);

    it(
      "presents as at 45829027 once authn has answered: the probe, and the existing gate's ending",
      async () => {
        prepareHostFor(member, world);
        const run = settle(member.start(world));
        await whenMintAsked();
        world.mint.respond("sign-in-rejected");
        const outcome = await run;
        // authn answered before the first dial: the held, expired token is
        // never presented; what is presented is the probe, as the gate has it.
        expect(world.host.opens.map((open) => open.token)).not.toContain(
          world.expiredHeld,
        );
        if (world.host.opens.length > 0)
          expect(world.host.opens[0]?.token).toBe(NO_HOST_TOKEN_PROBE);
        if (member === WORKTREE_DELETE_BATCH) {
          expect(outcome).toMatchObject({ kind: "failed" });
          expect(whatThePersonRead(world, outcome)).toContain("traycer login");
        } else {
          if (outcome.kind !== "completed")
            expect.fail(`the command threw: ${outcome.message}`);
          expect(outcome.result.exitCode).toBe(1);
          expect(whatThePersonRead(world, outcome)).not.toContain(
            "traycer login",
          );
        }
      },
      TIMEOUT,
    );
  },
);

// ---- T7: the replay fence ------------------------------------------------- //

describe.each([WORKTREE_DELETE_BATCH, BOT_CHECKINS])(
  "$title: the host admits the open and closes before the command sees it open",
  (member) => {
    useWorld(null);

    it(
      "is not dialed again, and nothing it asked is sent twice",
      async () => {
        prepareHostFor(member, world);
        world.host.openAt.set(0, ANSWERS_AT_ONCE("admit-then-expired"));
        const run = settle(member.start(world));
        await whenMintAsked();
        world.mint.respond("ok");
        const outcome = await run;
        expect(world.host.opens.map((open) => open.token)).toEqual([
          FRESH_HOST_TOKEN,
        ]);
        expect(world.host.subscribes.length).toBeLessThanOrEqual(1);
        expect(
          outcome.kind === "completed" && outcome.result.exitCode === 0,
        ).toBe(false);
        expect(whatThePersonRead(world, outcome)).not.toContain(
          "traycer login",
        );
        expect(world.mint.requests).toHaveLength(1);
      },
      TIMEOUT,
    );
  },
);

// ---- T8: worktree delete cut after an admitted open ----------------------- //

const DELETE_CASES = [
  {
    title: WORKTREE_DELETE_BATCH.title,
    member: WORKTREE_DELETE_BATCH,
    method: "worktree.deleteBatchByPath",
    dials: 1,
  },
  {
    title: WORKTREE_DELETE_LEGACY.title,
    member: WORKTREE_DELETE_LEGACY,
    method: "worktree.deleteByPath",
    dials: 2,
  },
];

describe.each(DELETE_CASES)(
  "$title: token_expired after an admitted open",
  ({ member, method, dials }) => {
    useWorld(null);

    it(
      "ends with the dropped-connection line, never sign-in advice, and sends the delete once",
      async () => {
        prepareHostFor(member, world);
        world.host.refuseAfter = (asked) =>
          asked === method ? "token-expired" : null;
        const run = settle(member.start(world));
        await whenMintAsked();
        world.mint.respond("ok");
        const outcome = await run;
        expect(outcome).toMatchObject({ kind: "failed" });
        const read = whatThePersonRead(world, outcome);
        expect(read).toContain("may or may not have been removed");
        expect(read).toContain("traycer worktree list");
        expect(read).not.toContain("traycer login");
        expect(
          world.host.subscribes.filter((sub) => sub.method === method),
        ).toHaveLength(1);
        expect(world.host.opens).toHaveLength(dials);
        expect(world.mint.requests).toHaveLength(1);
      },
      TIMEOUT,
    );
  },
);

// ---- T4, the rest of C/D/E: the host's own answers ------------------------- //

describe.each([WORKTREE_DELETE_BATCH, BOT_LIST, BOT_CHECKINS])(
  "$title: an outage of the mint (D)",
  (member) => {
    useWorld(null);

    it(
      "completes on the held token, sent once the mint failed and while authn is unreachable",
      async () => {
        prepareHostFor(member, world);
        // authn is unreachable, so the host admits the held token as it is.
        world.host.expired = ANSWERS_AT_ONCE("admit");
        const run = settle(member.start(world));
        await whenMintAsked();
        expect(world.host.opens).toHaveLength(0);
        world.mint.respond("unavailable");
        member.expectNormalResult(await run);
        expect(world.host.opens[0]).toMatchObject({ token: world.expiredHeld });
        // Exactly one grant request: the mint awaited before the work stands in
        // for the one the open's first bearer read would have started.
        expect(world.mint.requests).toHaveLength(1);
      },
      TIMEOUT,
    );
  },
);

describe("worktree delete, batch flow: a released host (E)", () => {
  useWorld(null);

  it(
    "refuses the held token bare, and the redial with the stored sign-in completes",
    async () => {
      prepareHostFor(WORKTREE_DELETE_BATCH, world);
      world.host.expired = ANSWERS_AT_ONCE("released");
      const run = settle(WORKTREE_DELETE_BATCH.start(world));
      await whenMintAsked();
      world.mint.respond("unavailable");
      WORKTREE_DELETE_BATCH.expectNormalResult(await run);
      expect(world.host.opens.map((open) => open.token)).toEqual([
        world.expiredHeld,
        STORED_SIGN_IN,
      ]);
    },
    TIMEOUT,
  );
});

// A token the host refused as expired is not presented again, whatever this
// process thinks of it: the redial presents none, probes, and signs in as the
// host names. A token that landed since changes nothing about that.
describe.each([WORKTREE_DELETE_BATCH, BOT_CHECKINS])(
  "$title: a typed token_expired before admission",
  (member) => {
    useWorld(null);

    it(
      "gives exactly one redial that presents no token, even with a fresh token in the store",
      async () => {
        prepareHostFor(member, world);
        // The mint is answered, so a fresh token is held; the host refuses the
        // held one the first dial presents all the same.
        world.host.expired = ANSWERS_AT_ONCE("admit");
        world.host.openAt.set(0, ANSWERS_AT_ONCE("token-expired"));
        const run = settle(member.start(world));
        await whenMintAsked();
        world.mint.respond("ok");
        const outcome = await run;
        member.expectNormalResult(outcome);
        expect(world.host.opens.slice(0, 3).map((open) => open.token)).toEqual([
          FRESH_HOST_TOKEN,
          NO_HOST_TOKEN_PROBE,
          STORED_SIGN_IN,
        ]);
        expect(whatThePersonRead(world, outcome)).not.toContain(
          "traycer login",
        );
      },
      TIMEOUT,
    );
  },
);

// ---- the gate before any dial --------------------------------------------- //

const GATED: readonly { readonly member: Member; readonly ends: RegExp }[] = [
  { member: WORKTREE_DELETE_BATCH, ends: /./ },
  { member: BOT_CHECKINS, ends: /./ },
];

describe.each(GATED)(
  "$member.title: a mint the gate ends the command on",
  ({ member }) => {
    useWorld(null);

    it.each([
      ["not-a-member", "E_TEAM_MEMBERSHIP_REQUIRED", "team"],
      ["sandbox-frozen", "E_HOST_UNREACHABLE", ""],
    ] as const)(
      "%s ends the command with its own ending, before any dial",
      async (answer, code, mentions) => {
        prepareHostFor(member, world);
        const run = settle(member.start(world));
        await whenMintAsked();
        world.mint.respond(answer);
        const outcome = await run;
        expect(outcome).toMatchObject({ kind: "failed", code });
        if (outcome.kind !== "failed") return;
        expect(outcome.message.toLowerCase()).toContain(mentions);
        expect(world.host.opens).toHaveLength(0);
        expect(world.mint.requests).toHaveLength(1);
      },
      TIMEOUT,
    );

    it(
      "a sign-in refused after its one refresh ends as that state ends, before any dial",
      async () => {
        prepareHostFor(member, world);
        const run = settle(member.start(world));
        await whenMintAsked();
        world.mint.respond("sign-in-rejected");
        const outcome = await run;
        expect(outcome).toMatchObject({ kind: "failed" });
        expect(whatThePersonRead(world, outcome)).toContain("traycer login");
        expect(world.host.opens).toHaveLength(0);
        expect(world.mint.refreshes).toBe(1);
      },
      TIMEOUT,
    );
  },
);

// ---- no token held: the first mint comes from the command's own wait ------- //

describe.each([WORKTREE_DELETE_BATCH, BOT_CHECKINS])(
  "$title: no host-only token held",
  (member) => {
    useWorld("none");

    it(
      "waits for one mint before the dial, and dials the token it bought",
      async () => {
        prepareHostFor(member, world);
        const run = settle(member.start(world));
        await whenMintAsked();
        expect(world.host.opens).toHaveLength(0);
        world.mint.respond("ok");
        member.expectNormalResult(await run);
        expect(world.host.opens.map((open) => open.token)).toEqual(
          world.host.opens.map(() => FRESH_HOST_TOKEN),
        );
        expect(world.mint.requests).toHaveLength(1);
      },
      TIMEOUT,
    );

    it(
      "waits for a black-holed mint to fail, then probes and signs in",
      async () => {
        prepareHostFor(member, world);
        const run = settle(member.start(world));
        await whenMintAsked();
        world.mint.respondAfter(1_500, "unavailable");
        member.expectNormalResult(await run);
        expect(world.host.opens.slice(0, 2).map((open) => open.token)).toEqual([
          NO_HOST_TOKEN_PROBE,
          STORED_SIGN_IN,
        ]);
        expect(world.mint.requests).toHaveLength(1);
      },
      TIMEOUT,
    );
  },
);

// ---- the stored sign-in never leaves the process on a definitive no ---------- //

describe("worktree delete, batch flow: authn answers that this computer is not admitted", () => {
  useWorld(null);

  it(
    "never presents the stored sign-in on any open, even to a host that invites it; the existing ending",
    async () => {
      prepareHostFor(WORKTREE_DELETE_BATCH, world);
      // The host would take the stored sign-in on its owner-sign-in answer.
      world.host.probe = "owner-sign-in";
      const run = settle(WORKTREE_DELETE_BATCH.start(world));
      await whenMintAsked();
      world.mint.respond("not-admitted");
      const outcome = await run;
      // The wire: no open of any dial carries the stored sign-in.
      expect(world.host.opens.map((open) => open.token)).not.toContain(
        STORED_SIGN_IN,
      );
      // The ending the command has at 45829027 for a probe the host answers
      // with its owner-sign-in invitation while the stored sign-in stays home.
      const ending = hostTokenFailureCliError({ kind: "not-admitted" });
      expect(outcome).toMatchObject({
        kind: "failed",
        code: ending.code,
        message: ending.message,
      });
      expect(whatThePersonRead(world, outcome)).not.toContain("traycer login");
    },
    TIMEOUT,
  );
});

// ---- a token that is valid when presented goes as today ---------------------- //

describe.each(ALL)(
  "$title: a held token that has not reached its end",
  (member) => {
    // A host-only token lives as long as the sign-in it was minted with, up to
    // four hours: this one has three hours left.
    useWorld(heldEndingIn(3 * 60 * 60 * 1000));

    it(
      "is dialed at once, with no mint",
      async () => {
        prepareHostFor(member, world);
        world.host.expired = ANSWERS_AT_ONCE("admit");
        member.expectNormalResult(await settle(member.start(world)));
        expect(world.mint.requests).toHaveLength(0);
        expect(world.host.opens.map((open) => open.token)).toEqual(
          world.host.opens.map(() => world.expiredHeld),
        );
      },
      TIMEOUT,
    );
  },
);

// ---- a fresh grant published while the redial's probe is out ---------------- //

describe.each([WORKTREE_DELETE_BATCH, BOT_CHECKINS])(
  "$title: a fresh grant published in the process after the probe was sent",
  (member) => {
    useWorld(null);

    it(
      "completes on that grant with one further open, and the refused token is not presented again",
      async () => {
        prepareHostFor(member, world);
        const invitation = deferred();
        // The host answers the redial's probe (open 1) only when the test lets it.
        world.host.openAt.set(1, {
          answer: "owner-sign-in",
          after: invitation.promise,
        });
        const run = settle(member.start(world));
        await whenMintAsked();
        const person = await personOf(world);
        try {
          world.mint.respond("unavailable");
          // Whatever asks for a mint from here on waits for the test's answer.
          world.mint.hold();
          await world.host.whenOpened(1);
          world.mint.respond("ok");
          // What the choice reads: the grant is published in this process.
          await whenPublishedInProcess(person, world);
          invitation.settle();
          const outcome = await run;
          member.expectNormalResult(outcome);
          expect(world.host.opens.map((open) => open.token)).toEqual([
            world.expiredHeld,
            NO_HOST_TOKEN_PROBE,
            FRESH_HOST_TOKEN,
          ]);
          expect(whatThePersonRead(world, outcome)).not.toContain(
            "traycer login",
          );
        } finally {
          person.dispose();
        }
      },
      TIMEOUT,
    );

    it(
      "goes on the person's sign-in when the host's invitation comes while the grant is on disk but not yet published in the process: the request runs once, nothing else is sent",
      async () => {
        prepareHostFor(member, world);
        const lag = holdPublication();
        const invitation = deferred();
        world.host.openAt.set(1, {
          answer: "owner-sign-in",
          after: invitation.promise,
        });
        const run = settle(member.start(world));
        await whenMintAsked();
        const person = await personOf(world);
        try {
          world.mint.respond("unavailable");
          world.mint.hold();
          await world.host.whenOpened(1);
          world.mint.respond("ok");
          await lag.written;
          // On disk, and not yet published: the state the choice reads still
          // says no grant is held.
          expect(await world.heldToken()).toBe(FRESH_HOST_TOKEN);
          expect(person.tokens.ownerSignInEligible(world.hostId)).toBe(true);
          invitation.settle();
          await world.host.whenOpened(2);
          lag.release();
          const outcome = await run;
          member.expectNormalResult(outcome);
          expect(world.host.opens.map((open) => open.token)).toEqual([
            world.expiredHeld,
            NO_HOST_TOKEN_PROBE,
            STORED_SIGN_IN,
          ]);
          expect(world.host.subscribes.map((seen) => seen.index)).toEqual([2]);
          expect(world.host.updates).toEqual([]);
        } finally {
          lag.release();
          person.dispose();
        }
      },
      TIMEOUT,
    );
  },
);
