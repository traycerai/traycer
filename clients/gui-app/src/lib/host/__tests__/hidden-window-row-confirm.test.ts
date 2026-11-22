/**
 * A window whose registry view may be stale from being hidden reads the
 * registry again before its remote attach carries the person's sign-in
 * (`confirmRowWhenHidden`), through the real host directory service and the
 * app's real runtime messenger, against a fake released relay host: the host
 * refuses the host-only token the released way and admits the sign-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DialPriority } from "@traycer-clients/shared/host-transport/dial-priority";
import type { IStreamWebSocketFactory } from "@traycer/protocol/host-transport/stream-websocket";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
} from "@traycer-clients/shared/auth/host-token-source";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type {
  RemoteHostDirectoryEntry,
  RemoteHostFetchOutcome,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { RegisteredHostsChange } from "@traycer-clients/shared/platform/runner-host";
import { ROW_CONFIRM_CEILING_MS } from "@traycer-clients/shared/host-transport/row-confirmation";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { retireAllRemoteSessions } from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
import { FakeRelayHost } from "@traycer-clients/shared/host-transport/remote/__tests__/fake-relay-host";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/index";
import { SESSION_CAPABILITY_CREDENTIAL_UPDATE } from "@traycer/protocol/host-transport/mux";
import { buildRuntimeHostMessenger } from "@/lib/host/host-messenger";
import { confirmRowWhenHidden } from "@/lib/host/hidden-window-row-confirm";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import {
  __resetDocumentVisibilitySubscribersForTests,
  __setBrowserDocumentHiddenForTests,
} from "@/lib/dom/document-visibility";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  clearHostDoorState,
  hostDoorStateFor,
} from "@/stores/host/host-door-state-store";

// The relay's handshake runs on WebCrypto, so these cases run on real timers
// except the one that crosses the ceiling.

const relayHolder = vi.hoisted(() => ({
  factory: null as null | IStreamWebSocketFactory,
}));
vi.mock(
  "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory",
  () => ({
    createWhatwgStreamWebSocketFactory: () => ({
      create: (url: string, priority: DialPriority) => {
        if (relayHolder.factory === null) throw new Error("no relay host");
        return relayHolder.factory.create(url, priority);
      },
    }),
  }),
);

const mintedHostToken = vi.hoisted(() => "relay-minted-host-token");
vi.mock(
  "@traycer-clients/shared/host-transport/remote/grant-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/grant-client")
      >();
    return {
      ...actual,
      mintRelayPassWithHostTokenViaHttp: () =>
        Promise.resolve({
          kind: "ok" as const,
          grant: { grant: "grant-jws", expiresInSeconds: 300 },
          hostToken: {
            token: mintedHostToken,
            expiresAtMs: Date.now() + 3_600_000,
          },
        }),
    };
  },
);

const USER_ID = AUTHENTICATED_USER_FIXTURE_ID;
const SIGN_IN = "person-sign-in";
const WAIT = { timeout: 10_000, interval: 20 };
/** Captured before any test fakes the clock. */
const realSetTimeout = globalThis.setTimeout;

const echoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});
const registry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

