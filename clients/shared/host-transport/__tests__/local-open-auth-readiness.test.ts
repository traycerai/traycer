import { describe, expect, it, vi } from "vitest";
import {
  MutableBearerLease,
  type OpenFrameBearerSource,
} from "../../auth/bearer-source";
import type { HostTransportEndpoint } from "../host-messenger";
import { LocalOpenAuth } from "../local-open-auth";

const endpoint: HostTransportEndpoint = {
  hostId: "local-team-computer",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function makeAuth(
  provisionMember: NonNullable<
    ConstructorParameters<typeof LocalOpenAuth>[0]["provisionMember"]
  >,
): LocalOpenAuth {
  return new LocalOpenAuth({
    provisionMember,
    mintSessionGrant: async () => ({ kind: "unavailable" }),
  });
}

describe("LocalOpenAuth member readiness barrier", () => {
  it("shares one provisioning attempt and keeps it alive while any waiter remains", async () => {
    const pending = deferred<{ readonly kind: "ready" }>();
    const sourceSignals: AbortSignal[] = [];
    const provisionMember = vi.fn(
      (
        _endpoint: HostTransportEndpoint,
        _bearer: OpenFrameBearerSource,
        signal: AbortSignal,
      ) => {
        sourceSignals.push(signal);
        return pending.promise;
      },
    );
    const auth = makeAuth(provisionMember);
    const bearer = new MutableBearerLease("user-bearer", "member-a");
    const abortedWaiter = new AbortController();
    const survivingWaiter = new AbortController();

    const first = auth.ensureMemberReady(
      endpoint,
      bearer,
      abortedWaiter.signal,
    );
    const second = auth.ensureMemberReady(
      endpoint,
      bearer,
      survivingWaiter.signal,
    );
    expect(provisionMember).toHaveBeenCalledTimes(1);
    abortedWaiter.abort();
    await expect(first).rejects.toBeDefined();
    expect(sourceSignals[0].aborted).toBe(false);

    pending.resolve({ kind: "ready" });
    await expect(second).resolves.toEqual({ kind: "ready" });
    expect(sourceSignals[0].aborted).toBe(true);
  });

  it("aborts the source when every waiter leaves and reprobes on a fresh connection", async () => {
    const attempts: Array<{
      readonly signal: AbortSignal;
      readonly result: Deferred<{ readonly kind: "ready" }>;
    }> = [];
    const provisionMember = vi.fn(
      (
        _endpoint: HostTransportEndpoint,
        _bearer: OpenFrameBearerSource,
        signal: AbortSignal,
      ) => {
        const result = deferred<{ readonly kind: "ready" }>();
        attempts.push({ signal, result });
        return result.promise;
      },
    );
    const auth = makeAuth(provisionMember);
    const bearer = new MutableBearerLease("user-bearer", "member-a");
    const firstWaiter = new AbortController();

    const first = auth.ensureMemberReady(endpoint, bearer, firstWaiter.signal);
    firstWaiter.abort();
    await expect(first).rejects.toBeDefined();
    expect(attempts[0].signal.aborted).toBe(true);

    const second = auth.ensureMemberReady(
      endpoint,
      bearer,
      new AbortController().signal,
    );
    expect(provisionMember).toHaveBeenCalledTimes(2);
    attempts[1].result.resolve({ kind: "ready" });
    await expect(second).resolves.toEqual({ kind: "ready" });
  });

  it("does not cache successful readiness for the next fresh member connection", async () => {
    const provisionMember = vi.fn(async () => ({ kind: "ready" as const }));
    const auth = makeAuth(provisionMember);
    const bearer = new MutableBearerLease("user-bearer", "member-a");

    await expect(
      auth.ensureMemberReady(endpoint, bearer, new AbortController().signal),
    ).resolves.toEqual({ kind: "ready" });
    await expect(
      auth.ensureMemberReady(endpoint, bearer, new AbortController().signal),
    ).resolves.toEqual({ kind: "ready" });

    expect(provisionMember).toHaveBeenCalledTimes(2);
  });

  it("clears a cached membership refusal for the same bearer after host invalidation", async () => {
    const provisionMember = vi.fn(async () => ({ kind: "ready" as const }));
    const auth = makeAuth(provisionMember);
    const bearer = new MutableBearerLease("user-bearer", "member-a");
    const refusal = {
      code: "TEAM_MEMBERSHIP_REQUIRED",
      reason: "membership required",
      incompatibleMethods: null,
      upgradeGuidance: null,
    } as const;
    auth.noteRefusal(endpoint.hostId, bearer, refusal);

    await expect(
      auth.ensureMemberReady(endpoint, bearer, new AbortController().signal),
    ).resolves.toEqual({ kind: "refused", fatal: refusal });
    expect(provisionMember).not.toHaveBeenCalled();

    auth.invalidateHost(endpoint.hostId, null);

    await expect(
      auth.ensureMemberReady(endpoint, bearer, new AbortController().signal),
    ).resolves.toEqual({ kind: "ready" });
    expect(provisionMember).toHaveBeenCalledTimes(1);
  });
});
