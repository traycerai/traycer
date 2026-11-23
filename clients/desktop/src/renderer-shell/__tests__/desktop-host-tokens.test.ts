import { describe, expect, it, vi } from "vitest";
import {
  authnDidNotAnswer,
  hostTokenBearer,
  hostTokenBearerFor,
  trackHostTokenMints,
} from "@traycer-clients/shared/auth/host-token-lease";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
  type HostTokenRenewal,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import { createReleasedHostMemory } from "@traycer-clients/shared/host-transport/released-sign-on";
import type {
  HostTokenBridgeChange,
  HostTokenSnapshotReply,
  HostTokensBridgeSurface,
} from "../../ipc-contracts/host-token-types";
import { NO_ISSUED_HOST_TOKEN_ERA } from "../../ipc-contracts/host-token-types";
import type { HostToken } from "@traycer-clients/shared/auth/host-token-store";
import { createDesktopHostTokenSource } from "../desktop-host-tokens";

/** A sign-in key as main reports it: the lowercase hex SHA-256 of a sign-in. */
const FIXED_SIGN_IN_KEY = "a".repeat(64);

const USER_ID = "user-a";
const HOST_ID = "computer-a";
const HOST_TOKEN = { token: "host-token", expiresAtMs: 10_000 };
const invalidEras: readonly unknown[] = [-1, 0.5, Number.NaN, "0", null];

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const EMPTY_SNAPSHOT: HostTokenSnapshotReply = {
  userId: null,
  era: NO_ISSUED_HOST_TOKEN_ERA,
  tokens: [],
};

function bridgeFixture(): {
  readonly bridge: HostTokensBridgeSurface;
  readonly emit: (change: HostTokenBridgeChange) => void;
  readonly setEra: (era: number) => void;
  readonly answerSnapshotWith: (reply: Promise<HostTokenSnapshotReply>) => void;
} {
  let mainEra = 0;
  let snapshotAnswer: Promise<HostTokenSnapshotReply> =
    Promise.resolve(EMPTY_SNAPSHOT);
  let listener: ((change: HostTokenBridgeChange) => void) | null = null;
  const bridge: HostTokensBridgeSurface = {
    era: () => mainEra,
    signIn: () => FIXED_SIGN_IN_KEY,
    obtain: async () => ({
      outcome: { kind: "ok", token: HOST_TOKEN },
      era: mainEra,
      held: true,
      recorded: true,
      signIn: FIXED_SIGN_IN_KEY,
    }),
    renew: async () => ({ renewal: { kind: "already-current" }, era: mainEra }),
    adopt: async () => ({ era: mainEra, kept: true }),
    forgetUser: async () => {
      mainEra += 1;
      return { era: mainEra };
    },
    snapshot: () => snapshotAnswer,
    subscribe: (next) => {
      listener = next;
      return {
        dispose: () => {
          listener = null;
        },
      };
    },
  };
  return {
    bridge,
    emit: (change) => listener?.(change),
    setEra: (era) => {
      mainEra = era;
    },
    answerSnapshotWith: (reply) => {
      snapshotAnswer = reply;
    },
  };
}

