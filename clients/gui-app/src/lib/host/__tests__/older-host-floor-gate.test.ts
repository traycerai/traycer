vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/minimum-host-version")
      >();
    return { ...actual, MINIMUM_HOST_VERSION: "2.0.0" };
  },
);

const remoteTransport = vi.hoisted(() => vi.fn());
vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return { ...actual, createRemoteHostTransport: remoteTransport };
  },
);

const socketBuilds = vi.hoisted(() => ({ rpc: 0, stream: 0 }));
vi.mock(
  "@traycer-clients/shared/host-transport/ws-rpc-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/ws-rpc-client")
      >();
    class CountingWsRpcClient {
      constructor() {
        socketBuilds.rpc += 1;
      }
    }
    return {
      ...actual,
      WsRpcClient: CountingWsRpcClient,
    };
  },
);
vi.mock(
  "@traycer-clients/shared/host-transport/ws-stream-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/ws-stream-client")
      >();
    class CountingWsStreamClient {
      constructor() {
        socketBuilds.stream += 1;
      }
    }
    return {
      ...actual,
      WsStreamClient: CountingWsStreamClient,
    };
  },
);

const narratedEntry = vi.hoisted(
  (): {
    current:
      | import("@traycer-clients/shared/host-client/host-directory").HostDirectoryEntry
      | null;
  } => ({
    current: null,
  }),
);
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-directory-entry")
    >();
  return {
    ...actual,
    useHostDirectoryEntry: () => narratedEntry.current,
  };
});

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  localEntry,
  remoteEntry,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { buildRawHostMessengerForTarget } from "@/lib/host/host-messenger";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import { useWindowNarration } from "@/hooks/host/use-window-narration";
import type { WindowNarrationState } from "@/lib/host/window-narration";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * Floor for this file is `"2.0.0"`. Below it, both builders return before any
 * socket class or remote transport is constructed. At it, a remote row builds
 * the remote transport and a local row builds the local socket classes.
 */

const FLOOR_HOST = "host-floor";

function remoteRow(appVersion: string | null): RemoteHostDirectoryEntry {
  const base = remoteEntry(FLOOR_HOST, null);
  return {
    ...base,
    version: "9.9.9",
    remoteStatus: { ...base.remoteStatus, appVersion },
  };
}

function localRow(version: string): HostDirectoryEntry {
  return { ...localEntry, hostId: FLOOR_HOST, version };
}

function messengerFor(target: HostDirectoryEntry) {
  return buildRawHostMessengerForTarget({
    target,
    registry: hostRpcRegistry,
    bearer: () => null,
    cloudAuthorized: () => false,
    auth: null,
    authnBaseUrl: "https://authn.example.invalid",
    requestId: () => "request-1",
    userId: "user-1",
  });
}

function streamFor(target: HostDirectoryEntry) {
  return buildHostStreamClient({
    target,
    endpoint: () => null,
    bearer: () => null,
    cloudAuthorized: () => false,
    authnBaseUrl: "https://authn.example.invalid",
    auth: null,
    userId: "user-1",
    proactiveWakeEligible: false,
    autoStart: false,
  });
}

function attachNarration(): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: FLOOR_HOST,
    targetHostId: FLOOR_HOST,
    effectiveHostId: FLOOR_HOST,
    leases: [],
    selectionRevision: 1,
  });
}

function tookOlderHost(state: WindowNarrationState): boolean {
  return (
    state.kind === "narrating" &&
    state.variant.kind === "update-host" &&
    state.variant.detail.code === "older-host"
  );
}

beforeEach(() => {
  socketBuilds.rpc = 0;
  socketBuilds.stream = 0;
  remoteTransport.mockReset();
  remoteTransport.mockImplementation(() => ({
    messenger: { marker: "messenger" },
    session: { start: () => undefined },
    streamClient: { marker: "stream" },
  }));
  narratedEntry.current = null;
});

afterEach(() => {
  useSelectionAuthorityStore.getState().reset();
});

describe("older host floor gate", () => {
  it("returns both builders before any dial when a remote row is below the floor", () => {
    const target = remoteRow("1.5.4");

    expect(messengerFor(target)).toBeNull();
    expect(streamFor(target)).toBeNull();
    expect(remoteTransport).not.toHaveBeenCalled();
    expect(socketBuilds).toEqual({ rpc: 0, stream: 0 });
  });

  it("returns both builders before any dial when a local row is below the floor", () => {
    const target = localRow("1.5.4");

    expect(messengerFor(target)).toBeNull();
    expect(streamFor(target)).toBeNull();
    expect(remoteTransport).not.toHaveBeenCalled();
    expect(socketBuilds).toEqual({ rpc: 0, stream: 0 });
  });

  it("builds a remote transport at the floor and does not construct a local socket", () => {
    const target = remoteRow("2.0.0");

    const messenger = messengerFor(target);
    const stream = streamFor(target);

    expect(messenger).not.toBeNull();
    expect(stream).toEqual({ marker: "stream" });
    expect(remoteTransport).toHaveBeenCalledTimes(2);
    expect(socketBuilds).toEqual({ rpc: 0, stream: 0 });
  });

  it("builds local socket classes at the floor and does not call the remote transport", () => {
    const target = localRow("2.0.0");

    expect(messengerFor(target)).not.toBeNull();
    expect(streamFor(target)).not.toBeNull();
    expect(remoteTransport).not.toHaveBeenCalled();
    expect(socketBuilds).toEqual({ rpc: 1, stream: 1 });
  });

  it("narrates Host update needed from a remote app version below the floor", () => {
    narratedEntry.current = remoteRow("1.5.4");
    attachNarration();

    const { result } = renderHook(() => useWindowNarration());

    expect(tookOlderHost(result.current)).toBe(true);
    if (
      result.current.kind !== "narrating" ||
      result.current.variant.kind !== "update-host"
    ) {
      throw new Error("expected the older-host narration");
    }
    expect(result.current.variant.detail.hostVersion).toBe("1.5.4");
    expect(result.current.variant.detail.minSupportedVersion).toBe("2.0.0");
    expect(result.current.variant.detail.code).toBe("older-host");
  });

  it("does not take the older-host arm when the remote app version meets the floor", () => {
    narratedEntry.current = remoteRow("2.0.0");
    attachNarration();

    const { result } = renderHook(() => useWindowNarration());

    expect(tookOlderHost(result.current)).toBe(false);
  });

  it("does not throw when the narrator has no directory row and no runtime binding", () => {
    const { result } = renderHook(() => useWindowNarration());

    expect(tookOlderHost(result.current)).toBe(false);
  });
});