function releasedRefusal(): FatalErrorDetails {
  return {
    code: "UNAUTHORIZED",
    reason: "released-host-token-refusal",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

/** A released host: it refuses the host-only token and admits the sign-in. */
function releasedHost(relay: FakeRelayHost): void {
  relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
  relay.decideOpen = (_grant, openIndex) =>
    relay.openAuthz[openIndex] === null
      ? { kind: "ack" }
      : { kind: "fatal", details: releasedRefusal() };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

let hostCounter = 0;

function personalRow(
  hostId: string,
  relay: FakeRelayHost,
  owner: RemoteHostDirectoryEntry["owner"],
): RemoteHostDirectoryEntry {
  return {
    ...remoteEntry(hostId, null),
    version: "9.9.9",
    publicKey: hex(relay.hostStaticPublicKey),
    owner,
    remoteStatus: {
      ...remoteEntry(hostId, null).remoteStatus,
      appVersion: "9.9.9",
    },
  };
}

/** One `host.echo` call to `hostId`, through the real runtime messenger, reading its row from `resolveTarget`. */
function callThroughMessenger(input: {
  readonly hostId: string;
  readonly resolveTarget: (hostId: string) => RemoteHostDirectoryEntry | null;
  readonly confirm: () => Promise<unknown>;
  readonly disposers: Array<() => void>;
}): void {
  const { hostId, resolveTarget, confirm, disposers } = input;
  const binding = buildRuntimeHostMessenger({
    registry,
    resolveTarget,
    confirmRowBeforeSignIn: confirm,
    auth: null,
    authnBaseUrl: "https://authn.test",
    hostTokens: createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => Date.now(),
    }),
    requestId: () => "req-1",
    onRemoteAvailabilityRecovered: () => undefined,
    onRemoteSessionTerminal: () => undefined,
  });
  disposers.push(() => {
    binding.dispose();
    clearHostDoorState(hostId);
  });
  void binding.messenger
    .request(
      "host.echo",
      { message: "hi" },
      {
        idempotencyKey: null,
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        authority: {
          endpoint: {
            hostId,
            websocketUrl: resolveTarget(hostId)?.websocketUrl ?? "",
          },
          bearer: new MutableBearerLease(SIGN_IN, USER_ID),
          abortSignal: new AbortController().signal,
        },
      },
    )
    .catch(() => undefined);
}

describe("a window's remote sign-in with the real host directory", () => {
  const disposers: Array<() => void> = [];
  const TEAM = { kind: "team", id: "team-1", name: "Team" } as const;

  beforeEach(() => {
    processReleasedHosts.forgetAll();
    useAuthStore.setState({ status: "signed-in" });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    vi.useRealTimers();
    retireAllRemoteSessions();
    __setBrowserDocumentHiddenForTests(false);
    __resetDocumentVisibilitySubscribersForTests();
    relayHolder.factory = null;
  });

  /**
   * The real directory service riding the shell's registry pushes, with the
   * registry read the test controls: the first read (at start) lists the
   * person's own computer; each later read waits for `answerRead`.
   */
  async function startWithDirectory(mode: "push" | "poll"): Promise<{
    readonly relay: FakeRelayHost;
    readonly hostId: string;
    readonly directory: HostDirectoryService;
    readonly push: () => void;
    readonly reads: () => number;
    readonly answerRead: (outcome: RemoteHostFetchOutcome) => void;
    readonly rowOwnedBy: (
      owner: RemoteHostDirectoryEntry["owner"],
    ) => RemoteHostDirectoryEntry;
    readonly call: (confirm: () => Promise<unknown>) => void;
  }> {
    hostCounter += 1;
    const hostId = `hidden-row-confirm-directory-${hostCounter}`;
    const relay = new FakeRelayHost();
    releasedHost(relay);
    relayHolder.factory = relay.factory;
    const rowOwnedBy = (owner: RemoteHostDirectoryEntry["owner"]) =>
      personalRow(hostId, relay, owner);
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    const handlers = new Set<(change: RegisteredHostsChange) => void>();
    // Without this override the mock shell has no registry push, and the
    // directory polls on its own interval instead.
    if (mode === "push")
      host.onRegisteredHostsChange = (handler) => {
        handlers.add(handler);
        return { dispose: () => handlers.delete(handler) };
      };
    const pending: Array<(outcome: RemoteHostFetchOutcome) => void> = [];
    let reads = 0;
    const directory = new HostDirectoryService({
      authContextId: () => USER_ID,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      onRegistryPollTick: null,
      remoteFetcher: () => {
        reads += 1;
        if (reads === 1)
          return Promise.resolve({
            kind: "hosts",
            entries: [rowOwnedBy({ kind: "user", id: USER_ID })],
          });
        return new Promise<RemoteHostFetchOutcome>((resolve) => {
          pending.push(resolve);
        });
      },
    });
    disposers.push(() => directory.dispose());
    await directory.start();
    expect(reads).toBe(1);
    return {
      relay,
      hostId,
      directory,
      push: () => {
        for (const handler of handlers)
          handler({ identityKey: USER_ID, response: { hosts: [] } });
      },
      reads: () => reads,
      answerRead: (outcome) => {
        const answer = pending.shift();
        if (answer === undefined) throw new Error("no registry read pending");
        answer(outcome);
      },
      rowOwnedBy,
      call: (confirm) => {
        callThroughMessenger({
          hostId,
          resolveTarget: (id) => {
            const row = directory.findById(id);
            return row === null || row.kind !== "remote" ? null : row;
          },
          confirm,
          disposers,
        });
      },
    };
  }

  /** The window was hidden when a push arrived: the directory skipped it. */
  function skipPushWhileHidden(setup: { readonly push: () => void }): void {
    __setBrowserDocumentHiddenForTests(true);
    setup.push();
  }

  /**
   * Past the redial's backoff on the fake clock, then a moment of real time for
   * the relay's asynchronous crypto, so an attach that did not wait has
   * written its open by the time a test looks. The fake clock alone does not
   * move a handshake. It stays under the confirmation's ceiling.
   */
  async function letRelayRun(): Promise<void> {
    await vi.advanceTimersByTimeAsync(2_000);
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 300);
    });
  }

  /** The window is visible, and `visibilitychange` has not reached the directory's listener yet. */
  function showWithoutNotifying(): void {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
  }

  it("waits for the read the listener started, and sends no sign-in once it commits a team row, though the window is visible again", async () => {
    const run = await startWithDirectory("push");
    skipPushWhileHidden(run);
    // The window shows: the listener acts on the skipped push, and its read is
    // still in flight when the attach begins.
    __setBrowserDocumentHiddenForTests(false);
    await vi.waitFor(() => expect(run.reads()).toBe(2), WAIT);
    run.call(confirmRowWhenHidden(() => run.directory));
    await vi.waitFor(() => expect(run.relay.openBearers).toHaveLength(1), WAIT);
    await letRelayRun();

    expect(run.relay.openBearers).toEqual([""]);
    expect(run.reads()).toBe(2);
    run.answerRead({ kind: "hosts", entries: [run.rowOwnedBy(TEAM)] });
    await vi.waitFor(() => expect(run.relay.openBearers).toHaveLength(2), WAIT);
    expect(run.relay.openBearers).toEqual(["", ""]);
  }, 20_000);

  it("starts the one read itself when the window is visible but the listener has not yet run, and waits for it", async () => {
    const run = await startWithDirectory("push");
    skipPushWhileHidden(run);
    // Visible, with the push still skipped and no read: the listener has not run.
    showWithoutNotifying();
    run.call(confirmRowWhenHidden(() => run.directory));
    await vi.waitFor(() => expect(run.reads()).toBe(2), WAIT);
    await letRelayRun();

    expect(run.relay.openBearers).toEqual([""]);
    run.answerRead({ kind: "hosts", entries: [run.rowOwnedBy(TEAM)] });
    await vi.waitFor(() => expect(run.relay.openBearers).toHaveLength(2), WAIT);
    expect(run.relay.openBearers).toEqual(["", ""]);
  }, 20_000);

  it("joins a read already running and starts no second one beside it", async () => {
    const run = await startWithDirectory("push");
    skipPushWhileHidden(run);
    const running = run.directory.refresh();
    await vi.waitFor(() => expect(run.reads()).toBe(2), WAIT);
    run.call(confirmRowWhenHidden(() => run.directory));
    await vi.waitFor(() => expect(run.relay.openBearers).toHaveLength(1), WAIT);
    await letRelayRun();

    expect(run.relay.openBearers).toEqual([""]);
    expect(run.reads()).toBe(2);
    run.answerRead({
      kind: "hosts",
      entries: [run.rowOwnedBy({ kind: "user", id: USER_ID })],
    });
    await running;
    await vi.waitFor(() => expect(run.relay.openBearers).toHaveLength(2), WAIT);
    expect(run.relay.openBearers).toEqual(["", SIGN_IN]);
    expect(run.reads()).toBe(2);
  }, 20_000);

  it("returns at once, reading nothing, in a visible window with no push skipped", async () => {
    const run = await startWithDirectory("push");
    run.call(confirmRowWhenHidden(() => run.directory));

    await vi.waitFor(() => expect(run.relay.openBearers).toHaveLength(2), WAIT);
    expect(run.relay.openBearers).toEqual(["", SIGN_IN]);
    expect(run.reads()).toBe(1);
  }, 20_000);

  it("waits for the show tick's read, in a window with no shell push, and sends no sign-in once it commits a team row", async () => {
    const run = await startWithDirectory("poll");
    // The hidden span skipped the poll ticks; showing the window fires one tick,
    // whose read is in flight when the attach begins.
    __setBrowserDocumentHiddenForTests(true);
    __setBrowserDocumentHiddenForTests(false);
    await vi.waitFor(() => expect(run.reads()).toBe(2), WAIT);
    run.call(confirmRowWhenHidden(() => run.directory));
    await vi.waitFor(() => expect(run.relay.openBearers).toHaveLength(1), WAIT);
    await letRelayRun();

    expect(run.relay.openBearers).toEqual([""]);
    expect(run.reads()).toBe(2);
    run.answerRead({ kind: "hosts", entries: [run.rowOwnedBy(TEAM)] });
    await vi.waitFor(() => expect(run.relay.openBearers).toHaveLength(2), WAIT);
    expect(run.relay.openBearers).toEqual(["", ""]);
  }, 20_000);

  it.each([
    { name: "fails", pastCeiling: false },
    { name: "does not answer within its ceiling", pastCeiling: true },
  ])(
    "keeps the row last confirmed, and sends the sign-in, when the read $name",
    async ({ pastCeiling }) => {
      const run = await startWithDirectory("push");
      skipPushWhileHidden(run);
      run.call(confirmRowWhenHidden(() => run.directory));
      await vi.waitFor(() => expect(run.reads()).toBe(2), WAIT);
      if (pastCeiling) {
        await vi.advanceTimersByTimeAsync(ROW_CONFIRM_CEILING_MS);
      } else {
        run.answerRead({ kind: "failed" });
      }

      await vi.waitFor(
        () => expect(run.relay.openBearers).toEqual(["", SIGN_IN]),
        WAIT,
      );
      expect(hostDoorStateFor(run.hostId)).toBeNull();
    },
    20_000,
  );
});
