import { describe, expect, it } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

import { modalWorkspaceHostScope } from "../new-conversation-modal-host-scope";

describe("modalWorkspaceHostScope", () => {
  it("uses the active scope only when no host is pinned", () => {
    expect(modalWorkspaceHostScope(null, null)).toEqual({ kind: "active" });
  });

  it("stays fixed while the pinned host's client is still resolving", () => {
    // Regression: falling back to the active scope for this window let the
    // user browse (and persist) another host's folders into a draft the
    // submit then applied to the pinned host.
    expect(modalWorkspaceHostScope("tab-host", null)).toEqual({
      kind: "fixed",
      hostId: "tab-host",
      hostClient: null,
    });
  });

  it("carries the resolved client once the pinned host has one", () => {
    const hostClient = {} as HostClient<HostRpcRegistry>;
    expect(modalWorkspaceHostScope("tab-host", hostClient)).toEqual({
      kind: "fixed",
      hostId: "tab-host",
      hostClient,
    });
  });
});