describe("desktop host-token source eras", () => {
  it("drops an ok bridge answer that arrives after forgetUser", async () => {
    const answer = deferred<{
      outcome: HostTokenMintOutcome;
      era: number;
      held: boolean;
      recorded: boolean;
      signIn: string | null;
    }>();
    let obtainCalls = 0;
    let mainEra = 0;
    const bridge: HostTokensBridgeSurface = {
      era: () => mainEra,
      signIn: () => FIXED_SIGN_IN_KEY,
      obtain: () => {
        obtainCalls += 1;
        return answer.promise;
      },
      renew: async () => ({
        renewal: { kind: "already-current" },
        era: mainEra,
      }),
      adopt: async () => ({ era: mainEra, kept: true }),
      forgetUser: async () => {
        mainEra += 1;
        return { era: mainEra };
      },
      snapshot: async () => EMPTY_SNAPSHOT,
      subscribe: (_handler) => ({ dispose: () => undefined }),
    };
    const tokens = createDesktopHostTokenSource(bridge);

    const pending = tokens.obtain(USER_ID, HOST_ID, false, {
      signal: null,
      owner: null,
    });
    await tokens.forgetUser(USER_ID);
    answer.resolve({
      outcome: {
        kind: "ok",
        token: { token: "late-host-token", expiresAtMs: 10_000 },
      },
      era: 0,
      held: true,
      recorded: true,
      signIn: FIXED_SIGN_IN_KEY,
    });

    await expect(pending).resolves.toEqual({ kind: "superseded" });
    expect(obtainCalls).toBe(1);
    expect(tokens.era(USER_ID)).toBe(1);
    expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
  });

  it("supersedes a bridge renewal that answers after forgetUser", async () => {
    const answer = deferred<{ renewal: HostTokenRenewal; era: number }>();
    let mainEra = 0;
    const bridge: HostTokensBridgeSurface = {
      era: () => mainEra,
      signIn: () => FIXED_SIGN_IN_KEY,
      obtain: async () => ({
        outcome: { kind: "no-sign-in" },
        era: mainEra,
        held: false,
        recorded: false,
        signIn: FIXED_SIGN_IN_KEY,
      }),
      renew: () => answer.promise,
      adopt: async () => ({ era: mainEra, kept: true }),
      forgetUser: async () => {
        mainEra += 1;
        return { era: mainEra };
      },
      snapshot: async () => EMPTY_SNAPSHOT,
      subscribe: (_handler) => ({ dispose: () => undefined }),
    };
    const tokens = createDesktopHostTokenSource(bridge);

    const pending = tokens.renew(USER_ID, [HOST_ID]);
    await tokens.forgetUser(USER_ID);
    answer.resolve({ renewal: { kind: "renewed", delayed: [] }, era: 0 });

    await expect(pending).resolves.toEqual({ kind: "superseded" });
    expect(tokens.era(USER_ID)).toBe(1);
  });

  it("supersedes an unavailable obtain answer after a newer-era event", async () => {
    const answer = deferred<{
      outcome: HostTokenMintOutcome;
      era: number;
      held: boolean;
      recorded: boolean;
      signIn: string | null;
    }>();
    const { bridge, emit, setEra } = bridgeFixture();
    setEra(1);
    Reflect.set(bridge, "obtain", () => answer.promise);
    const tokens = createDesktopHostTokenSource(bridge);

    const pending = tokens.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: null,
    });
    setEra(2);
    emit({
      userId: USER_ID,
      hostId: HOST_ID,
      token: null,
      era: 2,
      replaced: null,
    });
    answer.resolve({
      outcome: { kind: "unavailable", detail: "authn answered HTTP 503" },
      era: 1,
      held: false,
      recorded: false,
      signIn: FIXED_SIGN_IN_KEY,
    });

    await expect(pending).resolves.toEqual({ kind: "superseded" });
  });

  it("does not keep an ok obtain answer from a prior era", async () => {
    const answer = deferred<{
      outcome: HostTokenMintOutcome;
      era: number;
      held: boolean;
      recorded: boolean;
      signIn: string | null;
    }>();
    const { bridge, emit, setEra } = bridgeFixture();
    setEra(1);
    Reflect.set(bridge, "obtain", () => answer.promise);
    const tokens = createDesktopHostTokenSource(bridge);

    const pending = tokens.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: null,
    });
    setEra(2);
    emit({
      userId: USER_ID,
      hostId: HOST_ID,
      token: null,
      era: 2,
      replaced: null,
    });
    answer.resolve({
      outcome: {
        kind: "ok",
        token: { token: "late-era-one-token", expiresAtMs: 10_000 },
      },
      era: 1,
      held: true,
      recorded: true,
      signIn: FIXED_SIGN_IN_KEY,
    });

    await expect(pending).resolves.toEqual({ kind: "superseded" });
    expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
  });

  it("supersedes a renewal answer from a prior era", async () => {
    const answer = deferred<{ renewal: HostTokenRenewal; era: number }>();
    const { bridge, emit, setEra } = bridgeFixture();
    setEra(1);
    Reflect.set(bridge, "renew", () => answer.promise);
    const tokens = createDesktopHostTokenSource(bridge);

    const pending = tokens.renew(USER_ID, [HOST_ID]);
    setEra(2);
    emit({
      userId: USER_ID,
      hostId: HOST_ID,
      token: null,
      era: 2,
      replaced: null,
    });
    answer.resolve({ renewal: { kind: "renewed", delayed: [] }, era: 1 });

    await expect(pending).resolves.toEqual({ kind: "superseded" });
  });

  it("records no failure for a mint ask that main's IPC call rejected", async () => {
    const { bridge, setEra } = bridgeFixture();
    setEra(1);
    Reflect.set(bridge, "obtain", () =>
      Promise.reject(new Error("main did not answer")),
    );
    const tokens = createDesktopHostTokenSource(bridge);
    const owner = createReleasedHostMemory().currentInstance(HOST_ID);

    await tokens
      .obtain(USER_ID, HOST_ID, false, {
        signal: null,
        owner,
        observedNow: () => owner.observed,
      })
      .catch(() => undefined);

    expect(tokens.lastFailureOf(USER_ID, owner)).toBeNull();
  });

  it("empties the copy immediately and ignores a pre-forget event", async () => {
    const { bridge, emit } = bridgeFixture();
    const tokens = createDesktopHostTokenSource(bridge);

    await expect(
      tokens.obtain(USER_ID, HOST_ID, false, { signal: null, owner: null }),
    ).resolves.toEqual({
      kind: "ok",
      token: HOST_TOKEN,
    });
    expect(tokens.current(USER_ID, HOST_ID)).toEqual(HOST_TOKEN);

    const forgetting = tokens.forgetUser(USER_ID);
    expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
    emit({
      userId: USER_ID,
      hostId: HOST_ID,
      token: HOST_TOKEN,
      era: 0,
      replaced: null,
    });
    expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
    await forgetting;
  });

  it("announces each copied host when forgetting begins before main answers", async () => {
    const forgetAnswer = deferred<{ era: number }>();
    const { bridge, setEra } = bridgeFixture();
    Reflect.set(bridge, "forgetUser", () => forgetAnswer.promise);
    const tokens = createDesktopHostTokenSource(bridge);
    const otherHostId = "computer-b";
    await tokens.obtain(USER_ID, HOST_ID, false, { signal: null, owner: null });
    await tokens.obtain(USER_ID, otherHostId, false, {
      signal: null,
      owner: null,
    });
    const changes: Array<{ readonly userId: string; readonly hostId: string }> =
      [];
    const unsubscribe = tokens.subscribe(({ userId, hostId }) =>
      changes.push({ userId, hostId }),
    );

    const forgetting = tokens.forgetUser(USER_ID);
    expect(changes).toEqual([
      { userId: USER_ID, hostId: HOST_ID },
      { userId: USER_ID, hostId: otherHostId },
    ]);

    setEra(1);
    forgetAnswer.resolve({ era: 1 });
    await forgetting;
    unsubscribe();
  });

  it("announces every copied host it drops when another host reports a newer era, and nothing for a host it never held", async () => {
    const { bridge, emit, setEra } = bridgeFixture();
    const tokens = createDesktopHostTokenSource(bridge);
    const otherHostId = "computer-b";
    const eventHostId = "computer-c";
    await tokens.obtain(USER_ID, HOST_ID, false, { signal: null, owner: null });
    await tokens.obtain(USER_ID, otherHostId, false, {
      signal: null,
      owner: null,
    });
    const changes: Array<{ readonly userId: string; readonly hostId: string }> =
      [];
    const unsubscribe = tokens.subscribe(({ userId, hostId }) =>
      changes.push({ userId, hostId }),
    );

    setEra(1);
    emit({
      userId: USER_ID,
      hostId: eventHostId,
      token: null,
      era: 1,
      replaced: null,
    });

    expect(changes).toEqual([
      { userId: USER_ID, hostId: HOST_ID },
      { userId: USER_ID, hostId: otherHostId },
    ]);
    unsubscribe();
  });

  it("empties all copied hosts on a newer-era event", async () => {
    const { bridge, emit, setEra } = bridgeFixture();
    const tokens = createDesktopHostTokenSource(bridge);
    const otherHostId = "computer-b";
    await tokens.obtain(USER_ID, HOST_ID, false, { signal: null, owner: null });
    await tokens.obtain(USER_ID, otherHostId, false, {
      signal: null,
      owner: null,
    });
    expect(tokens.current(USER_ID, HOST_ID)).toEqual(HOST_TOKEN);
    expect(tokens.current(USER_ID, otherHostId)).toEqual(HOST_TOKEN);

    setEra(1);
    emit({
      userId: USER_ID,
      hostId: HOST_ID,
      token: null,
      era: 1,
      replaced: null,
    });

    expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
    expect(tokens.current(USER_ID, otherHostId)).toBeNull();
    expect(tokens.era(USER_ID)).toBe(1);
  });

  it.each(invalidEras)(
    "fails closed for a malformed main era (%s)",
    async (era) => {
      const { bridge } = bridgeFixture();
      Reflect.set(bridge, "era", () => era);
      let obtainCalls = 0;
      Reflect.set(bridge, "obtain", async () => {
        obtainCalls += 1;
        return {
          outcome: { kind: "ok", token: HOST_TOKEN },
          era: 0,
          held: true,
          recorded: true,
          signIn: FIXED_SIGN_IN_KEY,
        };
      });
      const tokens = createDesktopHostTokenSource(bridge);

      expect(tokens.era(USER_ID)).toBe(NO_ISSUED_HOST_TOKEN_ERA);
      await expect(
        tokens.obtain(USER_ID, HOST_ID, false, { signal: null, owner: null }),
      ).resolves.toEqual({
        kind: "superseded",
      });
      expect(obtainCalls).toBe(0);
      expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
    },
  );

  it.each(invalidEras)(
    "rejects a malformed obtain reply era (%s)",
    async (era) => {
      const { bridge } = bridgeFixture();
      Reflect.set(bridge, "obtain", async () => ({
        outcome: { kind: "ok", token: HOST_TOKEN },
        era,
        held: true,
        recorded: true,
        signIn: FIXED_SIGN_IN_KEY,
      }));
      const tokens = createDesktopHostTokenSource(bridge);

      await expect(
        tokens.obtain(USER_ID, HOST_ID, false, { signal: null, owner: null }),
      ).resolves.toEqual({
        kind: "superseded",
      });
      expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
    },
  );

  it.each(invalidEras)(
    "rejects a malformed renewal reply era (%s)",
    async (era) => {
      const { bridge } = bridgeFixture();
      Reflect.set(bridge, "renew", async () => ({
        renewal: { kind: "renewed", delayed: [] },
        era,
      }));
      const tokens = createDesktopHostTokenSource(bridge);

      await expect(tokens.renew(USER_ID, [HOST_ID])).resolves.toEqual({
        kind: "superseded",
      });
    },
  );

  it.each(invalidEras)(
    "does not keep an adopt with a malformed reply era (%s)",
    async (era) => {
      const { bridge } = bridgeFixture();
      Reflect.set(bridge, "adopt", async () => ({ era, kept: true }));
      const tokens = createDesktopHostTokenSource(bridge);

      await tokens.adopt(
        USER_ID,
        HOST_ID,
        HOST_TOKEN,
        tokens.era(USER_ID),
        () => true,
      );

      expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
    },
  );

  it.each(invalidEras)(
    "does not keep an event with a malformed era (%s)",
    (era) => {
      const { bridge, emit } = bridgeFixture();
      const tokens = createDesktopHostTokenSource(bridge);
      const change: HostTokenBridgeChange = {
        userId: USER_ID,
        hostId: HOST_ID,
        token: HOST_TOKEN,
        era: 0,
        replaced: null,
      };
      Reflect.set(change, "era", era);

      emit(change);

      expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
    },
  );

  it("reads a newer main era instead of trusting its last-known value", () => {
    const { bridge, setEra } = bridgeFixture();
    const tokens = createDesktopHostTokenSource(bridge);

    expect(tokens.era(USER_ID)).toBe(0);
    setEra(1);

    expect(tokens.era(USER_ID)).toBe(1);
    expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
  });
});

