import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";

/**
 * The jar stream carries the desktop's whole cookie jar, so main never builds
 * one for a sandbox: the Noise session would be held by a machine the user
 * does not own before any refusal could run. These pin that no remote
 * transport is even constructed for a sandbox, and that a personal host's is
 * built on the user bearer.
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

beforeEach(() => {
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
});
