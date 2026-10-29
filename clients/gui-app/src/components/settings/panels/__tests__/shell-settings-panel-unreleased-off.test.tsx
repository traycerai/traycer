/**
 * The build without environments (`unreleased-features.ts`) words the Shell
 * page as the release before them did: "host env" in the header, the host's
 * own empty-environment line, and no Personal wording.
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
        hosts: [hostScopeOptionFixture({ hostId: "host-a" })],
      }),
  };
});
const hostBindingMock = vi.hoisted(
  (): { current: { readonly hostClient: unknown } | null } => ({
    current: null,
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => hostBindingMock.current,
    useHostClient: () => hostBindingMock.current?.hostClient,
  };
});
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";
import {
  CONFIG_SHELL_METHODS,
  buildConfigHostFixture,
} from "@/components/settings/panels/__tests__/host-config-rpc-test-support";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const HOST_ID = "host-a";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
});

describe("<ShellSettingsPanel /> without environments", () => {
  it("describes host env changes, names the empty host environment and never says Personal", async () => {
    const fixture = buildConfigHostFixture({
      hostId: HOST_ID,
      isLocalMachine: true,
      cli: new MockTraycerCli(),
      overrideHandlers: undefined,
    });
    recordNegotiatedHostMethods(HOST_ID, [...CONFIG_SHELL_METHODS]);
    scopeOverrides.current = {
      host: hostScopeOptionFixture({
        hostId: HOST_ID,
        isLocalMachine: true,
        connectable: true,
      }),
      hostId: HOST_ID,
      status: "ready",
      client: fixture.client,
    };
    hostBindingMock.current = { hostClient: fixture.client };
    const runnerHost = new MockRunnerHost({
      signInUrl: "https://example.invalid/signin",
      authnBaseUrl: "https://example.invalid",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    const container = render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider runnerHost={runnerHost}>
          <ShellSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        "No host environment variables. The host starts with the environment your shell produces.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /New terminals pick up shell changes immediately; host env changes apply on restart\.$/,
      ),
    ).toBeTruthy();
    expect(container.container.textContent).not.toContain("Personal");
  });
});