describe("desktop host-token source snapshot", () => {
  const signInLease = {
    identity: { userId: USER_ID },
    getBearerToken: () => "sign-in-token",
  };
  const OLD_TOKEN = { token: "older-host-token", expiresAtMs: 10_000 };
  const heldReply = (
    token: { readonly token: string; readonly expiresAtMs: number },
    era: number,
  ): HostTokenSnapshotReply => ({
    userId: USER_ID,
    era,
    tokens: [{ hostId: HOST_ID, token }],
  });

  it("presents no token and takes no probe until main's snapshot is applied", async () => {
    const snapshot = deferred<HostTokenSnapshotReply>();
    const { bridge, answerSnapshotWith } = bridgeFixture();
    answerSnapshotWith(snapshot.promise);
    const tokens = createDesktopHostTokenSource(bridge);
    const tracked = trackHostTokenMints(tokens, createReleasedHostMemory());
    const bearer = hostTokenBearer(
      tracked,
      () => signInLease,
      HOST_ID,
      () => undefined,
    );
    const unary = hostTokenBearerFor(tracked, () => undefined)(
      HOST_ID,
      signInLease,
      false,
      new AbortController().signal,
    );

    // Main may hold a token for this computer: no token is missing yet, so the
    // stream presents none and does not probe, and a call waits for the read.
    expect(tokens.loaded()).toBe(false);
    expect(bearer(HOST_ID, () => true)).toBeNull();
    expect(authnDidNotAnswer(tracked, USER_ID, HOST_ID)).toBe(false);
    expect(await Promise.race([unary, Promise.resolve("waiting")])).toBe(
      "waiting",
    );

    snapshot.resolve(heldReply(HOST_TOKEN, 0));
    await tokens.whenLoaded();

    expect(tokens.loaded()).toBe(true);
    expect(bearer(HOST_ID, () => true)?.getBearerToken()).toBe(
      HOST_TOKEN.token,
    );
    expect((await unary)?.getBearerToken()).toBe(HOST_TOKEN.token);
  });

  it.each([
    {
      name: "a newer token of the same era",
      changedHostId: HOST_ID,
      change: { token: HOST_TOKEN, era: 0, replaced: null },
      expected: HOST_TOKEN,
    },
    {
      name: "a removal of the same era",
      changedHostId: HOST_ID,
      change: { token: null, era: 0, replaced: null },
      expected: null,
    },
    {
      // Another computer's change of a newer era moves this window to that era,
      // which the snapshot's entries (read in the older one) are not in.
      name: "a newer era's change of another computer",
      changedHostId: "computer-b",
      change: { token: HOST_TOKEN, era: 1, replaced: null },
      expected: null,
    },
  ])(
    "does not let an older snapshot entry overwrite $name that arrived first",
    async ({ changedHostId, change, expected }) => {
      const reply = deferred<HostTokenSnapshotReply>();
      const { bridge, emit, setEra, answerSnapshotWith } = bridgeFixture();
      answerSnapshotWith(reply.promise);
      setEra(change.era);
      const tokens = createDesktopHostTokenSource(bridge);

      emit({ userId: USER_ID, hostId: changedHostId, ...change });
      reply.resolve(heldReply(OLD_TOKEN, 0));
      await tokens.whenLoaded();

      expect(tokens.current(USER_ID, HOST_ID)).toEqual(expected);
    },
  );

  it("counts a failed snapshot as loaded with nothing held, so the dial probes", async () => {
    const { bridge, answerSnapshotWith } = bridgeFixture();
    answerSnapshotWith(Promise.reject(new Error("main did not answer")));
    const tokens = createDesktopHostTokenSource(bridge);
    const tracked = trackHostTokenMints(tokens, createReleasedHostMemory());

    await tokens.whenLoaded();

    expect(tokens.loaded()).toBe(true);
    expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
    expect(authnDidNotAnswer(tracked, USER_ID, HOST_ID)).toBe(true);
    expect(
      hostTokenBearer(
        tracked,
        () => signInLease,
        HOST_ID,
        () => undefined,
      )(HOST_ID, () => true),
    ).toBeNull();
  });
});

