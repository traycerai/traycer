import { describe, expect, it } from "vitest";
import type {
  HostTokenMintOutcome,
  HostTokenRenewal,
} from "@traycer-clients/shared/auth/host-token-source";
import type { HostTokensBridgeSurface } from "../../ipc-contracts/host-token-types";
import { createDesktopHostTokenSource } from "../desktop-host-tokens";

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

describe("desktop host-token source eras", () => {
  it("drops an ok bridge answer that arrives after forgetUser", async () => {
    const answer = deferred<HostTokenMintOutcome>();
    let obtainCalls = 0;
    const bridge: HostTokensBridgeSurface = {
      obtain: () => {
        obtainCalls += 1;
        return answer.promise;
      },
      renew: async () => ({ kind: "already-current" }),
      adopt: async () => undefined,
      forgetUser: async () => undefined,
      subscribe: (_handler) => ({ dispose: () => undefined }),
    };
    const tokens = createDesktopHostTokenSource(bridge);

    const pending = tokens.obtain("user-a", "computer-a", false, null);
    await tokens.forgetUser("user-a");
    answer.resolve({
      kind: "ok",
      token: { token: "late-host-token", expiresAtMs: 10_000 },
    });

    await expect(pending).resolves.toEqual({ kind: "superseded" });
    expect(obtainCalls).toBe(1);
    expect(tokens.era("user-a")).toBe(1);
    expect(tokens.current("user-a", "computer-a")).toBeNull();
  });

  it("supersedes a bridge renewal that answers after forgetUser", async () => {
    const answer = deferred<HostTokenRenewal>();
    const bridge: HostTokensBridgeSurface = {
      obtain: async () => ({ kind: "no-sign-in" }),
      renew: () => answer.promise,
      adopt: async () => undefined,
      forgetUser: async () => undefined,
      subscribe: (_handler) => ({ dispose: () => undefined }),
    };
    const tokens = createDesktopHostTokenSource(bridge);

    const pending = tokens.renew("user-a", ["computer-a"]);
    await tokens.forgetUser("user-a");
    answer.resolve({ kind: "renewed", delayed: [] });

    await expect(pending).resolves.toEqual({ kind: "superseded" });
    expect(tokens.era("user-a")).toBe(1);
  });
});
