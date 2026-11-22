import { describe, expect, it, vi } from "vitest";
import {
  authnDidNotAnswer,
  hostTokenBearer,
  hostTokenBearerFor,
  trackHostTokenMints,
} from "@traycer-clients/shared/auth/host-token-lease";
import type {
  HostTokenMintOutcome,
  HostTokenRenewal,
} from "@traycer-clients/shared/auth/host-token-source";
import { createReleasedHostMemory } from "@traycer-clients/shared/host-transport/released-sign-on";
import type {
  HostTokenBridgeChange,
  HostTokenSnapshotReply,
  HostTokensBridgeSurface,
} from "../../ipc-contracts/host-token-types";
import { NO_ISSUED_HOST_TOKEN_ERA } from "../../ipc-contracts/host-token-types";
import { createDesktopHostTokenSource } from "../desktop-host-tokens";

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
    obtain: async () => ({
      outcome: { kind: "ok", token: HOST_TOKEN },
      era: mainEra,
    }),
    renew: async () => ({ renewal: { kind: "already-current" }, era: mainEra }),
    adopt: async () => ({ era: mainEra }),
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
    const answer = deferred<{ outcome: HostTokenMintOutcome; era: number }>();
    let obtainCalls = 0;
    let mainEra = 0;
    const bridge: HostTokensBridgeSurface = {
      era: () => mainEra,
      obtain: () => {
        obtainCalls += 1;
        return answer.promise;
      },
      renew: async () => ({
        renewal: { kind: "already-current" },
        era: mainEra,
      }),
      adopt: async () => ({ era: mainEra }),
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
      obtain: async () => ({ outcome: { kind: "no-sign-in" }, era: mainEra }),
      renew: () => answer.promise,
      adopt: async () => ({ era: mainEra }),
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
    const answer = deferred<{ outcome: HostTokenMintOutcome; era: number }>();
    const { bridge, emit, setEra } = bridgeFixture();
    setEra(1);
    Reflect.set(bridge, "obtain", () => answer.promise);
    const tokens = createDesktopHostTokenSource(bridge);

    const pending = tokens.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: null,
    });
    setEra(2);
    emit({ userId: USER_ID, hostId: HOST_ID, token: null, era: 2 });
    answer.resolve({
      outcome: { kind: "unavailable", detail: "authn answered HTTP 503" },
      era: 1,
    });

    await expect(pending).resolves.toEqual({ kind: "superseded" });
  });

  it("does not keep an ok obtain answer from a prior era", async () => {
    const answer = deferred<{ outcome: HostTokenMintOutcome; era: number }>();
    const { bridge, emit, setEra } = bridgeFixture();
    setEra(1);
    Reflect.set(bridge, "obtain", () => answer.promise);
    const tokens = createDesktopHostTokenSource(bridge);

    const pending = tokens.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: null,
    });
    setEra(2);
    emit({ userId: USER_ID, hostId: HOST_ID, token: null, era: 2 });
    answer.resolve({
      outcome: {
        kind: "ok",
        token: { token: "late-era-one-token", expiresAtMs: 10_000 },
      },
      era: 1,
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
    emit({ userId: USER_ID, hostId: HOST_ID, token: null, era: 2 });
    answer.resolve({ renewal: { kind: "renewed", delayed: [] }, era: 1 });

    await expect(pending).resolves.toEqual({ kind: "superseded" });
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
    emit({ userId: USER_ID, hostId: HOST_ID, token: HOST_TOKEN, era: 0 });
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

  it("announces every copied host when another host reports a newer era", async () => {
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
    emit({ userId: USER_ID, hostId: eventHostId, token: null, era: 1 });

    expect(changes).toEqual([
      { userId: USER_ID, hostId: HOST_ID },
      { userId: USER_ID, hostId: otherHostId },
      { userId: USER_ID, hostId: eventHostId },
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
    emit({ userId: USER_ID, hostId: HOST_ID, token: null, era: 1 });

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
        return { outcome: { kind: "ok", token: HOST_TOKEN }, era: 0 };
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
      Reflect.set(bridge, "adopt", async () => ({ era }));
      const tokens = createDesktopHostTokenSource(bridge);

      await tokens.adopt(USER_ID, HOST_ID, HOST_TOKEN, tokens.era(USER_ID));

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
    expect(bearer(HOST_ID)).toBeNull();
    expect(authnDidNotAnswer(tracked, USER_ID, HOST_ID)).toBe(false);
    expect(await Promise.race([unary, Promise.resolve("waiting")])).toBe(
      "waiting",
    );

    snapshot.resolve(heldReply(HOST_TOKEN, 0));
    await tokens.whenLoaded();

    expect(tokens.loaded()).toBe(true);
    expect(bearer(HOST_ID)?.getBearerToken()).toBe(HOST_TOKEN.token);
    expect((await unary)?.getBearerToken()).toBe(HOST_TOKEN.token);
  });

  it.each([
    {
      name: "a newer token of the same era",
      changedHostId: HOST_ID,
      change: { token: HOST_TOKEN, era: 0 },
      expected: HOST_TOKEN,
    },
    {
      name: "a removal of the same era",
      changedHostId: HOST_ID,
      change: { token: null, era: 0 },
      expected: null,
    },
    {
      // Another computer's change of a newer era moves this window to that era,
      // which the snapshot's entries (read in the older one) are not in.
      name: "a newer era's change of another computer",
      changedHostId: "computer-b",
      change: { token: HOST_TOKEN, era: 1 },
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
      )(HOST_ID),
    ).toBeNull();
  });
});

describe("desktop host-token source across host process instances", () => {
  it("sends an ask for the replacement process to main only after the earlier process's ask settled", async () => {
    const hosts = createReleasedHostMemory();
    hosts.observeInstance(HOST_ID, "process-a");
    const earlier = hosts.currentInstance(HOST_ID);
    hosts.observeInstance(HOST_ID, "process-b");
    const replacement = hosts.currentInstance(HOST_ID);
    // What main saw and what the test did, in order: main joins asks by
    // person and host, so a second ask beside the first would share its mint.
    const events: string[] = [];
    const answers = [
      deferred<{ outcome: HostTokenMintOutcome; era: number }>(),
      deferred<{ outcome: HostTokenMintOutcome; era: number }>(),
    ];
    let receivedAsks = 0;
    const bridge: HostTokensBridgeSurface = {
      era: () => 0,
      obtain: () => {
        receivedAsks += 1;
        events.push(`main received ask ${receivedAsks}`);
        return answers[receivedAsks - 1].promise;
      },
      renew: async () => ({ renewal: { kind: "already-current" }, era: 0 }),
      adopt: async () => ({ era: 0 }),
      forgetUser: async () => ({ era: 1 }),
      snapshot: async () => EMPTY_SNAPSHOT,
      subscribe: (_handler) => ({ dispose: () => undefined }),
    };
    const tokens = createDesktopHostTokenSource(bridge);

    const earlierAsk = tokens.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: earlier,
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const replacementAsk = tokens.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: replacement,
    });
    await Promise.resolve();

    events.push("the earlier process's ask answered");
    answers[0].resolve({ outcome: { kind: "not-admitted" }, era: 0 });
    await vi.waitFor(() => expect(events).toHaveLength(3));
    answers[1].resolve({ outcome: { kind: "ok", token: HOST_TOKEN }, era: 0 });
    await Promise.all([earlierAsk, replacementAsk]);

    expect(events).toEqual([
      "main received ask 1",
      "the earlier process's ask answered",
      "main received ask 2",
    ]);
  });
});
