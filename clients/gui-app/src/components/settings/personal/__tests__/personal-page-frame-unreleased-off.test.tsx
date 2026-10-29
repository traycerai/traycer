/**
 * The build without environments (`unreleased-features.ts`) wraps a host's
 * settings page the way the release before them showed it: the page is its
 * host's own, editable, with no status read from the host, no delivery chip,
 * no line and no notice, even on a host that would answer
 * `environment.status`; the context still names the picked host for the rows
 * that address it.
 */
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  return { useHostScope, usePersonalHostScope: useHostScope };
});
// The page's pick is the Host picker's host, resolved from the host list.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: [hostScopeOptionFixture({ hostId: "host-picked" })],
      }),
  };
});
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { usePersonalPageHost } from "@/components/settings/personal/personal-page-context";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import type { HostRpcRegistry } from "@/lib/host";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";

const HOST_ID = "host-picked";
const HOST_NAME = "dev-box";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
});

function PageHostProbe(): ReactNode {
  const pageHost = usePersonalPageHost();
  return <output data-testid="page-host">{pageHost.hostId ?? "none"}</output>;
}

describe("<PersonalPageFrame /> without environments", () => {
  it("shows the picked host's page editable, reads no status and draws no line", async () => {
    let statusReads = 0;
    const handlers: MockHandlerMap<HostRpcRegistry> = {
      "environment.status": () => {
        statusReads += 1;
        return environmentStatusFixture({});
      },
    };
    const { client } = buildEnvironmentClient({ hostId: HOST_ID, handlers });
    // A host that would answer the read: the frame still never asks.
    recordNegotiatedHostMethods(HOST_ID, [
      "host.status",
      "environment.status",
      "environment.localOverrides",
    ]);
    scopeOverrides.current = {
      host: hostScopeOptionFixture({ hostId: HOST_ID, name: HOST_NAME }),
      hostId: HOST_ID,
      hostLabel: HOST_NAME,
      status: "ready",
      client,
    };
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <PersonalPageFrame section="shell">
          <SettingsPanelShell title="Shell" description="How terminals start.">
            <button type="button">Edit the page</button>
            <PageHostProbe />
          </SettingsPanelShell>
        </PersonalPageFrame>
      </QueryClientProvider>,
    );
    // Give any read the frame might start a turn of the loop to show up.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    const edit = screen.getByRole("button", { name: "Edit the page" });
    expect(edit.closest("[inert]")).toBeNull();
    expect(screen.queryByTestId("personal-page-status")).toBeNull();
    expect(screen.getByTestId("page-host").textContent).toBe(HOST_ID);
    expect(statusReads).toBe(0);
  });
});
