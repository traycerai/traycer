import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCredentialMintOutcome } from "@traycer-clients/shared/host-transport/host-credential-mint-flow";
import {
  appHostCredentialMintFlow,
  noteHostCredentialState,
  resetHostCredentialProvisioning,
  setHostCredentialMintRunner,
} from "../host-credential-provisioning";

afterEach(() => {
  setHostCredentialMintRunner(null);
  resetHostCredentialProvisioning();
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

describe("appHostCredentialMintFlow single-flight policy", () => {
  it("resolves unavailable when no runner is installed", async () => {
    const outcome = await appHostCredentialMintFlow({
      hostId: "host-1",
      reason: "missing",
    });
    expect(outcome).toEqual({ kind: "unavailable" });
  });

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

  it("generation-scopes an in-flight attempt across reset (sign-out) so it resolves unavailable, not handed to the next identity", async () => {
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

    // Not poisoned: a fresh attempt for the same host is offered again under
    // the new generation, and gets its own runner call.
    const after = appHostCredentialMintFlow({
      hostId: "host-gen",
      reason: "missing",
    });
    const resolveAfter = deferred.resolve;
    if (resolveAfter === null) {
      throw new Error("post-reset runner was never started");
    }
    expect(runner).toHaveBeenCalledTimes(2);
    resolveAfter(provisionedOutcome());
    await expect(after).resolves.toEqual(provisionedOutcome());
  });

  it("does not memoize a settled outcome — a later call for the same host re-invokes the runner", async () => {
    // Provisioning is no longer step-up gated and there is no decline memo:
    // an attempt that already settled must not stop a later transport from
    // trying again (e.g. a transient network error on first connect should
    // not strand a host on the client lease for the rest of the app run).
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.resolve({ kind: "unavailable" }),
    );
    setHostCredentialMintRunner(runner);

    await expect(
      appHostCredentialMintFlow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(
      appHostCredentialMintFlow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });

    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("does not single-flight across different hostIds", async () => {
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.resolve({ kind: "unavailable" }),
    );
    setHostCredentialMintRunner(runner);

    await Promise.all([
      appHostCredentialMintFlow({ hostId: "host-a", reason: "missing" }),
      appHostCredentialMintFlow({ hostId: "host-b", reason: "missing" }),
    ]);

    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("maps a thrown runner to unavailable and still frees the host for a later attempt", async () => {
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.reject(new Error("mint crashed")),
    );
    setHostCredentialMintRunner(runner);

    await expect(
      appHostCredentialMintFlow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });

    expect(runner).toHaveBeenCalledTimes(1);
  });
});

/**
 * The window between a mint SETTLING and the host actually adopting the
 * credential.
 *
 * `attemptsByHostId` is cleared the moment the mint resolves, but the
 * credential still has to ride a live socket to the host. In between, the app
 * looks to any newly-constructed transport exactly as it does before a first
 * mint - and a per-`WsStreamClient` "already attempted" set cannot close this,
 * because a fresh client starts with an empty one and the renderer routinely
 * builds several against one host. Two mints then race, and the server
 * supersedes older credentials on every mint, so they can revoke one another
 * and leave the host holding nothing at all.
 */
describe("appHostCredentialMintFlow adoption claim", () => {
  it("refuses a second mint while a freshly minted credential is still in flight", async () => {
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);

    // Transport 1 mints and receives the credential; the host has NOT adopted
    // it yet, so it is still reporting `needs-reauth` on any ack in flight.
    const first = await appHostCredentialMintFlow({
      hostId: "host-adopting",
      reason: "needs-reauth",
    });
    expect(first.kind).toBe("provisioned");
    expect(runner).toHaveBeenCalledTimes(1);

    // A DIFFERENT transport - fresh instance, empty per-instance bookkeeping -
    // sees that same stale `needs-reauth` and asks.
    const second = await appHostCredentialMintFlow({
      hostId: "host-adopting",
      reason: "needs-reauth",
    });

    expect(second).toEqual({ kind: "unavailable" });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("allows the next mint once the host is seen active", async () => {
    // The claim must not become a latch: a host that adopts and is later
    // refused again is entitled to another credential.
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);

    await appHostCredentialMintFlow({
      hostId: "host-cycle",
      reason: "needs-reauth",
    });
    expect(runner).toHaveBeenCalledTimes(1);

    // Positive proof of delivery - the only thing that releases the claim.
    noteHostCredentialState("host-cycle", "active");

    await appHostCredentialMintFlow({
      hostId: "host-cycle",
      reason: "needs-reauth",
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("does not release the claim on a repeated needs-reauth ack", async () => {
    // A host still asking is not proof of delivery - its ask may simply
    // predate the credential now on its way. Only `active` counts.
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);

    await appHostCredentialMintFlow({
      hostId: "host-still-asking",
      reason: "needs-reauth",
    });
    noteHostCredentialState("host-still-asking", "needs-reauth");
    noteHostCredentialState("host-still-asking", "missing");

    await appHostCredentialMintFlow({
      hostId: "host-still-asking",
      reason: "needs-reauth",
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("does not hold a claim for a mint that produced no credential", async () => {
    // Nothing is in flight after an `unavailable`, so nothing should be
    // waited for - a failed attempt must stay retryable by a later transport.
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.resolve({ kind: "unavailable" }),
    );
    setHostCredentialMintRunner(runner);

    await appHostCredentialMintFlow({
      hostId: "host-failed",
      reason: "missing",
    });
    await appHostCredentialMintFlow({
      hostId: "host-failed",
      reason: "missing",
    });

    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("a sign-out reset clears an outstanding claim", async () => {
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);
    await appHostCredentialMintFlow({
      hostId: "host-reset",
      reason: "needs-reauth",
    });

    resetHostCredentialProvisioning();
    setHostCredentialMintRunner(runner);

    await appHostCredentialMintFlow({
      hostId: "host-reset",
      reason: "needs-reauth",
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
