import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  DefaultRequestContextProvider,
  type AuthEra,
} from "../../auth/request-context-provider";
import type {
  HostQueryInvalidationOptions,
  IHostQueryInvalidator,
} from "../host-client";
import type { HostDirectoryEntry } from "../host-directory";
import { HostRuntime, type IHostDirectoryService } from "../host-runtime";
import { CredentialLeaseReleasedError } from "@traycer/protocol/auth/request-context";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "../mock/mock-host-directory";
import { MockHostMessenger } from "../mock/mock-host-messenger";
import { MockRunnerHost } from "../mock/mock-runner-host";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type { RpcSchedulingPolicy } from "../rpc-scheduling-policy";

const pingV10 = defineRpcContract({
  method: "host.ping",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ pong: z.literal(true) }),
});

const registry = defineVersionedRpcRegistry({
  "host.ping": {
    1: {
      latestMinor: 0,
      versions: { 0: { contract: pingV10, upgradeFromPreviousVersion: null } },
      downgradePathsFromLatest: {},
    },
  },
});

const schedulingPolicy: RpcSchedulingPolicy<typeof registry> = {
  modeFor: () => "latest",
  joinResponseTimeoutMs: () => null,
};

class RecordingInvalidator implements IHostQueryInvalidator {
  readonly calls: Array<string | null> = [];
  readonly options: HostQueryInvalidationOptions[] = [];
  invalidateHostScope(
    hostId: string | null,
    options: HostQueryInvalidationOptions,
  ): void {
    this.calls.push(hostId);
    this.options.push(options);
  }
}

const accountAHostEntry: HostDirectoryEntry = {
  hostId: "account-a-host",
  label: "Account A Host",
  kind: "remote",
  websocketUrl: "wss://account-a.traycer.invalid/rpc",
  version: "0.0.0-mock",
  transportDialability: "dialable",
};

const accountBHostEntry: HostDirectoryEntry = {
  hostId: "account-b-host",
  label: "Account B Host",
  kind: "remote",
  websocketUrl: "wss://account-b.traycer.invalid/rpc",
  version: "0.0.0-mock",
  transportDialability: "dialable",
};

class FakeDirectoryService implements IHostDirectoryService {
  entries: HostDirectoryEntry[] = [];
  /**
   * Every call that triggers a fetch, through either `refresh()` or `refreshForEra(...)` - the two are one cadence from a caller's point of view, just keyed differently.
   */
  readonly refreshCalls = { count: 0 };
  /** Every era `refreshForEra(...)` was actually called with, in order - what
   */
  readonly refreshForEraCalls: AuthEra[] = [];
  readonly invalidateInFlightRefreshCalls = { count: 0 };
  /**
   * Per-identity host sets a "fetch" resolves to, keyed by auth context id (`null` for signed-out).
   * Lets `refreshForEra`/`refresh` model a real commit instead of a no-op counter: a call stamped with the wrong identity is then observable as the wrong hosts landing in `entries`, not just as a count.
   */
  readonly hostsByIdentity = new Map<string | null, HostDirectoryEntry[]>();
  /** Stands in for the ambient accessors `HostDirectoryService.refresh()` reads in production. */
  laggedIdentity: string | null = null;
  async list(): Promise<readonly HostDirectoryEntry[]> {
    return this.entries;
  }

  findById(hostId: string): HostDirectoryEntry | null {
    return this.entries.find((e) => e.hostId === hostId) ?? null;
  }

  /**
   * The ambient path, and the one the context-change handler must not use.
   * Kept modelled rather than stubbed so a regression back to calling it from that handler is detectable: it commits under `laggedIdentity`, not under whatever identity the emission actually named.
   */
  async refresh(): Promise<readonly HostDirectoryEntry[]> {
    this.refreshCalls.count += 1;
    return this.commitForIdentity(this.laggedIdentity);
  }

  async refreshForEra(era: AuthEra): Promise<readonly HostDirectoryEntry[]> {
    this.refreshCalls.count += 1;
    this.refreshForEraCalls.push(era);
    return this.commitForIdentity(era.identity);
  }