describe("desktop host-token source across windows asking for different host processes", () => {
  /**
   * One window's bridge into `main`, as the auth IPC makes it: an ask crosses
   * with the process its window observed, and main asks its mint with that.
   */
  function bridgeInto(main: HostTokenSource): HostTokensBridgeSurface {
    return {
      era: (userId) => main.era(userId),
      signIn: (userId) => main.signInKey(userId),
      obtain: async (userId, hostId, fresh, expectedEra, owner) => {
        const asked: unknown = owner;
        const observed =
          typeof asked === "object" && asked !== null
            ? Reflect.get(asked, "observed")
            : undefined;
        // Main's own owner object: its records are keyed by that identity.
        const askOwner =
          typeof observed === "string" ? { hostId, observed } : null;
        const outcome =
          main.era(userId) === expectedEra
            ? await main.obtain(userId, hostId, fresh, {
                signal: null,
                ...(askOwner !== null && typeof observed === "string"
                  ? { owner: askOwner, observedNow: () => observed }
                  : { owner: null }),
              })
            : ({ kind: "superseded" } satisfies HostTokenMintOutcome);
        return {
          outcome,
          era: main.era(userId),
          held: outcome.kind === "ok",
          recorded:
            askOwner !== null &&
            (outcome.kind === "ok" ||
              main.lastFailureOf(userId, askOwner) === outcome.kind),
          signIn: main.signInKey(userId),
        };
      },
      renew: async (userId, hostIds, expectedEra) => ({
        renewal:
          main.era(userId) === expectedEra
            ? await main.renew(userId, hostIds)
            : { kind: "superseded" },
        era: main.era(userId),
      }),
      adopt: async (userId, hostId, token, expectedEra) => {
        const kept = await main.adopt(
          userId,
          hostId,
          token,
          expectedEra,
          () => true,
        );
        return { era: main.era(userId), kept };
      },
      forgetUser: async (userId) => {
        await main.forgetUser(userId);
        return { era: main.era(userId) };
      },
      snapshot: async () => EMPTY_SNAPSHOT,
      subscribe: (_handler) => ({ dispose: () => undefined }),
    };
  }

  it("makes main mint for each window's own process, and tells each window its own outcome", async () => {
    const answers = [
      deferred<HostTokenMintOutcome>(),
      deferred<HostTokenMintOutcome>(),
    ];
    let mintRequests = 0;
    const main = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        const own = answers[mintRequests];
        mintRequests += 1;
        return own.promise;
      },
      signIn: (userId) =>
        userId === USER_ID
          ? `header.${Buffer.from(JSON.stringify({ exp: 2_000_000 })).toString("base64url")}.signature`
          : null,
      now: () => Date.now(),
    });
    const hostsA = createReleasedHostMemory();
    hostsA.observeInstance(HOST_ID, "100");
    const ownerA = hostsA.currentInstance(HOST_ID);
    const hostsB = createReleasedHostMemory();
    hostsB.observeInstance(HOST_ID, "200");
    const ownerB = hostsB.currentInstance(HOST_ID);
    const windowA = createDesktopHostTokenSource(bridgeInto(main));
    const windowB = createDesktopHostTokenSource(bridgeInto(main));

    const askA = windowA.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: ownerA,
      observedNow: () => ownerA.observed,
    });
    await vi.waitFor(() => expect(mintRequests).toBe(1));
    const askB = windowB.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: ownerB,
      observedNow: () => ownerB.observed,
    });
    // Window A's ask is still held: window B's ask is not its answer.
    await vi.waitFor(() => expect(mintRequests).toBe(2));

    answers[0].resolve({ kind: "not-admitted" });
    answers[1].resolve({ kind: "ok", token: HOST_TOKEN });

    await expect(askA).resolves.toEqual({ kind: "not-admitted" });
    await expect(askB).resolves.toEqual({ kind: "ok", token: HOST_TOKEN });
    expect(windowA.lastFailureOf(USER_ID, ownerA)).toBe("not-admitted");
    expect(windowB.lastFailureOf(USER_ID, ownerB)).toBeNull();
  });
});

