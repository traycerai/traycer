import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORED_SIGN_IN,
  openWorld,
  prepareHostFor,
  settle,
  whatThePersonRead,
  type HomeRef,
  type World,
} from "./expired-host-token-harness";
import { BOT_LIST } from "./expired-host-token-members";
import { createCliCredentialsStore } from "../../store/credentials-store";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import { readSignInEnvironments } from "../../internal/sign-in-environments";
import { createAuthenticatedUserFixture } from "../../../../shared/test-fixtures/authenticated-user";

/**
 * `bot list` reads this computer's ownership at authn with the stored sign-in.
 * A sign-in authn refuses is refreshed once; sign-in advice comes only from
 * authn refusing the stored sign-in after that refresh. A refusal of the
 * directory read alone (a 403 reads the same as a 401) is not the sign-in's.
 */

const home = vi.hoisted((): HomeRef => ({ path: null }));
const authn = vi.hoisted(() => ({
  /** Whether authn takes the sign-in the command was started with. */
  storedTaken: true,
  /** Whether authn takes the sign-in a refresh produced. */
  rotatedTaken: true,
  /** What the host directory answers to a read made with a given sign-in. */
  directory: (_signIn: string): "unauthorized" | "not-found" => "not-found",
  refreshes: 0,
  /** Runs while authn is asked about the sign-in the command started with: another program saves a sign-in. */
  duringIdentityAsk: null as (() => Promise<void>) | null,
  /** Runs once, right after authn takes the stored sign-in: another program saves a sign-in. */
  afterStoredTaken: null as (() => Promise<void>) | null,
  /** One runs after each refusal of the refreshed sign-in, in order: another program saves a sign-in. */
  afterRotatedRefused: [] as (() => Promise<void>)[],
  /** Every sign-in authn was asked about, and every one the host directory was read with, in order. */
  identityReads: [] as string[],
  directoryReads: [] as string[],
}));

const ROTATED = "rotated-sign-in";
/** A working sign-in of a different account, saved by another program. */
const SIBLING_SIGN_IN = "sibling-sign-in";

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
vi.mock(
  "../../../../shared/host-transport/whatwg-stream-ws-factory",
  async () =>
    (await import("./expired-host-token-seams")).streamFactoryModule(),
);
vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return {
    ...actual,
    refreshOnceAbortable: async () => {
      authn.refreshes += 1;
      return {
        kind: "refreshed" as const,
        token: ROTATED,
        refreshToken: `rt-${ROTATED}`,
      };
    },
    validateAuthTokenIdentityAccessOnly: async (
      _authnBaseUrl: string,
      token: string,
    ) => {
      authn.identityReads.push(token);
      if (token === SIBLING_SIGN_IN)
        return {
          kind: "valid" as const,
          user: createAuthenticatedUserFixture({
            user: {
              ...createAuthenticatedUserFixture(undefined).user,
              id: "sibling-user",
            },
          }),
        };
      const taken = token === ROTATED ? authn.rotatedTaken : authn.storedTaken;
      if (!taken && authn.duringIdentityAsk !== null) {
        const save = authn.duringIdentityAsk;
        authn.duringIdentityAsk = null;
        await save();
      }
      if (taken && token !== ROTATED && authn.afterStoredTaken !== null) {
        const save = authn.afterStoredTaken;
        authn.afterStoredTaken = null;
        await save();
      }
      if (!taken && token === ROTATED) {
        const save = authn.afterRotatedRefused.shift();
        if (save !== undefined) await save();
      }
      return taken
        ? {
            kind: "valid" as const,
            user: createAuthenticatedUserFixture(undefined),
          }
        : { kind: "rejected" as const };
    },
  };
});
vi.mock(
  "@traycer-clients/shared/host-client/host-ownership",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-ownership")
      >();
    return {
      ...actual,
      readHostOwnershipViaHttp: async (
        _authnBaseUrl: string,
        signIn: string,
      ) => {
        authn.directoryReads.push(signIn);
        return { kind: authn.directory(signIn) };
      },
    };
  },
);

