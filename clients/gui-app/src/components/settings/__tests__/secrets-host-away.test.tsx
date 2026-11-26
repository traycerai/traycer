import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { resetEnvironmentSectionReads } from "@/components/settings/__tests__/environment-section-reads-fixture";
import { queryReadSignal } from "@/components/settings/personal/__tests__/query-read-signal";
import {
  mountSettings,
  type MountedSettings,
  offlineWindowHost,
  onlineWindowHost,
  resetWindowHost,
  SECRETS_LIST,
  takeWindowHostOffline,
  takeWindowHostOnline,
} from "@/components/settings/__tests__/secrets-host-away-support";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

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
const SECRETS_NAME = "OPENAI_API_KEY";
const secretsRow = (): Element | null =>
  screen.queryByTestId("settings-sidebar-item-secrets");

describe("Personal's Secrets under a window host that is listed but offline", () => {
  it("offers the Secrets row and draws the cloud page with Personal picked", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });

    mountSettings({
      host: offlineWindowHost(),
      manifest: null,
      handlers: {},
    });

    await screen.findByTestId("settings-sidebar-item-general");
    expect(secretsRow()).not.toBeNull();
    expect(await screen.findByText(SECRETS_DESCRIPTION)).toBeTruthy();
    // Only the cloud frame lists: the host frame, with no list served, draws
    // the title and description alone.
    expect(await screen.findByText(SECRETS_NAME)).toBeTruthy();
  });

  it("lists the Secrets row on a reachable host that runs Personal and does not serve the list, and reads no list from it", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });

    const { messenger } = mountSettings({
      host: onlineWindowHost(),
      manifest: { "environment.status": 1 },
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ principal: { kind: "personal" } }),
      },
    });

    await screen.findByTestId("settings-sidebar-item-general");
    // The page draws once the host's answer says it runs Personal.
    expect(await screen.findByText(SECRETS_DESCRIPTION)).toBeTruthy();
    expect(messenger.calls.some((call) => call.method === SECRETS_LIST)).toBe(
      false,
    );
    expect(secretsRow()).not.toBeNull();
  });
});

describe("Personal's Secrets once the window host that answered goes offline", () => {
  it("offers the Secrets row and draws the cloud page with its answer still cached", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });

    mountSettings({
      host: onlineWindowHost(),
      manifest: { "environment.status": 1 },
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ principal: { kind: "personal" } }),
      },
    });

    await screen.findByTestId("settings-sidebar-item-general");
    expect(await screen.findByText(SECRETS_DESCRIPTION)).toBeTruthy();
    expect(secretsRow()).not.toBeNull();

    takeWindowHostOffline();

    expect(await screen.findByText(SECRETS_DESCRIPTION)).toBeTruthy();
    expect(await screen.findByText(SECRETS_NAME)).toBeTruthy();
    expect(secretsRow()).not.toBeNull();
  });
});

describe("Personal's Secrets once the window host that went offline comes back", () => {
  async function mountAnsweredThenOffline(): Promise<MountedSettings> {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });
    const mounted = mountSettings({
      host: onlineWindowHost(),
      manifest: { "environment.status": 1 },
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ principal: { kind: "personal" } }),
      },
    });
    await screen.findByTestId("settings-sidebar-item-general");
    expect(await screen.findByText(SECRETS_DESCRIPTION)).toBeTruthy();
    const cloudList = queryReadSignal(
      mounted.queryClient,
      { method: SECRETS_LIST, environmentId: "env-personal" },
      false,
    );
    takeWindowHostOffline();
    await act(async () => {
      await cloudList;
    });
    // The cloud list's row: the reconnect starts from the cloud page.
    expect(screen.getByText(SECRETS_NAME)).toBeTruthy();
    return mounted;
  }

  it("keeps the Secrets row and draws the host's page when it runs Personal without the list", async () => {
    await mountAnsweredThenOffline();

    takeWindowHostOnline({ "environment.status": 1 });

    await waitFor(() => {
      expect(screen.queryByText(SECRETS_NAME)).toBeNull();
    });
    expect(secretsRow()).not.toBeNull();
    expect(
      await screen.findByRole("heading", { name: "Secrets" }),
    ).toBeTruthy();
    expect(await screen.findByText(SECRETS_DESCRIPTION)).toBeTruthy();
  });

  it("keeps the Secrets row when it serves the list", async () => {
    await mountAnsweredThenOffline();

    takeWindowHostOnline({ "environment.status": 1, [SECRETS_LIST]: 1 });

    expect(await screen.findByText(SECRETS_NAME)).toBeTruthy();
    expect(secretsRow()).not.toBeNull();
  });
});
