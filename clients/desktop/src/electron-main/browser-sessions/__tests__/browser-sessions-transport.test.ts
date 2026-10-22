import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import {
  poolHostDirectoryEntry,
  type HostDirectoryEntry,
  type HostKind,
} from "@traycer-clients/shared/host-client/host-directory";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";

/**
 * The jar stream carries the desktop's whole cookie jar, so main never builds
 * one for a sandbox: the Noise session would be held by a machine the user
 * does not own before any refusal could run. These pin that no remote
 * transport is even constructed for a sandbox, and that a personal host's is
 * built on the user bearer. The jar transport is an allowlist of the two
 * kinds that are the person's own hosts: the server pool and any kind this
 * build does not know get none.
 */

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

const remote = vi.hoisted(() => {
  const start = vi.fn<() => void>();
  const close = vi.fn<() => void>();
  return {
    start,
    close,
    createRemoteHostTransport: vi.fn(() => ({
      session: { start, close },
      streamClient: {},
    })),
  };
});
vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer-clients/shared/host-transport/remote/index")
    >()),
    createRemoteHostTransport: remote.createRemoteHostTransport,
  }),
);

const wsStream = vi.hoisted(() => ({
  constructed: vi.fn<(options: { readonly hostId: string }) => void>(),
  close: vi.fn<(reason: string) => void>(),
}));
vi.mock("@traycer-clients/shared/host-transport/ws-stream-client", () => ({
  WsStreamClient: class {
    constructor(options: { readonly hostId: string }) {
      wsStream.constructed(options);
    }
    close(reason: string): void {
      wsStream.close(reason);
    }
  },
}));

import { openBrowserSessionsTransport } from "../browser-sessions-transport";

const BEARER: BearerSourceProvider = () => ({
  getBearerToken: () => "bearer-token",
  identity: { userId: "user-1" },
});

const DEPS = {
  authnBaseUrl: () => "https://authn.test",
  bearer: BEARER,
  cloudAuthorized: () => true,
  endpoint: () => null,
  appVersion: "1.5.0",
};

function remoteEntry(kind: "personal" | "sandbox"): RemoteHostDirectoryEntry {
  const item: HostListItem = {
    hostId: "host-r",
    displayName: "Remote",
    platform: "linux",
    kind,
    publicKey: "cHVibGljS2V5",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatePolicy: "auto",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: null,
    },
    ...(kind === "sandbox"
      ? { sandboxState: "awake", sandboxFrozen: false, profile: "agent" }
      : {}),
  };
  return hostListItemToDirectoryEntry(item, "wss://relay.test/attach");
}

function entryWithKind(
  kind: Exclude<HostKind, "pool" | "remote">,
): HostDirectoryEntry {
  return {
    hostId: `host-${kind}`,
    label: kind,
    kind,
    websocketUrl: "ws://127.0.0.1:4455/ws",
    version: null,
    transportDialability: "dialable",
  };
}

function poolEntry(): HostDirectoryEntry {
  const pool = poolHostDirectoryEntry("wss://pool.test/v1/session");
  if (pool === null) {
    throw new Error("a non-empty pool URL synthesizes an entry");
  }
  return pool;
}

const KINDS: readonly HostKind[] = ["local", "remote", "mock", "pool"];

type JarTransport = "local-socket" | "personal-remote" | null;

/**
 * Exhaustive over `HostKind`: a kind added later fails to compile here until
 * someone decides whether the cookie jar may ride it.
 */
const EXPECTED: Readonly<Record<HostKind, JarTransport>> = {
  local: "local-socket",
  remote: "personal-remote",
  mock: null,
  pool: null,
};

const ENTRY_OF_KIND: Readonly<Record<HostKind, () => HostDirectoryEntry>> = {
  local: () => entryWithKind("local"),
  remote: () => remoteEntry("personal"),
  mock: () => entryWithKind("mock"),
  pool: poolEntry,
};

beforeEach(() => {
  wsStream.constructed.mockClear();
  wsStream.close.mockClear();
  remote.createRemoteHostTransport.mockClear();
  remote.start.mockClear();
  remote.close.mockClear();
});

describe("openBrowserSessionsTransport", () => {
  it("builds no transport for a sandbox, and never constructs a remote one", () => {
    const transport = openBrowserSessionsTransport(
      remoteEntry("sandbox"),
      "user-1",
      DEPS,
    );

    expect(transport).toBeNull();
    expect(remote.createRemoteHostTransport).not.toHaveBeenCalled();
    expect(remote.start).not.toHaveBeenCalled();
  });

  it("builds a personal remote host's transport on the user bearer, and starts it", () => {
    const transport = openBrowserSessionsTransport(
      remoteEntry("personal"),
      "user-1",
      DEPS,
    );

    expect(transport).not.toBeNull();
    expect(remote.createRemoteHostTransport).toHaveBeenCalledTimes(1);
    expect(remote.createRemoteHostTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "host-r",
        userId: "user-1",
        openAuth: "user-bearer",
      }),
    );
    expect(remote.start).toHaveBeenCalledTimes(1);

    transport?.close();
    expect(remote.close).toHaveBeenCalledTimes(1);
  });

  it.each(KINDS)(
    "gives a %s entry its allowlisted jar transport and no other",
    (kind) => {
      const transport = openBrowserSessionsTransport(
        ENTRY_OF_KIND[kind](),
        "user-1",
        DEPS,
      );

      const expected = EXPECTED[kind];
      expect(transport === null).toBe(expected === null);
      expect(wsStream.constructed).toHaveBeenCalledTimes(
        expected === "local-socket" ? 1 : 0,
      );
      expect(remote.createRemoteHostTransport).toHaveBeenCalledTimes(
        expected === "personal-remote" ? 1 : 0,
      );
      transport?.close();
    },
  );
});
