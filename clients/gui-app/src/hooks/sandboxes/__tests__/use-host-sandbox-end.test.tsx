import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  forgetEndedSandboxHost,
  recordEndedSandboxHost,
} from "@/stores/sandboxes/ended-sandbox-hosts-store";
import {
  sandboxDeadTileReason,
  useHostSandboxEnd,
} from "@/hooks/sandboxes/use-host-sandbox-end";

const directory = vi.hoisted(() => ({
  entry: null as HostDirectoryEntry | null,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => directory.entry,
}));

function sandboxEntry(
  sandboxState: HostListItem["sandboxState"],
): HostDirectoryEntry {
  return hostListItemToDirectoryEntry(
    {
      hostId: "host-sbx",
      displayName: "e2e-sbx-p1",
      platform: "linux",
      kind: "sandbox",
      sandboxState,
      publicKey: "pk",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatePolicy: "manual",
      status: {
        connectivity: "offline",
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.5.0",
        lastSeenAt: null,
      },
      owner: { kind: "user", id: "user-1" },
    },
    "wss://relay.example.test",
  );
}

function end() {
  return renderHook(() => useHostSandboxEnd("host-sbx")).result.current;
}

afterEach(() => {
  forgetEndedSandboxHost("host-sbx");
  act(() => {
    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  });
});

describe("useHostSandboxEnd", () => {
  it("is stopped for a sandbox that is stopped or stopping", () => {
    directory.entry = sandboxEntry("stopped");
    expect(end()).toEqual({ kind: "stopped" });
    directory.entry = sandboxEntry("stopping");
    expect(end()).toEqual({ kind: "stopped" });
  });

  it("is null for a sandbox in any other state and for a host with no entry", () => {
    directory.entry = sandboxEntry("awake");
    expect(end()).toBeNull();
    directory.entry = sandboxEntry("suspended");
    expect(end()).toBeNull();
    directory.entry = null;
    expect(end()).toBeNull();
  });

  it("is destroyed, with who and when, for a host a member destroyed, whatever its directory entry says", () => {
    act(() => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "u-me", username: "me" },
      });
    });
    directory.entry = sandboxEntry("stopped");
    recordEndedSandboxHost("host-sbx", {
      name: "e2e-sbx-p1",
      at: new Date(2026, 9, 25, 11, 1).getTime(),
      actor: { userId: "u-me", displayName: null },
    });

    expect(end()).toEqual({
      kind: "destroyed",
      line: "e2e-sbx-p1 was destroyed by you at 11:01.",
    });
  });

  it("maps an end to the dead tile's reason", () => {
    expect(sandboxDeadTileReason(null)).toBe("host-unreachable");
    expect(sandboxDeadTileReason({ kind: "stopped" })).toBe("sandbox-stopped");
    expect(sandboxDeadTileReason({ kind: "destroyed", line: "x" })).toBe(
      "sandbox-destroyed",
    );
  });
});