describe("desktop host-token source ordering by the second authn issued each token", () => {
  /** A host-only token shaped as authn issues it: a JWT whose `iat` says when. */
  function issuedAt(label: string, issuedAtSeconds: number): HostToken {
    const payload = Buffer.from(
      JSON.stringify({ iat: issuedAtSeconds, jti: label }),
    ).toString("base64url");
    return {
      token: `header.${payload}.signature`,
      expiresAtMs: 10_000_000_000,
    };
  }
  const REFUSED = issuedAt("refused", 2_000);
  const REPLACEMENT = issuedAt("replacement", 1_999);
  const OLDER = issuedAt("older", 1_000);
  const NEWER = issuedAt("newer", 3_000);

  type ObtainReply = {
    outcome: HostTokenMintOutcome;
    era: number;
    held: boolean;
    recorded: boolean;
    signIn: string | null;
  };

  /** A window already holding `REFUSED`, whose next ask to main is held. */
  async function windowAskingToReplaceTheRefusedToken() {
    const rig = bridgeFixture();
    Reflect.set(rig.bridge, "obtain", async () => ({
      outcome: { kind: "ok", token: REFUSED },
      era: 0,
      held: true,
      recorded: true,
      signIn: FIXED_SIGN_IN_KEY,
    }));
    const tokens = createDesktopHostTokenSource(rig.bridge);
    await tokens.obtain(USER_ID, HOST_ID, false, {
      signal: null,
      owner: null,
    });
    expect(tokens.current(USER_ID, HOST_ID)).toEqual(REFUSED);
    const answer = deferred<ObtainReply>();
    Reflect.set(rig.bridge, "obtain", () => answer.promise);
    const asking = tokens.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: null,
    });
    return { ...rig, tokens, answer, asking };
  }

  const replacementReply: ObtainReply = {
    outcome: { kind: "ok", token: REPLACEMENT },
    era: 0,
    held: true,
    recorded: true,
    signIn: FIXED_SIGN_IN_KEY,
  };

  it("replaces the refused cached token with the one main's change event announces, issued a second earlier, then takes the reply", async () => {
    const { tokens, emit, answer, asking } =
      await windowAskingToReplaceTheRefusedToken();

    emit({
      userId: USER_ID,
      hostId: HOST_ID,
      token: REPLACEMENT,
      era: 0,
      replaced: REFUSED.token,
    });
    answer.resolve(replacementReply);
    await asking;

    expect(tokens.current(USER_ID, HOST_ID)).toEqual(REPLACEMENT);
  });

  it("replaces the refused cached token with the reply's token, issued a second earlier, then takes main's change event", async () => {
    const { tokens, emit, answer, asking } =
      await windowAskingToReplaceTheRefusedToken();

    answer.resolve(replacementReply);
    await asking;
    emit({
      userId: USER_ID,
      hostId: HOST_ID,
      token: REPLACEMENT,
      era: 0,
      replaced: null,
    });

    expect(tokens.current(USER_ID, HOST_ID)).toEqual(REPLACEMENT);
  });

  it("keeps the later-issued token a change event announced when an older obtain reply arrives after it, and announces nothing for the reply", async () => {
    const { bridge, emit } = bridgeFixture();
    const answer = deferred<ObtainReply>();
    Reflect.set(bridge, "obtain", () => answer.promise);
    const tokens = createDesktopHostTokenSource(bridge);
    const asking = tokens.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: null,
    });
    emit({
      userId: USER_ID,
      hostId: HOST_ID,
      token: NEWER,
      era: 0,
      replaced: null,
    });
    const announced: string[] = [];
    tokens.subscribe(({ hostId }) => announced.push(hostId));

    answer.resolve({
      outcome: { kind: "ok", token: OLDER },
      era: 0,
      held: true,
      recorded: true,
      signIn: FIXED_SIGN_IN_KEY,
    });
    await asking;

    expect(tokens.current(USER_ID, HOST_ID)).toEqual(NEWER);
    expect(announced).toEqual([]);
  });

  it("does not install a token main answered but did not hold", async () => {
    const { bridge } = bridgeFixture();
    Reflect.set(bridge, "obtain", async () => ({
      outcome: { kind: "ok", token: NEWER },
      era: 0,
      held: false,
      recorded: true,
      signIn: FIXED_SIGN_IN_KEY,
    }));
    const tokens = createDesktopHostTokenSource(bridge);

    await expect(
      tokens.obtain(USER_ID, HOST_ID, true, { signal: null, owner: null }),
    ).resolves.toEqual({ kind: "ok", token: NEWER });

    expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
  });

  it("keeps the newer token a reply installed when an older change event arrives after it", async () => {
    const { bridge, emit } = bridgeFixture();
    Reflect.set(bridge, "obtain", async () => ({
      outcome: { kind: "ok", token: NEWER },
      era: 0,
      held: true,
      recorded: true,
      signIn: FIXED_SIGN_IN_KEY,
    }));
    const tokens = createDesktopHostTokenSource(bridge);
    await tokens.obtain(USER_ID, HOST_ID, true, { signal: null, owner: null });

    emit({
      userId: USER_ID,
      hostId: HOST_ID,
      token: OLDER,
      era: 0,
      replaced: null,
    });

    expect(tokens.current(USER_ID, HOST_ID)).toEqual(NEWER);
  });

  it("keeps the newer token a reply installed when the startup snapshot, taken before it, arrives after it", async () => {
    const snapshot = deferred<HostTokenSnapshotReply>();
    const { bridge, answerSnapshotWith } = bridgeFixture();
    answerSnapshotWith(snapshot.promise);
    Reflect.set(bridge, "obtain", async () => ({
      outcome: { kind: "ok", token: NEWER },
      era: 0,
      held: true,
      recorded: true,
      signIn: FIXED_SIGN_IN_KEY,
    }));
    const tokens = createDesktopHostTokenSource(bridge);
    await tokens.obtain(USER_ID, HOST_ID, true, { signal: null, owner: null });

    snapshot.resolve({
      userId: USER_ID,
      era: 0,
      tokens: [{ hostId: HOST_ID, token: OLDER }],
    });
    await tokens.whenLoaded();

    expect(tokens.current(USER_ID, HOST_ID)).toEqual(NEWER);
  });
});

