import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCredentialMintOutcome } from "@traycer-clients/shared/host-transport/host-credential-mint-flow";
import {
  appHostCredentialMintFlow,
  resetHostCredentialProvisioning,
  setHostCredentialMintRunner,
  setHostCredentialProvisionGate,
} from "../host-credential-provisioning";

afterEach(() => {
  setHostCredentialMintRunner(null);
  setHostCredentialProvisionGate(null);
  resetHostCredentialProvisioning();
});

describe("appHostCredentialMintFlow single-flight policy", () => {
  it("declines when no runner is installed", async () => {
    const outcome = await appHostCredentialMintFlow({
      hostId: "host-1",
      reason: "missing",
    });
    expect(outcome).toEqual({ kind: "declined" });
  });

  function provisionedOutcome(): HostCredentialMintOutcome {
    return {
      kind: "provisioned",
      token: "tok",
      refreshToken: "ref",
      familyId: "family-1",
      provisionedAt: "2026-07-08T12:00:00.000Z",
      expiresIn: 900,
    };
  }

  it("collapses concurrent notices for the same host into ONE runner call", async () => {
    const deferred: {
      resolve: ((outcome: HostCredentialMintOutcome) => void) | null;
    } = { resolve: null };
    const runner = vi.fn(
      () =>
        new Promise<HostCredentialMintOutcome>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    setHostCredentialMintRunner(runner);

    const a = appHostCredentialMintFlow({
      hostId: "host-shared",
      reason: "missing",
    });
    const b = appHostCredentialMintFlow({
      hostId: "host-shared",
      reason: "missing",
    });
    const c = appHostCredentialMintFlow({
      hostId: "host-shared",
      reason: "needs-reauth",
    });

    expect(runner).toHaveBeenCalledTimes(1);

    const resolveRunner = deferred.resolve;
    if (resolveRunner === null) {
      throw new Error("runner was never started");
    }
    resolveRunner(provisionedOutcome());

    const results = await Promise.all([a, b, c]);
    // Single delivery: exactly one joiner receives the credential.
    expect(results.filter((r) => r.kind === "provisioned")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "unavailable")).toHaveLength(2);
    expect(results.find((r) => r.kind === "provisioned")).toEqual(
      provisionedOutcome(),
    );
  });

  it("hands the provisioned credential to exactly one of N joiners", async () => {
    const deferred: {
      resolve: ((outcome: HostCredentialMintOutcome) => void) | null;
    } = { resolve: null };
    const runner = vi.fn(
      () =>
        new Promise<HostCredentialMintOutcome>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    setHostCredentialMintRunner(runner);

    const joiners = Array.from({ length: 5 }, () =>
      appHostCredentialMintFlow({ hostId: "host-once", reason: "missing" }),
    );
    expect(runner).toHaveBeenCalledTimes(1);

    const resolveRunner = deferred.resolve;
    if (resolveRunner === null) {
      throw new Error("runner was never started");
    }
    resolveRunner(provisionedOutcome());

    const results = await Promise.all(joiners);
    expect(results.filter((r) => r.kind === "provisioned")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "unavailable")).toHaveLength(4);
  });

  it("generation-scopes an in-flight attempt across reset (sign-out)", async () => {
    // An attempt still running when identity resets must resolve unavailable
    // and must NOT write into the new identity's settled memo.
    const deferred: {
      resolve: ((outcome: HostCredentialMintOutcome) => void) | null;
    } = { resolve: null };
    const runner = vi.fn(
      () =>
        new Promise<HostCredentialMintOutcome>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    setHostCredentialMintRunner(runner);

    const inFlight = appHostCredentialMintFlow({
      hostId: "host-gen",
      reason: "missing",
    });
    expect(runner).toHaveBeenCalledTimes(1);

    resetHostCredentialProvisioning();

    const resolveRunner = deferred.resolve;
    if (resolveRunner === null) {
      throw new Error("runner was never started");
    }
    resolveRunner(provisionedOutcome());

    await expect(inFlight).resolves.toEqual({ kind: "unavailable" });

    // Settled memo was not poisoned: a fresh attempt for the same host is
    // offered again under the new generation.
    const after = appHostCredentialMintFlow({
      hostId: "host-gen",
      reason: "missing",
    });
    const resolveAfter = deferred.resolve;
    if (resolveAfter === null) {
      throw new Error("post-reset runner was never started");
    }
    // Second call to the runner - deferred was reused when runner runs again.
    // The runner mock always overwrites deferred.resolve, so after reset a new
    // attempt should have called the runner a second time.
    expect(runner).toHaveBeenCalledTimes(2);
    resolveAfter({ kind: "declined" });
    await expect(after).resolves.toEqual({ kind: "declined" });
  });

  it("does not re-prompt a host that already settled (decline memo)", async () => {
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.resolve({ kind: "declined" }),
    );
    setHostCredentialMintRunner(runner);

    await expect(
      appHostCredentialMintFlow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "declined" });
    await expect(
      appHostCredentialMintFlow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "declined" });

    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("resetHostCredentialProvisioning clears the decline memo (sign-out path)", async () => {
    // Without this, the next user on the machine inherits the previous user's
    // decline and is never offered provisioning for that host.
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.resolve({ kind: "declined" }),
    );
    setHostCredentialMintRunner(runner);

    await appHostCredentialMintFlow({ hostId: "host-1", reason: "missing" });
    expect(runner).toHaveBeenCalledTimes(1);

    resetHostCredentialProvisioning();

    await appHostCredentialMintFlow({ hostId: "host-1", reason: "missing" });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("does not single-flight across different hostIds", async () => {
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.resolve({ kind: "declined" }),
    );
    setHostCredentialMintRunner(runner);

    await Promise.all([
      appHostCredentialMintFlow({ hostId: "host-a", reason: "missing" }),
      appHostCredentialMintFlow({ hostId: "host-b", reason: "missing" }),
    ]);

    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("maps a thrown runner to unavailable and still settles the host", async () => {
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.reject(new Error("dialog crashed")),
    );
    setHostCredentialMintRunner(runner);

    await expect(
      appHostCredentialMintFlow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });

    // Settled: no second prompt after a throw.
    await expect(
      appHostCredentialMintFlow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "declined" });
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe("appHostCredentialMintFlow cross-window provision gate", () => {
  function provisionedOutcome(): HostCredentialMintOutcome {
    return {
      kind: "provisioned",
      token: "tok",
      refreshToken: "ref",
      familyId: "family-1",
      provisionedAt: "2026-07-08T12:00:00.000Z",
      expiresIn: 900,
    };
  }

  it("never invokes the runner and returns declined when the gate denies", async () => {
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.resolve(provisionedOutcome()),
    );
    // First deny, then grant — a denial must NOT settle the host (settles:false),
    // or the next asker could never take a claim the shell re-granted.
    let grantNext = false;
    const claim = vi.fn((): Promise<string | null> =>
      Promise.resolve(grantNext ? "claim-1" : null),
    );
    const release = vi.fn((): Promise<void> => Promise.resolve());
    setHostCredentialMintRunner(runner);
    setHostCredentialProvisionGate({ claim, release });

    await expect(
      appHostCredentialMintFlow({ hostId: "host-gated", reason: "missing" }),
    ).resolves.toEqual({ kind: "declined" });

    expect(claim).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    grantNext = true;
    // No local reset: denial must leave the host unsettled so a later grant runs.
    await expect(
      appHostCredentialMintFlow({ hostId: "host-gated", reason: "missing" }),
    ).resolves.toEqual(provisionedOutcome());
    expect(claim).toHaveBeenCalledTimes(2);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("runs the runner when the gate grants and always releases even if the runner throws", async () => {
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.reject(new Error("dialog crashed")),
    );
    const claim = vi.fn((): Promise<string | null> =>
      Promise.resolve("claim-1"),
    );
    const release = vi.fn((): Promise<void> => Promise.resolve());
    setHostCredentialMintRunner(runner);
    setHostCredentialProvisionGate({ claim, release });

    await expect(
      appHostCredentialMintFlow({ hostId: "host-throw", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });

    expect(claim).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledTimes(1);
    // Release is fire-and-forget; yield so the voided promise can settle.
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
    // Released against the token the claim issued - releasing by host alone
    // would settle whichever claim happened to be active at the time.
    expect(release).toHaveBeenCalledWith("host-throw", "claim-1");
  });

  it("preserves a provisioned outcome when release rejects", async () => {
    // Regression: an awaited release in `finally` would throw away the
    // credential we already hold if the shell's release IPC failed.
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.resolve(provisionedOutcome()),
    );
    const claim = vi.fn((): Promise<string | null> =>
      Promise.resolve("claim-1"),
    );
    const release = vi.fn((): Promise<void> =>
      Promise.reject(new Error("ipc dead")),
    );
    setHostCredentialMintRunner(runner);
    setHostCredentialProvisionGate({ claim, release });

    await expect(
      appHostCredentialMintFlow({
        hostId: "host-release-fail",
        reason: "missing",
      }),
    ).resolves.toEqual(provisionedOutcome());

    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("joins concurrent local callers into ONE gate claim while the claim is in flight", async () => {
    // The attempt is registered in the map synchronously before the gate's
    // async claim resolves — a second local transport must join, not double-claim.
    const claimDeferred: {
      resolve: ((token: string | null) => void) | null;
    } = { resolve: null };
    const claim = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          claimDeferred.resolve = resolve;
        }),
    );
    const release = vi.fn((): Promise<void> => Promise.resolve());
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.resolve(provisionedOutcome()),
    );
    setHostCredentialMintRunner(runner);
    setHostCredentialProvisionGate({ claim, release });

    const a = appHostCredentialMintFlow({
      hostId: "host-inflight",
      reason: "missing",
    });
    const b = appHostCredentialMintFlow({
      hostId: "host-inflight",
      reason: "missing",
    });

    expect(claim).toHaveBeenCalledTimes(1);

    const resolveClaim = claimDeferred.resolve;
    if (resolveClaim === null) {
      throw new Error("gate claim was never started");
    }
    resolveClaim("claim-1");

    const results = await Promise.all([a, b]);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.kind === "provisioned")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "unavailable")).toHaveLength(1);
  });

  it("allows the runner to run with no gate installed (pre-gate behaviour)", async () => {
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.resolve(provisionedOutcome()),
    );
    setHostCredentialMintRunner(runner);
    // gate left null

    await expect(
      appHostCredentialMintFlow({ hostId: "host-ungated", reason: "missing" }),
    ).resolves.toEqual(provisionedOutcome());
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
