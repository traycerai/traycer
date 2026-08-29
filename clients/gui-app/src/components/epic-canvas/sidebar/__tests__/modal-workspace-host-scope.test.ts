import { describe, expect, it } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import type { HostRpcRegistry } from "@/lib/host";

import { modalWorkspaceHostScope } from "../new-conversation-modal-host-scope";

describe("modalWorkspaceHostScope", () => {
  it("uses the active scope only when no host is pinned", () => {
    const onSelect = (): void => undefined;
    expect(
      modalWorkspaceHostScope({
        resolvedHostId: null,
        hostClient: null,
        callerNamedHost: false,
        onSelect,
      }),
    ).toEqual({ kind: "active" });
  });

  it("keeps a caller-named host fixed while its client is still resolving", () => {
    const onSelect = (): void => undefined;
    expect(
      modalWorkspaceHostScope({
        resolvedHostId: "tab-host",
        hostClient: null,
        callerNamedHost: true,
        onSelect,
      }),
    ).toEqual({ kind: "fixed", hostId: "tab-host", hostClient: null });
  });

  it("keeps a caller-named host fixed once its client resolves", () => {
    const hostClient = {} as HostClient<HostRpcRegistry>;
    const onSelect = (): void => undefined;
    expect(
      modalWorkspaceHostScope({
        resolvedHostId: "tab-host",
        hostClient,
        callerNamedHost: true,
        onSelect,
      }),
    ).toEqual({
      kind: "fixed",
      hostId: "tab-host",
      hostClient,
    });
  });

  it("lets an unnamed new chat switch away from its Epic-derived host", () => {
    const hostClient = {} as HostClient<HostRpcRegistry>;
    const onSelect = (): void => undefined;

    expect(
      modalWorkspaceHostScope({
        resolvedHostId: "epic-host",
        hostClient,
        callerNamedHost: false,
        onSelect,
      }),
    ).toEqual({
      kind: "selected",
      hostId: "epic-host",
      hostClient,
      onSelect,
      refusalByHostId: NO_HOST_OPTION_REFUSALS,
      unselectableExceptHostId: null,
    });
  });
});
