import { describe, expect, it } from "vitest";
import type {
  HostTokenMintOutcome,
  HostTokenRenewal,
} from "@traycer-clients/shared/auth/host-token-source";
import type {
  HostTokenBridgeChange,
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

function bridgeFixture(): {
  readonly bridge: HostTokensBridgeSurface;
  readonly emit: (change: HostTokenBridgeChange) => void;
  readonly setEra: (era: number) => void;
} {
  let mainEra = 0;
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
      subscribe: (_handler) => ({ dispose: () => undefined }),
    };
    const tokens = createDesktopHostTokenSource(bridge);

    const pending = tokens.obtain(USER_ID, HOST_ID, false, null);
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

    const pending = tokens.obtain(USER_ID, HOST_ID, true, null);
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

    const pending = tokens.obtain(USER_ID, HOST_ID, true, null);
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

    await expect(tokens.obtain(USER_ID, HOST_ID, false, null)).resolves.toEqual(
      {
        kind: "ok",
        token: HOST_TOKEN,
      },
    );
    expect(tokens.current(USER_ID, HOST_ID)).toEqual(HOST_TOKEN);

    const forgetting = tokens.forgetUser(USER_ID);
    expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
    emit({ userId: USER_ID, hostId: HOST_ID, token: HOST_TOKEN, era: 0 });
    expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
    await forgetting;
  });

  it("empties all copied hosts on a newer-era event", async () => {
    const { bridge, emit, setEra } = bridgeFixture();
    const tokens = createDesktopHostTokenSource(bridge);
    const otherHostId = "computer-b";
    await tokens.obtain(USER_ID, HOST_ID, false, null);
    await tokens.obtain(USER_ID, otherHostId, false, null);
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
        tokens.obtain(USER_ID, HOST_ID, false, null),
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
        tokens.obtain(USER_ID, HOST_ID, false, null),
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
