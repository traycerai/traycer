// The panel reads through the window's own host. Mocked at the scope boundary,
// as the other Personal suites do, because they render bare, without the host
// runtime the real scope composes.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  return { useHostScope, usePersonalHostScope: useHostScope };
});

// The secrets list names its environment through the surface's client.
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => scopeOverrides.current.client,
}));

// What the host's handshake says about `environment.secrets.list`.
const support = vi.hoisted((): { current: boolean | null } => ({
  current: null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => support.current,
  useHostSupportsMethod: () => support.current === true,
}));

// What `environment.status` says about whose host this is.
const statusRead = vi.hoisted(
  (): { current: EnvironmentStatusResponse | null } => ({ current: null }),
);
vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => ({
    supported: true,
    data: statusRead.current,
    isError: false,
  }),
}));

// The page itself is `secrets-page.test.tsx`'s subject: here it is a marker
// that the panel chose it.
vi.mock("@/components/settings/secrets/secrets-page", () => ({
  SecretsPage: () => <div data-testid="secrets-page" />,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type {
  OpenSettingsModalOpts,
  SystemOverlayKind,
  SystemTabModalApi,
} from "@/stores/tabs/use-system-tab-modal";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useTabsStore } from "@/stores/tabs/store";
import { SECRETS } from "@/components/settings/panels/secrets.definitions";
import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { SecretsSettingsPanel } from "@/components/settings/panels/secrets-settings-panel";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { TEAM_SECRETS_LINE } from "@/lib/sandboxes/secrets-page-copy";

const HOST_ID = "host-a";

afterEach(() => {
  cleanup();
  setSystemTabModalApi(null);
  useTabsStore.setState({ systemTabs: { history: null, settings: null } });
  scopeOverrides.current = {};
  support.current = null;
  statusRead.current = null;
});

function renderPanel(options: {
  readonly supported: boolean | null;
  readonly status: EnvironmentStatusResponse | null;
  readonly hasClient: boolean;
}): void {
  support.current = options.supported;
  statusRead.current = options.status;
  scopeOverrides.current = {
    host: hostScopeOptionFixture({ hostId: HOST_ID }),
    hostId: HOST_ID,
    status: "ready",
    client: options.hasClient
      ? buildEnvironmentClient({ hostId: HOST_ID, handlers: {} }).client
      : null,
  };
  // The panel reads the secrets list to decide whether it has a subtitle.
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SecretsSettingsPanel />
    </QueryClientProvider>,
  );
}

/**
 * The Settings surface's commands, published through the real bridge and
 * recorded, over a Settings tab remembered at Secrets: the helper a server
 * fact reaches for decides which of them it issues.
 */
function publishSurface(options: { readonly overlayActive: boolean }) {
  const surface = {
    openSettings: vi.fn<(opts: OpenSettingsModalOpts) => void>(),
    setSection: vi.fn<(section: SettingsSectionId) => void>(),
    replaceOwnedSettingsRoute: vi.fn<(section: SettingsSectionId) => void>(),
  };
  const api: SystemTabModalApi = {
    ...surface,
    active: null,
    openHistory: () => undefined,
    close: () => undefined,
    promoteToTab: () => undefined,
    isOverlayActive: (kind: SystemOverlayKind) =>
      kind === "settings" && options.overlayActive,
  };
  useTabsStore.getState().openSystemTab({
    kind: "settings",
    name: "Settings",
    lastPath: "/settings/secrets",
  });
  setSystemTabModalApi(api);
  return surface;
}

describe("<SecretsSettingsPanel />", () => {
  it("shows the page on a personal host that serves the secrets list", () => {
    renderPanel({
      supported: true,
      status: environmentStatusFixture({ principal: { kind: "personal" } }),
      hasClient: true,
    });

    expect(screen.getByTestId("secrets-page")).toBeTruthy();
    expect(screen.queryByTestId("secrets-team-view")).toBeNull();
  });

  it("shows the page while the host's principal is not yet read", () => {
    renderPanel({ supported: true, status: null, hasClient: true });

    expect(screen.getByTestId("secrets-page")).toBeTruthy();
  });

  it("shows the team line, and no page, on a team's host", () => {
    renderPanel({
      supported: true,
      status: environmentStatusFixture({
        principal: { kind: "team", teamName: "Acme" },
      }),
      hasClient: true,
    });

    expect(screen.getByTestId("secrets-team-view")).toBeTruthy();
    expect(screen.getByTestId("secrets-team-line").textContent).toBe(
      TEAM_SECRETS_LINE,
    );
    expect(screen.getByTestId("team-owned-line").textContent).toContain("Acme");
    expect(screen.queryByTestId("secrets-page")).toBeNull();
  });

  it("shows the team line on a team's host that predates the page", () => {
    renderPanel({
      supported: false,
      status: environmentStatusFixture({
        principal: { kind: "team", teamName: "Acme" },
      }),
      hasClient: true,
    });

    expect(screen.getByTestId("secrets-team-view")).toBeTruthy();
  });

  it("shows the title and description, and nothing under them, once the host says it does not serve the list", () => {
    const surface = publishSurface({ overlayActive: true });

    renderPanel({
      supported: false,
      status: environmentStatusFixture({ principal: { kind: "personal" } }),
      hasClient: true,
    });

    expect(
      screen.getByRole("heading", { name: SECRETS.page.label }),
    ).toBeTruthy();
    expect(screen.getByText(SECRETS.page.description)).toBeTruthy();
    expect(
      document.querySelector("[data-settings-panel-body]")?.textContent,
    ).toBe("");
    expect(surface.setSection).not.toHaveBeenCalled();
    expect(surface.replaceOwnedSettingsRoute).not.toHaveBeenCalled();
    expect(surface.openSettings).not.toHaveBeenCalled();
    expect(useTabsStore.getState().systemTabs.settings?.lastPath).toBe(
      "/settings/secrets",
    );
  });

  it("neither moves nor shows a line, and keeps the description, before the host's handshake says what it serves", () => {
    const surface = publishSurface({ overlayActive: true });

    renderPanel({
      supported: null,
      status: environmentStatusFixture({ principal: { kind: "personal" } }),
      hasClient: true,
    });

    expect(
      screen.getByRole("heading", { name: SECRETS.page.label }),
    ).toBeTruthy();
    expect(screen.getByText(SECRETS.page.description)).toBeTruthy();
    expect(
      document.querySelector("[data-settings-panel-body]")?.textContent,
    ).toBe("");
    expect(surface.setSection).not.toHaveBeenCalled();
    expect(surface.replaceOwnedSettingsRoute).not.toHaveBeenCalled();
    expect(useTabsStore.getState().systemTabs.settings?.lastPath).toBe(
      "/settings/secrets",
    );
    expect(screen.queryByTestId("secrets-page")).toBeNull();
    expect(screen.queryByTestId("secrets-team-view")).toBeNull();
  });

  it("does not show the page without a client to read through", () => {
    renderPanel({
      supported: true,
      status: environmentStatusFixture({ principal: { kind: "personal" } }),
      hasClient: false,
    });

    expect(screen.queryByTestId("secrets-page")).toBeNull();
  });
});
