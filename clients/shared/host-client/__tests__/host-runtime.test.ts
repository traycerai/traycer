import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { Disposable } from "../../platform/uri-callback";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { DefaultRequestContextProvider } from "../../auth/request-context-provider";
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

class FakeDirectoryService implements IHostDirectoryService {
  entries: HostDirectoryEntry[] = [];
  selected: HostDirectoryEntry | null = null;
  readonly refreshCalls = { count: 0 };
  private readonly handlers = new Set<
    (entry: HostDirectoryEntry | null) => void
  >();

  async list(): Promise<readonly HostDirectoryEntry[]> {
    return this.entries;
  }

  findById(hostId: string): HostDirectoryEntry | null {
    return this.entries.find((e) => e.hostId === hostId) ?? null;
  }

  async refresh(): Promise<readonly HostDirectoryEntry[]> {
    this.refreshCalls.count += 1;
    return this.entries;
  }

  getSelected(): HostDirectoryEntry | null {
    return this.selected;
  }

  selectById(hostId: string | null): void {
    const entry = hostId === null ? null : this.findById(hostId);
    this.setSelected(entry);
  }

  setSelected(entry: HostDirectoryEntry | null): void {
    this.selected = entry;
    for (const handler of this.handlers) {
      handler(entry);
    }
  }

  onSelectionChange(
    handler: (entry: HostDirectoryEntry | null) => void,
  ): Disposable {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }
}

function buildRuntime(options: {
  readonly initialSignedIn: { userId: string; bearer: string } | null;
  readonly initialSelected: HostDirectoryEntry | null;
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
  directory.selected = options.initialSelected;
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
      initialSelected: mockLocalHostEntry,
    });

    runtime.start();

    expect(runtime.hostClient.getRequestContext()?.identity.userId).toBe(
      "user-1",
    );
    expect(
      runtime.hostClient.getRequestContext()?.credentials.getBearerToken(),
    ).toBe("tok-1");
    expect(runtime.hostClient.getActiveHostId()).toBe("mock-local");
    // bind() invalidates previous(null) + next(mock-local) on selection
    // change; the initial setRequestContext also invalidates the host
    // scope (mock-local) on the auth-changed event.
    expect(invalidator.calls).toContain("mock-local");
  });

  it("invalidates and rebinds context when the provider emits a new identity", () => {
    const { runtime, provider, invalidator } = buildRuntime({
      initialSignedIn: null,
      initialSelected: mockLocalHostEntry,
    });

    runtime.start();
    invalidator.calls.length = 0;

    signInProvider(provider, "user-1", "tok-1");

    expect(runtime.hostClient.getRequestContext()?.identity.userId).toBe(
      "user-1",
    );
    expect(invalidator.calls).toEqual(["mock-local"]);
  });

  it("refreshes the directory immediately when the provider emits a new identity", () => {
    vi.useFakeTimers();
    try {
      const { runtime, provider, directory } = buildRuntime({
        initialSignedIn: null,
        initialSelected: mockLocalHostEntry,
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
      initialSelected: mockLocalHostEntry,
    });

    runtime.start();
    invalidator.calls.length = 0;
    const refreshBaseline = directory.refreshCalls.count;

    provider.signOut();

    expect(runtime.hostClient.getRequestContext()).toBeNull();
    expect(invalidator.calls).toEqual(["mock-local"]);
    expect(directory.refreshCalls.count).toBe(refreshBaseline + 1);
  });

  it("preserves the host-scoped cache across same-user credential rotation (silent on the provider)", () => {
    const { runtime, provider, invalidator } = buildRuntime({
      initialSignedIn: { userId: "user-1", bearer: "tok-1" },
      initialSelected: mockLocalHostEntry,
    });

    runtime.start();
    invalidator.calls.length = 0;

    const ctxBefore = runtime.hostClient.getRequestContext();
    expect(ctxBefore).not.toBeNull();

    provider.rotateCurrentBearer({ userId: "user-1", bearerToken: "tok-2" });

    const ctxAfter = runtime.hostClient.getRequestContext();
    expect(ctxAfter).toBe(ctxBefore);
    expect(ctxAfter?.credentials.getBearerToken()).toBe("tok-2");
    // Same-user rotation does NOT emit through the provider, so the
    // host-scoped cache is preserved across token refreshes.
    expect(invalidator.calls).toEqual([]);
  });

  it("aborts the previous context and invalidates on cross-user transition", () => {
    const { runtime, provider, invalidator, directory } = buildRuntime({
      initialSignedIn: { userId: "user-1", bearer: "tok-1" },
      initialSelected: mockLocalHostEntry,
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
    expect(invalidator.calls).toEqual(["mock-local"]);
    expect(directory.refreshCalls.count).toBe(refreshBaseline + 1);
  });

  it("rebinds the host client when directory selection changes", () => {
    const { runtime, directory } = buildRuntime({
      initialSignedIn: null,
      initialSelected: mockLocalHostEntry,
    });

    runtime.start();

    directory.setSelected(mockRemoteHostEntry);
    expect(runtime.hostClient.getActiveHostId()).toBe("mock-remote");

    directory.setSelected(null);
    expect(runtime.hostClient.getActiveHostId()).toBe(null);
  });

  it("refreshes the directory on local-host transitions from runnerHost", () => {
    const { runtime, directory, runnerHost } = buildRuntime({
      initialSignedIn: null,
      initialSelected: null,
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
    });

    expect(directory.refreshCalls.count).toBe(baseline + 1);
  });

  it("releases all subscriptions on dispose()", () => {
    const { runtime, provider, directory, runnerHost } = buildRuntime({
      initialSignedIn: null,
      initialSelected: null,
    });

    runtime.start();
    runtime.dispose();

    const setContextSpy = vi.spyOn(runtime.hostClient, "setRequestContext");
    const bindSpy = vi.spyOn(runtime.hostClient, "bind");
    const refreshBaseline = directory.refreshCalls.count;

    signInProvider(provider, "user-after-dispose", "tok-after-dispose");
    directory.setSelected(mockLocalHostEntry);
    runnerHost.setLocalHost({
      hostId: "local-after-dispose",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-mock",
      pid: 999,
      systemHostName: "local-after-dispose",
      displayName: "local-after-dispose",
    });

    expect(setContextSpy).not.toHaveBeenCalled();
    expect(bindSpy).not.toHaveBeenCalled();
    expect(directory.refreshCalls.count).toBe(refreshBaseline);
  });

  it("is idempotent across repeat start() calls and refuses start() after dispose()", () => {
    const { runtime } = buildRuntime({
      initialSignedIn: null,
      initialSelected: null,
    });

    runtime.start();
    runtime.start();
    runtime.dispose();
    runtime.dispose();

    expect(() => runtime.start()).toThrow(/cannot be started after dispose/i);
  });
});
