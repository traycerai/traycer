import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { resetEnvironmentSectionReads } from "@/components/settings/__tests__/environment-section-reads-fixture";
import {
  mountSettings,
  offlineWindowHost,
  resetWindowHost,
  SECRETS_LIST,
  takeWindowHostOffline,
  takeWindowHostOnline,
} from "@/components/settings/__tests__/secrets-host-away-support";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";

// Settings' rail and the Secrets page are read here over one window host. The
// scope, the host client and the rail's unrelated reads are stand-ins; the
// hooks that decide whether Secrets is offered and which source it reads are
// the real ones.
vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async () =>
    (
      await import("@/components/settings/__tests__/environment-section-reads-fixture")
    ).personalHostScopeModule,
);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  ...(
    await import("@/components/settings/__tests__/secrets-host-away-window-host")
  ).windowHostModule,
}));
vi.mock(
  "@/hooks/host/use-host-credential-refusal",
  async () =>
    (
      await import("@/components/settings/__tests__/secrets-host-away-window-host")
    ).hostCredentialRefusalModule,
);
vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  async () =>
    (
      await import("@/components/settings/__tests__/secrets-host-away-window-host")
    ).hostClientForHostIdModule,
);
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock(
  "@/hooks/host/use-host-negotiated-method-version",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/host/use-host-negotiated-method-version")
    >()),
    ...(
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).negotiatedMethodVersionModule,
  }),
);
vi.mock(
  "@/hooks/environment/use-registered-host-environment-statuses",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).registeredHostEnvironmentStatusesModule,
);
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).hostsRunningConfigurationModule,
);
vi.mock(
  "@/components/settings/move-sheet",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).moveSheetModule,
);
vi.mock(
  "@/components/settings/environment/team-pick-label",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/settings/environment/team-pick-label")
    >()),
    ...(
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).teamPickLabelModule,
  }),
);
vi.mock(
  "@/components/settings/environment/team-rows",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).teamRowsModule,
);
vi.mock(
  "@/components/settings/members/invite-accept-dialog",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).inviteAcceptDialogModule,
);
vi.mock(
  "@/components/onboarding/getting-started-checklist",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).gettingStartedChecklistModule,
);
vi.mock(
  "@/components/settings/host-scope/add-host-dialog",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).addHostDialogModule,
);
vi.mock("@/hooks/auth/use-registered-hosts-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/auth/use-registered-hosts-query")
  >()),
  ...(
    await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
  ).registeredHostsLivenessModule,
}));
vi.mock(
  "@/hooks/bots/use-host-environment-labels",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).hostEnvironmentLabelsModule,
);
vi.mock(
  "@/hooks/host/use-fleet-update-views",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).fleetUpdateViewsModule,
);
vi.mock(
  "@/components/hosts/sandbox-balance-banner",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).sandboxBalanceBannerModule,
);

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  resetEnvironmentSectionReads();
  resetWindowHost();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

const SECRETS_DESCRIPTION = "Values and logins your agents use.";
const secretsRow = (): Element | null =>
  screen.queryByTestId("settings-sidebar-item-secrets");

describe("Personal's Secrets under a window host that is listed but offline", () => {
  it("offers the Secrets row and draws the cloud page, not the spinner, with Personal picked", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });

    mountSettings({
      host: offlineWindowHost(),
      manifest: null,
      handlers: {},
    });

    await screen.findByTestId("settings-sidebar-item-general");
    expect(secretsRow()).not.toBeNull();
    expect(await screen.findByText(SECRETS_DESCRIPTION)).toBeTruthy();
    expect(screen.queryByTestId("personal-source-loading")).toBeNull();
  });

  it("offers no Secrets row on a reachable host that runs Personal and does not serve the list", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });

    const { messenger } = mountSettings({
      host: hostScopeOptionFixture({ hostId: "host-a", name: "dev-box" }),
      manifest: { "environment.status": 1 },
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ principal: { kind: "personal" } }),
      },
    });

    await screen.findByTestId("settings-sidebar-item-general");
    // The page leaves its spinner once the host's answer says it runs Personal.
    await waitFor(() => {
      expect(screen.queryByTestId("personal-source-loading")).toBeNull();
    });
    expect(messenger.calls.some((call) => call.method === SECRETS_LIST)).toBe(
      false,
    );
    expect(secretsRow()).toBeNull();
  });
});

describe("Personal's Secrets once the window host that answered goes offline", () => {
  it("offers the Secrets row and draws the cloud page, not the spinner, with its answer still cached", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });

    mountSettings({
      host: hostScopeOptionFixture({ hostId: "host-a", name: "dev-box" }),
      manifest: { "environment.status": 1 },
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ principal: { kind: "personal" } }),
      },
    });

    await screen.findByTestId("settings-sidebar-item-general");
    await waitFor(() => {
      expect(screen.queryByTestId("personal-source-loading")).toBeNull();
    });
    expect(secretsRow()).toBeNull();

    takeWindowHostOffline();

    await waitFor(() => {
      expect(secretsRow()).not.toBeNull();
    });
    expect(await screen.findByText(SECRETS_DESCRIPTION)).toBeTruthy();
    expect(screen.queryByTestId("personal-source-loading")).toBeNull();
  });
});

describe("Personal's Secrets once the window host that went offline comes back", () => {
  async function mountAnsweredThenOffline(): Promise<void> {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });
    mountSettings({
      host: hostScopeOptionFixture({ hostId: "host-a", name: "dev-box" }),
      manifest: { "environment.status": 1 },
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ principal: { kind: "personal" } }),
      },
    });
    await screen.findByTestId("settings-sidebar-item-general");
    await waitFor(() => {
      expect(screen.queryByTestId("personal-source-loading")).toBeNull();
    });
    takeWindowHostOffline();
    await waitFor(() => {
      expect(secretsRow()).not.toBeNull();
    });
  }

  it("drops the Secrets row and draws the host's page when it runs Personal without the list", async () => {
    await mountAnsweredThenOffline();

    takeWindowHostOnline({ "environment.status": 1 });

    await waitFor(() => {
      expect(secretsRow()).toBeNull();
    });
    expect(
      await screen.findByRole("heading", { name: "Secrets" }),
    ).toBeTruthy();
    expect(await screen.findByText(SECRETS_DESCRIPTION)).toBeTruthy();
    expect(screen.queryByTestId("personal-source-loading")).toBeNull();
  });

  it("keeps the Secrets row when it serves the list", async () => {
    await mountAnsweredThenOffline();

    takeWindowHostOnline({ "environment.status": 1, [SECRETS_LIST]: 1 });

    expect(await screen.findByText("OPENAI_API_KEY")).toBeTruthy();
    expect(secretsRow()).not.toBeNull();
    expect(screen.queryByTestId("personal-source-loading")).toBeNull();
  });
});
