/**
 * A hidden window re-reads the registry before its remote attach carries the
 * person's sign-in (`confirmRowWhenHidden`), through the app's real runtime
 * messenger against a fake released relay host: the host refuses the
 * host-only token the released way and admits the sign-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
} from "@traycer-clients/shared/auth/host-token-source";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
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
  factory: null as null | { create: () => unknown },
}));
vi.mock(
  "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory",
  () => ({
    createWhatwgStreamWebSocketFactory: () => ({
      create: () => {
        if (relayHolder.factory === null) throw new Error("no relay host");
        return relayHolder.factory.create();
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

interface Scenario {
  readonly relay: FakeRelayHost;
  readonly hostId: string;
  readonly setRow: (owner: RemoteHostDirectoryEntry["owner"]) => void;
}

/** One `host.echo` call to a remote row owned by the signed-in person, through the real runtime messenger. */
function startCall(
  confirm: () => Promise<boolean>,
  disposers: Array<() => void>,
): Scenario {
  hostCounter += 1;
  const hostId = `hidden-row-confirm-${hostCounter}`;
  const relay = new FakeRelayHost();
  releasedHost(relay);
  relayHolder.factory = relay.factory;
  let row: RemoteHostDirectoryEntry = {
    ...remoteEntry(hostId, null),
    version: "9.9.9",
    publicKey: hex(relay.hostStaticPublicKey),
    owner: { kind: "user", id: USER_ID },
    remoteStatus: {
      ...remoteEntry(hostId, null).remoteStatus,
      appVersion: "9.9.9",
    },
  };
  const binding = buildRuntimeHostMessenger({
    registry,
    resolveTarget: (id) => (id === hostId ? row : null),
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
          endpoint: { hostId, websocketUrl: row.websocketUrl ?? "" },
          bearer: new MutableBearerLease(SIGN_IN, USER_ID),
          abortSignal: new AbortController().signal,
        },
      },
    )
    .catch(() => undefined);
  return {
    relay,
    hostId,
    setRow: (owner) => {
      row = { ...row, owner };
    },
  };
}

describe("a hidden window's remote sign-in", () => {
  const disposers: Array<() => void> = [];

  beforeEach(() => {
    processReleasedHosts.forgetAll();
    useAuthStore.setState({ status: "signed-in" });
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const dispose of disposers.splice(0)) dispose();
    retireAllRemoteSessions();
    __setBrowserDocumentHiddenForTests(false);
    __resetDocumentVisibilitySubscribersForTests();
    relayHolder.factory = null;
  });

  /** What a visible window's call opens with: the open this window had before the confirmation existed. */
  async function visibleBaseline(): Promise<{
    readonly bearers: readonly string[];
    readonly authz: readonly unknown[];
  }> {
    __setBrowserDocumentHiddenForTests(false);
    const refresh = vi.fn(() => Promise.resolve());
    const run = startCall(
      confirmRowWhenHidden(() => ({ refresh })),
      disposers,
    );
    await vi.waitFor(
      () => expect(run.relay.openBearers).toContain(SIGN_IN),
      WAIT,
    );
    const baseline = {
      bearers: [...run.relay.openBearers],
      authz: [...run.relay.openAuthz],
    };
    disposers.splice(0).forEach((dispose) => dispose());
    retireAllRemoteSessions();
    processReleasedHosts.forgetAll();
    return baseline;
  }

  it("opens with no sign-in when the computer moved to a team and the registry read committed", async () => {
    __setBrowserDocumentHiddenForTests(true);
    let scenario: Scenario | null = null;
    const refresh = vi.fn(() => {
      scenario?.setRow({ kind: "team", id: "team-1", name: "Team" });
      return Promise.resolve();
    });
    scenario = startCall(
      confirmRowWhenHidden(() => ({ refresh })),
      disposers,
    );
    const run = scenario;

    // The second open is the one the sign-in would ride: the host-only token
    // is written again, with the grant, once the read has moved the row.
    await vi.waitFor(() => expect(run.relay.openBearers).toHaveLength(2), WAIT);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(run.relay.openBearers).toEqual(["", ""]);
    expect(run.relay.openAuthz.every((authz) => authz !== null)).toBe(true);
  });

  it.each([
    {
      name: "fails",
      refresh: () => Promise.reject(new Error("registry unreachable")),
      pastCeiling: false,
    },
    {
      name: "passes the ceiling",
      refresh: () => new Promise<void>(() => undefined),
      pastCeiling: true,
    },
  ])(
    "opens exactly as a visible window does when the registry read $name, and tells the door nothing",
    async ({ refresh: read, pastCeiling }) => {
      const baseline = await visibleBaseline();
      __setBrowserDocumentHiddenForTests(true);
      if (pastCeiling) vi.useFakeTimers({ shouldAdvanceTime: true });
      const refresh = vi.fn(read);
      const run = startCall(
        confirmRowWhenHidden(() => ({ refresh })),
        disposers,
      );

      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1), WAIT);
      if (pastCeiling) {
        // The attach is still waiting on the read: only the host-only token's
        // open has been written.
        expect(run.relay.openBearers).toEqual([""]);
        await vi.advanceTimersByTimeAsync(ROW_CONFIRM_CEILING_MS);
      }
      await vi.waitFor(
        () => expect(run.relay.openBearers).toContain(SIGN_IN),
        WAIT,
      );

      expect([...run.relay.openBearers]).toEqual([...baseline.bearers]);
      expect([...run.relay.openAuthz]).toEqual([...baseline.authz]);
      expect(hostDoorStateFor(run.hostId)).toBeNull();
    },
    20_000,
  );

  it("does not read the registry in a visible window", async () => {
    __setBrowserDocumentHiddenForTests(false);
    const refresh = vi.fn(() => Promise.resolve());
    const run = startCall(
      confirmRowWhenHidden(() => ({ refresh })),
      disposers,
    );

    await vi.waitFor(
      () => expect(run.relay.openBearers).toContain(SIGN_IN),
      WAIT,
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
