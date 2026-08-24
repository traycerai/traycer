import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { CloneProfileRecovery } from "../clone-profile-recovery";

const recoveryHooks = vi.hoisted(() => ({
  setEnabled: vi.fn(),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

vi.mock("@/hooks/providers/use-providers-set-profile-enabled-mutation", () => ({
  useProvidersSetProfileEnabledForClient: () => ({
    mutate: recoveryHooks.setEnabled,
  }),
  useProviderProfileEnablementPending: () => () => false,
}));

function buildClient(): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-clone-recovery",
      handlers: {},
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-clone-recovery",
    }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

function baseProps() {
  return {
    client: buildClient(),
    targetHostLabel: "Remote host",
    onChooseProfile: vi.fn(),
    onRetry: vi.fn(),
    onCancel: vi.fn(),
    onOpenProviderSettings: vi.fn(),
  };
}

describe("<CloneProfileRecovery /> catalog recovery", () => {
  afterEach(() => {
    cleanup();
    recoveryHooks.setEnabled.mockClear();
  });

  it("keeps target transport failure distinct and exposes Retry and Cancel", () => {
    const props = baseProps();
    render(
      <CloneProfileRecovery
        {...props}
        resolution={{
          status: "catalog-unavailable",
          providerId: "claude-code",
        }}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "couldn't be loaded",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
    expect(
      screen.queryByText("No profiles are configured on this host."),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps an honest empty catalog stopped with Settings recovery and no create", () => {
    const props = baseProps();
    render(
      <CloneProfileRecovery
        {...props}
        resolution={{
          status: "profile-selection-required",
          providerId: "claude-code",
          reason: "no-enabled-terminal-fallback",
          matchedProfileId: null,
          targetProfiles: [],
        }}
      />,
    );

    expect(
      screen.getByText("No profiles are configured on this host."),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Open provider settings" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open provider settings" }),
    );
    expect(props.onOpenProviderSettings).toHaveBeenCalledTimes(1);
    expect(recoveryHooks.setEnabled).not.toHaveBeenCalled();
  });
});