  invalidateInFlightRefresh(): void {
    this.invalidateInFlightRefreshCalls.count += 1;
  }

  private commitForIdentity(
    authContextId: string | null,
  ): readonly HostDirectoryEntry[] {
    const hosts = this.hostsByIdentity.get(authContextId);
    if (hosts !== undefined) {
      this.entries = [...hosts];
    }
    return this.entries;
  }
}

function buildRuntime(options: {
  readonly initialSignedIn: { userId: string; bearer: string } | null;
}): {
  runtime: HostRuntime<typeof registry>;
  provider: DefaultRequestContextProvider;
  directory: FakeDirectoryService;
  invalidator: RecordingInvalidator;
  runnerHost: MockRunnerHost;
} {
  const provider = new DefaultRequestContextProvider({ origin: "renderer" });
  if (options.initialSignedIn !== null) {
    provider.setSignedIn({
      user: makeAuthenticatedUser(options.initialSignedIn.userId),
      bearerToken: options.initialSignedIn.bearer,
      operationId: undefined,
      externalAbortSignal: undefined,
    });
  }
  const directory = new FakeDirectoryService();
  directory.entries = [mockLocalHostEntry, mockRemoteHostEntry];
  const invalidator = new RecordingInvalidator();
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: directory.entries,
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const messenger = new MockHostMessenger<typeof registry>({
    registry,
    handlers: { "host.ping": () => ({ pong: true }) },
    requestId: () => "req-1",
  });
  const runtime = new HostRuntime({
    runnerHost,
    registry,
    messenger,
    requestContextProvider: provider,
    directory,
    invalidator,
    schedulingPolicy,
    requestCoordinator: null,
    // No registry in this harness: these cases drive the runtime's auth and
    // directory lifecycle in isolation, and none of them resolves a client.
    connectionRegistry: null,
  });
  return { runtime, provider, directory, invalidator, runnerHost };
}

function signInProvider(
  provider: DefaultRequestContextProvider,
  userId: string,
  bearer: string,
): void {
  provider.setSignedIn({
    user: makeAuthenticatedUser(userId),
    bearerToken: bearer,
    operationId: undefined,
    externalAbortSignal: undefined,
  });
}

function makeAuthenticatedUser(userId: string): AuthenticatedUser {
  const fixture = createAuthenticatedUserFixture(undefined);
  return {
    ...fixture,
    user: {
      ...fixture.user,
      id: userId,
      providerId: `prov-${userId}`,
      providerHandle: userId,
      email: `${userId}@example.com`,
    },
  };
}

