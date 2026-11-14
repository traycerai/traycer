import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostListItem,
  HostOwnerPrincipal,
  HostRegistryKind,
} from "@traycer/protocol/host/host-status";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { OPEN_AUTHZ_SESSION_GRANT_VERSION } from "@traycer/protocol/host-transport/mux";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
} from "@traycer-clients/shared/auth/host-token-source";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { createRemoteHostTransport } from "../remote/create-remote-transport";
import { retireAllRemoteSessions } from "../remote/active-remote-sessions";
import { RemoteMuxTestPeer } from "./remote-mux-test-peer";

const USER_ID = "user-relay-open";
const SIGN_IN_TOKEN = "sign-in-relay-open";
const WAIT = { timeout: 10_000, interval: 50 } as const;
const RELAY_URL = "wss://relay.test/attach";

interface RelayHostCase {
  readonly name: string;
  readonly hostId: string;
  readonly kind: HostRegistryKind;
  readonly owner: HostOwnerPrincipal;
}

const RELAY_HOST_CASES: readonly RelayHostCase[] = [
  {
    name: "personal computer",
    hostId: "relay-personal-computer",
    kind: "personal",
    owner: { kind: "user", id: USER_ID },
  },
  {
    name: "personal sandbox",
    hostId: "relay-personal-sandbox",
    kind: "sandbox",
    owner: { kind: "user", id: USER_ID },
  },
  {
    name: "team computer",
    hostId: "relay-team-computer",
    kind: "machine",
    owner: { kind: "team", id: "team-a", name: "Alpha" },
  },
  {
    name: "team sandbox",
    hostId: "relay-team-sandbox",
    kind: "sandbox",
    owner: { kind: "team", id: "team-a", name: "Alpha" },
  },
];

function directoryEntryFor(testCase: RelayHostCase, peer: RemoteMuxTestPeer) {
  const item: HostListItem = {
    hostId: testCase.hostId,
    displayName: testCase.name,
    platform: "macOS",
    kind: testCase.kind,
    publicKey: peer.hostPublicKey,
    createdAt: "2026-11-14T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.0.0",
      lastSeenAt: null,
    },
    updatePolicy: "manual",
    owner: testCase.owner,
    ...(testCase.kind === "sandbox"
      ? {
          sandboxState: "awake" as const,
          sandboxFrozen: false,
          profile: "agent" as const,
        }
      : {}),
  };
  return hostListItemToDirectoryEntry(item, RELAY_URL);
}

describe("remote RPC relay OPEN host-token frame", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    retireAllRemoteSessions();
  });

  it.each(RELAY_HOST_CASES)(
    "opens a $name with authz v2 and no sign-in token",
    async (testCase) => {
      const peer = new RemoteMuxTestPeer();
      const entry = directoryEntryFor(testCase, peer);
      const hostToken = `host-token-${entry.hostId}`;
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              grant: "relay-pass",
              role: "client",
              expires_in: 300,
              session_grant: hostToken,
              session_grant_expires_in: 300,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const hostTokens = createHostTokenSource({
        persistence: createMemoryHostTokenPersistence(),
        mint: () => Promise.resolve({ kind: "no-sign-in" }),
        signIn: null,
        now: () => Date.now(),
      });
      const bearer = () => new MutableBearerLease(SIGN_IN_TOKEN, USER_ID);
      const transport = createRemoteHostTransport({
        hostId: entry.hostId,
        userId: USER_ID,
        relayAttachUrl: entry.websocketUrl ?? "",
        authnBaseUrl: "https://authn.test",
        hostPublicKey: entry.publicKey,
        bearer,
        hostTokens,
        door: null,
        onState: () => undefined,
        cloudAuthorized: () => true,
        auth: null,
        clock: null,
        rpcRegistry: hostRpcRegistry,
        streamRegistry: hostStreamRpcRegistry,
        webSocketFactory: peer.factory,
        requestId: () => "request-relay-open",
        evidence: NO_TRANSPORT_EVIDENCE,
        clientIdentity: TEST_CLIENT_IDENTITY,
        proactiveWakeEligible: false,
      });
      if (transport === null) throw new Error("remote transport did not build");

      try {
        transport.session.start();
        await vi.waitFor(() => expect(peer.opens).toHaveLength(1), WAIT);
        await vi.waitFor(
          () => expect(transport.session.isReady()).toBe(true),
          WAIT,
        );

        expect(entry.owner).toEqual(testCase.owner);
        expect(entry.sandbox !== null).toBe(testCase.kind === "sandbox");
        expect(peer.opens[0]?.bearer).toBe("");
        expect(peer.opens[0]?.authz).toEqual({
          v: OPEN_AUTHZ_SESSION_GRANT_VERSION,
          grant: hostToken,
        });
        expect(JSON.stringify(peer.opens[0])).not.toContain(SIGN_IN_TOKEN);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(peer.errors).toEqual([]);
      } finally {
        transport.session.close();
        retireAllRemoteSessions();
      }
    },
  );
});