describe("a window records a refused mint only when main kept it under main's current sign-in", () => {
  it.each([
    { name: "kept", recorded: true, failure: "sign-in-rejected" },
    { name: "not kept", recorded: false, failure: null },
  ])(
    "answers lastFailureOf for the refusal main says it $name",
    async ({ recorded, failure }) => {
      const { bridge } = bridgeFixture();
      Reflect.set(bridge, "obtain", async () => ({
        outcome: { kind: "sign-in-rejected" },
        era: 0,
        held: false,
        recorded,
        signIn: FIXED_SIGN_IN_KEY,
      }));
      const tokens = createDesktopHostTokenSource(bridge);
      const hosts = createReleasedHostMemory();
      hosts.observeInstance(HOST_ID, "100");
      const owner = hosts.currentInstance(HOST_ID);

      await expect(
        tokens.obtain(USER_ID, HOST_ID, true, {
          signal: null,
          owner,
          observedNow: () => owner.observed,
        }),
      ).resolves.toEqual({ kind: "sign-in-rejected" });

      expect(tokens.lastFailureOf(USER_ID, owner)).toBe(failure);
    },
  );
});

describe("a window whose main could not save a token holds the outcome main holds", () => {
  it("answers lastFailureOf as unavailable, not as the earlier not-a-member, after main's obtain rejects", async () => {
    const { bridge } = bridgeFixture();
    let asks = 0;
    Reflect.set(bridge, "obtain", async () => {
      asks += 1;
      if (asks > 1) throw new Error("the token could not be saved");
      return {
        outcome: { kind: "not-a-member" },
        era: 0,
        held: false,
        recorded: true,
        signIn: FIXED_SIGN_IN_KEY,
      };
    });
    const tokens = createDesktopHostTokenSource(bridge);
    const hosts = createReleasedHostMemory();
    hosts.observeInstance(HOST_ID, "100");
    const owner = hosts.currentInstance(HOST_ID);
    const ask = (): Promise<HostTokenMintOutcome> =>
      tokens.obtain(USER_ID, HOST_ID, true, {
        signal: null,
        owner,
        observedNow: () => owner.observed,
      });

    await expect(ask()).resolves.toEqual({ kind: "not-a-member" });
    expect(tokens.lastFailureOf(USER_ID, owner)).toBe("not-a-member");
    await expect(ask()).rejects.toThrow("the token could not be saved");

    expect(tokens.lastFailureOf(USER_ID, owner)).toBe("unavailable");
  });
});
