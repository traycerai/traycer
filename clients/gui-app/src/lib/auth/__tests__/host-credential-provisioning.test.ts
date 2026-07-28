import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCredentialMintOutcome } from "@traycer-clients/shared/host-transport/host-credential-mint-flow";
import {
  appHostCredentialMintFlow,
  resetHostCredentialProvisioning,
  setHostCredentialMintRunner,
} from "../host-credential-provisioning";

afterEach(() => {
  setHostCredentialMintRunner(null);
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
