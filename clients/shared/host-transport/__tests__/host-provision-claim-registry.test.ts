import { describe, expect, it } from "vitest";
import {
  HOST_PROVISION_CLAIM_TTL_MS,
  HostProvisionClaimRegistry,
} from "../host-provision-claim-registry";

/**
 * Cross-window claim registry unit tests. The clock is injected so TTL
 * decisions are deterministic — wall-clock timers would flake and would not
 * pin the exact TTL-1 / TTL boundary the policy relies on.
 */
describe("HostProvisionClaimRegistry", () => {
  const HOST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const HOLDER_A = 101;
  const HOLDER_B = 202;
  const HOLDER_C = 303;

  function createRegistry(startMs: number): {
    readonly registry: HostProvisionClaimRegistry;
    readonly setNow: (ms: number) => void;
  } {
    let nowMs = startMs;
    return {
      registry: new HostProvisionClaimRegistry(() => nowMs),
      setNow: (ms: number) => {
        nowMs = ms;
      },
    };
  }

  /** Asserts a grant and hands back the token `release` will require. */
  function grantedToken(
    registry: HostProvisionClaimRegistry,
    holderId: number,
  ): string {
    const claim = registry.claim(HOST, holderId);
    if (claim.kind !== "granted") {
      throw new Error(`expected holder ${holderId} to be granted the claim`);
    }
    return claim.token;
  }

  function claimKind(
    registry: HostProvisionClaimRegistry,
    holderId: number,
  ): string {
    return registry.claim(HOST, holderId).kind;
  }

  it("denies a second holder while the first still holds the claim", () => {
    const { registry } = createRegistry(1_000);
    grantedToken(registry, HOLDER_A);
    expect(claimKind(registry, HOLDER_B)).toBe("denied");
  });

  it("settles the host on release so a later holder is still denied", () => {
    // Both success and decline end the holder's turn the same way: release
    // records "asked", not which answer was given.
    const { registry } = createRegistry(1_000);
    const token = grantedToken(registry, HOLDER_A);
    registry.release(HOST, token);
    expect(claimKind(registry, HOLDER_B)).toBe("denied");
  });

  it("retainHolders dropping a holder frees the host without settling it", () => {
    // Window closed mid-prompt: nobody answered, so the next window may ask.
    const { registry } = createRegistry(1_000);
    grantedToken(registry, HOLDER_A);
    registry.retainHolders(new Set([HOLDER_B]));
    expect(claimKind(registry, HOLDER_B)).toBe("granted");
  });

  it("a late release from an overtaken holder does not settle under the new holder", () => {
    const { registry, setNow } = createRegistry(0);
    const staleToken = grantedToken(registry, HOLDER_A);

    // TTL elapses; HOLDER_B steals the abandoned claim.
    setNow(HOST_PROVISION_CLAIM_TTL_MS);
    grantedToken(registry, HOLDER_B);

    // HOLDER_A's delayed finally must not settle the host out from under B.
    registry.release(HOST, staleToken);

    // Asking again here proves nothing on its own: a host that B still HOLDS
    // and a host wrongly SETTLED by A both answer "denied". Drop B's claim the
    // way a closing window would, which clears held-ness but never
    // settled-ness - only then do the two states give different answers.
    registry.retainHolders(new Set());
    expect(claimKind(registry, HOLDER_C)).toBe("granted");
  });

  it("settles only on the current holder's release, after a TTL steal", () => {
    const { registry, setNow } = createRegistry(0);
    grantedToken(registry, HOLDER_A);
    setNow(HOST_PROVISION_CLAIM_TTL_MS);
    const liveToken = grantedToken(registry, HOLDER_B);

    registry.release(HOST, liveToken);
    // Settled by the real holder, so freeing the claim does not reopen it.
    registry.retainHolders(new Set());
    expect(claimKind(registry, HOLDER_C)).toBe("denied");
  });

  it("a release held across a reset cannot settle the same holder's next claim", () => {
    // The identity-change case: one window legitimately holds two different
    // claims on the same host over time, so `(hostId, holder)` alone cannot
    // tell them apart. Only the token can.
    const { registry } = createRegistry(1_000);
    const beforeReset = grantedToken(registry, HOLDER_A);

    registry.reset();
    grantedToken(registry, HOLDER_A);

    // The pre-reset finally lands, naming a claim that no longer exists.
    registry.release(HOST, beforeReset);

    // The post-reset claim must still be live and unsettled: freeing it the way
    // a closing window would has to reopen the host.
    registry.retainHolders(new Set());
    expect(claimKind(registry, HOLDER_C)).toBe("granted");
  });

  it("issues a distinct token per claim, including across a reset", () => {
    const { registry } = createRegistry(1_000);
    const first = grantedToken(registry, HOLDER_A);
    registry.reset();
    const second = grantedToken(registry, HOLDER_A);
    expect(second).not.toBe(first);
  });

  it("denies a steal at TTL-1ms and grants at exactly TTL", () => {
    const { registry, setNow } = createRegistry(0);
    grantedToken(registry, HOLDER_A);

    setNow(HOST_PROVISION_CLAIM_TTL_MS - 1);
    expect(claimKind(registry, HOLDER_B)).toBe("denied");

    setNow(HOST_PROVISION_CLAIM_TTL_MS);
    expect(claimKind(registry, HOLDER_B)).toBe("granted");
  });

  it("reset clears both active claims and settled hosts", () => {
    const { registry } = createRegistry(1_000);
    const token = grantedToken(registry, HOLDER_A);
    registry.release(HOST, token);
    expect(claimKind(registry, HOLDER_B)).toBe("denied");

    registry.reset();
    expect(claimKind(registry, HOLDER_B)).toBe("granted");
  });

  it("release with an unknown token is a no-op (does not settle)", () => {
    const { registry } = createRegistry(1_000);
    grantedToken(registry, HOLDER_A);
    registry.release(HOST, "not-a-real-token");

    // As above, "denied" here would be satisfied by A still holding OR by the
    // stray release having settled the host. Free the active claim first so
    // only a wrongly-settled host can still answer "denied".
    registry.retainHolders(new Set());
    expect(claimKind(registry, HOLDER_C)).toBe("granted");
  });
});