let world: World;

beforeEach(async () => {
  authn.storedTaken = true;
  authn.rotatedTaken = true;
  authn.directory = () => "not-found";
  authn.refreshes = 0;
  authn.duringIdentityAsk = null;
  authn.afterStoredTaken = null;
  authn.afterRotatedRefused = [];
  authn.identityReads = [];
  authn.directoryReads = [];
  world = await openWorld(home, null);
  prepareHostFor(BOT_LIST, world);
  world.mint.respond("ok");
});

afterEach(async () => {
  await world.close();
});

describe("bot list: the sign-in as the host directory reads it", () => {
  it("(a) the stored access token is past its end and the refresh succeeds: the list prints, with no login line", async () => {
    authn.storedTaken = false;
    authn.directory = (signIn) =>
      signIn === STORED_SIGN_IN ? "unauthorized" : "not-found";
    const outcome = await settle(BOT_LIST.start(world));
    BOT_LIST.expectNormalResult(outcome);
    expect(authn.refreshes).toBe(1);
    // The host directory is read with the refreshed sign-in, and no other.
    expect(authn.directoryReads).toEqual([ROTATED]);
    expect(whatThePersonRead(world, outcome)).not.toContain("traycer login");
  }, 20_000);

  it("(b) the directory answers 403: the ownership could not be confirmed, not the login line", async () => {
    authn.directory = () => "unauthorized";
    const outcome = await settle(BOT_LIST.start(world));
    expect(outcome).toMatchObject({ kind: "failed" });
    const read = whatThePersonRead(world, outcome);
    expect(read).toContain("ownership could not be confirmed");
    expect(read).toContain("Try again");
    expect(read).not.toContain("traycer login");
  }, 20_000);

  it("(c) authn refuses the stored sign-in after the refresh: the existing login line (control)", async () => {
    authn.storedTaken = false;
    authn.rotatedTaken = false;
    authn.directory = () => "unauthorized";
    const outcome = await settle(BOT_LIST.start(world));
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(whatThePersonRead(world, outcome)).toContain("traycer login");
    expect(authn.refreshes).toBe(1);
  }, 20_000);

  let saves = 0;
  /** Another program saves `token` as the sign-in of `userId`. */
  async function saveSignIn(token: string, userId: string): Promise<void> {
    saves += 1;
    const store = createCliCredentialsStore();
    try {
      await store.signIn(
        {
          token,
          refreshToken: `rt-${token}`,
          savedAt: `2026-01-01T00:00:${String(10 + saves).padStart(2, "0")}.000Z`,
          user: { id: userId, email: "b@example.test", name: "B" },
        },
        false,
        null,
      );
    } finally {
      store.dispose();
    }
  }

  /** Another person's working sign-in B, saved by another program. */
  const saveSiblingSignIn = (): Promise<void> =>
    saveSignIn(SIBLING_SIGN_IN, "sibling-user");
  /** The person's own first sign-in A, saved again by another program. */
  const restoreStoredSignIn = (): Promise<void> =>
    saveSignIn(STORED_SIGN_IN, world.userId);

  /** What went on the wire to authn: identity asks, directory reads and mints. */
  const sentToAuthn = (): string[] => [
    ...authn.identityReads,
    ...authn.directoryReads,
    ...world.mint.requests.map((request) => request.authorization),
  ];
  const sentSibling = (): boolean =>
    sentToAuthn().some((sent) => sent.includes(SIBLING_SIGN_IN));
  /** Identity asks and directory reads only: what `sendAs` fences. */
  const readsWithSibling = (): boolean =>
    [...authn.identityReads, ...authn.directoryReads].includes(SIBLING_SIGN_IN);
  /** Host-only token mints that carried B's sign-in. */
  const mintsWithSibling = (): string[] =>
    world.mint.requests
      .map((request) => request.authorization)
      .filter((sent) => sent.includes(SIBLING_SIGN_IN));

  const NOT_CONFIRMED = "ownership could not be confirmed";

  it("(d) the stored sign-in A is refused and refresh cannot save it, and another person's B is saved during the identity ask: B is never sent, no login line, the caller's own line", async () => {
    authn.storedTaken = false;
    authn.rotatedTaken = false;
    authn.duringIdentityAsk = saveSiblingSignIn;
    authn.directory = () => "not-found";
    const outcome = await settle(BOT_LIST.start(world));
    expect(authn.duringIdentityAsk).toBeNull();
    expect(outcome).toMatchObject({ kind: "failed" });
    const read = whatThePersonRead(world, outcome);
    expect(read).toContain(NOT_CONFIRMED);
    expect(read).toContain("Try again");
    expect(read).not.toContain("traycer login");
    expect(outcome).toMatchObject({ code: CLI_ERROR_CODES.CLOUD_UNREACHABLE });
    expect(sentSibling()).toBe(false);
  }, 20_000);

  it("(e) readSignInEnvironments: the same save ends with the caller's own line, and B is never sent", async () => {
    authn.storedTaken = false;
    authn.rotatedTaken = false;
    authn.duringIdentityAsk = saveSiblingSignIn;
    const ended = await readSignInEnvironments(() =>
      cliError({
        code: CLI_ERROR_CODES.FORBIDDEN,
        message: "not confirmed",
        details: null,
        exitCode: 1,
      }),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(authn.duringIdentityAsk).toBeNull();
    expect(ended).toMatchObject({
      code: CLI_ERROR_CODES.FORBIDDEN,
      message: "not confirmed",
    });
    expect(sentSibling()).toBe(false);
  }, 20_000);

  it("(f) authn takes A, then another person's B is saved before the directory read: B is never on the wire, the list ends with the ownership line", async () => {
    authn.afterStoredTaken = saveSiblingSignIn;
    authn.directory = () => "not-found";
    const outcome = await settle(BOT_LIST.start(world));
    expect(authn.afterStoredTaken).toBeNull();
    expect(outcome).toMatchObject({ kind: "failed" });
    const read = whatThePersonRead(world, outcome);
    expect(read).toContain(NOT_CONFIRMED);
    expect(read).toContain("Try again");
    expect(read).not.toContain("traycer login");
    expect(outcome).toMatchObject({ code: CLI_ERROR_CODES.CLOUD_UNREACHABLE });
    expect(readsWithSibling()).toBe(false);
  }, 20_000);

  it("(f2) the same save: no host-only token mint is sent with B's sign-in either", async () => {
    authn.afterStoredTaken = saveSiblingSignIn;
    authn.directory = () => "not-found";
    await settle(BOT_LIST.start(world));
    expect(authn.afterStoredTaken).toBeNull();
    expect(mintsWithSibling()).toEqual([]);
    // No dial presents B's sign-in either.
    expect(world.host.opens.map((open) => String(open.token))).not.toContain(
      SIBLING_SIGN_IN,
    );
  }, 20_000);

  it("(g) A is refused, its refresh B too, and the person's own sign-in is saved again after each refusal: judged once more at most, then the ownership line, not the login line", async () => {
    authn.storedTaken = false;
    authn.rotatedTaken = false;
    authn.directory = () => "unauthorized";
    authn.afterRotatedRefused = [restoreStoredSignIn, restoreStoredSignIn];
    const outcome = await settle(BOT_LIST.start(world));
    expect(authn.afterRotatedRefused).toHaveLength(0);
    expect(outcome).toMatchObject({ kind: "failed" });
    const read = whatThePersonRead(world, outcome);
    expect(read).toContain(NOT_CONFIRMED);
    expect(read).not.toContain("traycer login");
    // The first sign-in, its refresh, then the saved sign-in and its refresh: no third judgment.
    expect(
      authn.identityReads.filter((sent) => sent === STORED_SIGN_IN),
    ).toHaveLength(2);
    expect(authn.refreshes).toBeLessThanOrEqual(2);
  }, 20_000);
});
