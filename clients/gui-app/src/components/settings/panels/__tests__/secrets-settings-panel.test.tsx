// These cases are about the preview features' on behaviour.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

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

describe("<SecretsSettingsPanel />", () => {
  it("shows the page on a personal host that serves the secrets list", () => {
    renderPanel({
      supported: true,
      status: environmentStatusFixture({ principal: { kind: "personal" } }),
      hasClient: true,
    });

    expect(screen.getByTestId("secrets-page")).toBeTruthy();
    expect(screen.queryByTestId("secrets-team-view")).toBeNull();
    expect(screen.queryByTestId("secrets-update-host")).toBeNull();
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
    expect(screen.queryByTestId("secrets-update-host")).toBeNull();
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
    expect(screen.queryByTestId("secrets-update-host")).toBeNull();
  });

  it("asks to update a host that predates the page", () => {
    renderPanel({
      supported: false,
      status: environmentStatusFixture({ principal: { kind: "personal" } }),
      hasClient: true,
    });

    expect(screen.getByTestId("secrets-update-host").textContent).toBe(
      "Update this host to use your secrets here.",
    );
    expect(screen.queryByTestId("secrets-page")).toBeNull();
    expect(screen.queryByTestId("secrets-team-view")).toBeNull();
  });

  it("shows neither before the host's handshake says what it serves", () => {
    renderPanel({
      supported: null,
      status: environmentStatusFixture({ principal: { kind: "personal" } }),
      hasClient: true,
    });

    expect(screen.queryByTestId("secrets-page")).toBeNull();
    expect(screen.queryByTestId("secrets-update-host")).toBeNull();
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