describe("HostRuntime lifecycle", () => {
  it("applies the initial RequestContext and selected host on start()", () => {
    const { runtime, invalidator } = buildRuntime({
      initialSignedIn: { userId: "user-1", bearer: "tok-1" },
    });

    runtime.start();

    expect(runtime.hostClient.getRequestContext()?.identity.userId).toBe(
      "user-1",
    );
    expect(
      runtime.hostClient.getRequestContext()?.credentials.getBearerToken(),
    ).toBe("tok-1");
    // The context application is an identity transition and still sweeps, scope-free.
    expect(invalidator.calls).toEqual([null]);
  });

  it("invalidates and rebinds context when the provider emits a new identity", () => {
    const { runtime, provider, invalidator } = buildRuntime({
      initialSignedIn: null,
    });

    runtime.start();
    invalidator.calls.length = 0;

    signInProvider(provider, "user-1", "tok-1");

    expect(runtime.hostClient.getRequestContext()?.identity.userId).toBe(
      "user-1",
    );
    // Scope-free since P4.2: credentials are not per-host, so an identity
    // transition invalidates every host this window addresses.
    expect(invalidator.calls).toEqual([null]);
  });

  it("refreshes the directory immediately when the provider emits a new identity", () => {
    vi.useFakeTimers();
    try {
      const { runtime, provider, directory } = buildRuntime({
        initialSignedIn: null,
      });

      runtime.start();
      const baseline = directory.refreshCalls.count;

      signInProvider(provider, "user-1", "tok-1");

      expect(directory.refreshCalls.count).toBe(baseline + 1);
      vi.advanceTimersByTime(14_999);
      expect(directory.refreshCalls.count).toBe(baseline + 1);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits null context and invalidates the host scope on sign-out", () => {
    const { runtime, provider, invalidator, directory } = buildRuntime({
      initialSignedIn: { userId: "user-1", bearer: "tok-1" },
    });

    runtime.start();
    invalidator.calls.length = 0;
    const refreshBaseline = directory.refreshCalls.count;

    provider.signOut();

    expect(runtime.hostClient.getRequestContext()).toBeNull();
    // Scope-free since P4.2: credentials are not per-host, so an identity
    // transition invalidates every host this window addresses.
    expect(invalidator.calls).toEqual([null]);
    expect(directory.refreshCalls.count).toBe(refreshBaseline + 1);
  });

  it("preserves the host-scoped cache across same-user credential rotation (silent on the provider)", () => {
    const { runtime, provider, invalidator, directory } = buildRuntime({
      initialSignedIn: { userId: "user-1", bearer: "tok-1" },
    });

    runtime.start();
    invalidator.calls.length = 0;
    const invalidateInFlightBaseline =
      directory.invalidateInFlightRefreshCalls.count;

    const ctxBefore = runtime.hostClient.getRequestContext();
    expect(ctxBefore).not.toBeNull();

    provider.rotateCurrentBearer({ userId: "user-1", bearerToken: "tok-2" });

    const ctxAfter = runtime.hostClient.getRequestContext();
    expect(ctxAfter).toBe(ctxBefore);
    expect(ctxAfter?.credentials.getBearerToken()).toBe("tok-2");
    // Same-user rotation does NOT emit through the provider, so the
    // host-scoped cache is preserved across token refreshes.
    expect(invalidator.calls).toEqual([]);
    // The in-flight memo IS dropped, though: a promise the old bearer started must not be joined by a caller under the new one (see `HostDirectoryService.invalidateInFlightRefresh`).
    expect(directory.invalidateInFlightRefreshCalls.count).toBe(
      invalidateInFlightBaseline + 1,
    );
  });

  it("aborts the previous context and invalidates on cross-user transition", () => {
    const { runtime, provider, invalidator, directory } = buildRuntime({
      initialSignedIn: { userId: "user-1", bearer: "tok-1" },
    });

    runtime.start();
    invalidator.calls.length = 0;
    const refreshBaseline = directory.refreshCalls.count;

    const ctxA = runtime.hostClient.getRequestContext();
    if (ctxA === null) {
      throw new Error("expected initial runtime request context");
    }
    expect(ctxA.identity.userId).toBe("user-1");

    signInProvider(provider, "user-2", "tok-2");

    expect(ctxA.isAborted).toBe(true);
    expect(() => ctxA.credentials.getBearerToken()).toThrow(
      CredentialLeaseReleasedError,
    );
    expect(runtime.hostClient.getRequestContext()?.identity.userId).toBe(
      "user-2",
    );
    // Scope-free since P4.2: credentials are not per-host, so an identity
    // transition invalidates every host this window addresses.
    expect(invalidator.calls).toEqual([null]);
    expect(directory.refreshCalls.count).toBe(refreshBaseline + 1);
  });

  // Deleted: "rebinds the host client when directory selection changes".
  // What replaced the behaviour is not a rebind: consumers resolve `effectiveHostId` through the registry per request, which the gui-app selection-authority suites cover.

  it("refreshes the directory on local-host transitions from runnerHost", () => {
    const { runtime, directory, runnerHost } = buildRuntime({
      initialSignedIn: null,
    });

    runtime.start();
    const baseline = directory.refreshCalls.count;

    runnerHost.setLocalHost({
      hostId: "local-1",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-mock",
      pid: 123,
      systemHostName: "local-1",
      displayName: "local-1",
      availability: "available",
    });

    expect(directory.refreshCalls.count).toBe(baseline + 1);
  });

  it("releases all subscriptions on dispose()", () => {
    const { runtime, provider, directory, runnerHost } = buildRuntime({
      initialSignedIn: null,
    });

    runtime.start();
    runtime.dispose();

    // Two probes, not three.
    const setContextSpy = vi.spyOn(runtime.hostClient, "setRequestContext");
    const refreshBaseline = directory.refreshCalls.count;

    signInProvider(provider, "user-after-dispose", "tok-after-dispose");
    runnerHost.setLocalHost({
      hostId: "local-after-dispose",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-mock",
      pid: 999,
      systemHostName: "local-after-dispose",
      displayName: "local-after-dispose",
      availability: "available",
    });

    expect(setContextSpy).not.toHaveBeenCalled();
    expect(directory.refreshCalls.count).toBe(refreshBaseline);
  });

  it("is idempotent across repeat start() calls and refuses start() after dispose()", () => {
    const { runtime } = buildRuntime({
      initialSignedIn: null,
    });

    runtime.start();
    runtime.start();
    runtime.dispose();
    runtime.dispose();

    expect(() => runtime.start()).toThrow(/cannot be started after dispose/i);
  });
});

describe("HostRuntime context-change refresh is stamped with the era the emission is FOR", () => {
  // Both probes model the real defect: an ambient accessor read from inside an emission can still describe the transition that is being replaced.
  // The runtime must call `refreshForEra` with the era `onChange` itself carried, not read the lagged accessor.

  it("switching identity mid-session must not let B's directory retain A's hosts, even while the lagged profile accessor still reads A", () => {
    const { runtime, provider, directory } = buildRuntime({
      initialSignedIn: { userId: "account-a", bearer: "tok-a" },
    });
    directory.hostsByIdentity.set("account-a", [accountAHostEntry]);
    directory.hostsByIdentity.set("account-b", [accountBHostEntry]);
    directory.laggedIdentity = "account-a";

    runtime.start();
    // Represents "A's hosts are already loaded", the state a prior mandatory refresh under A would have produced.
    directory.entries = [accountAHostEntry];
    const refreshBaseline = directory.refreshCalls.count;

    signInProvider(provider, "account-b", "tok-b");

    // The runtime must have called `refreshForEra` with the era `onChange` itself carried - not `refresh()`, which would have read the still-stale `laggedIdentity` ("account-a") and re-committed A's hosts into B's directory.
    expect(directory.refreshForEraCalls.map((era) => era.identity)).toEqual([
      "account-b",
    ]);
    // ...and the era carries the generation of the credential that transition committed, so the same value fences the fetch and the commit.
    expect(
      directory.refreshForEraCalls.map((era) => era.credentialGeneration),
    ).toEqual([provider.getCredentialGeneration()]);
    expect(directory.refreshCalls.count).toBe(refreshBaseline + 1);
    expect(directory.entries.map((entry) => entry.hostId)).toEqual([
      accountBHostEntry.hostId,
    ]);
  });

  it("signing out must clear the directory, not leave A resident, even while the lagged profile accessor still reads A", () => {
    const { runtime, provider, directory } = buildRuntime({
      initialSignedIn: { userId: "account-a", bearer: "tok-a" },
    });
    directory.hostsByIdentity.set("account-a", [accountAHostEntry]);
    directory.hostsByIdentity.set(null, []);
    directory.laggedIdentity = "account-a";

    runtime.start();
    directory.entries = [accountAHostEntry];

    provider.signOut();

    // `null` IS the incoming identity on sign-out - stamping the refresh with it (rather than the lagged "account-a") is what lets the clearing commit land instead of being discarded by its own identity guard.
    expect(directory.refreshForEraCalls.map((era) => era.identity)).toEqual([
      null,
    ]);
    expect(directory.entries).toEqual([]);
  });
});
