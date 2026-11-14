import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AuthService } from "@/lib/auth/auth-service";
import type { HostRpcRegistry } from "@/lib/host";
import { HostRuntimeContext } from "@/lib/host/runtime";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import {
  configurationItem,
  mountTeamPage,
  personalPoolSource,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";
import {
  negotiateMethods,
  reachableHost,
  WINDOW_HOST_ID,
} from "./mcp-skills-test-support";
import {
  profile,
  cursorProviderListRow,
  cursorKey,
  teamProfile,
  teamProviderProfile,
  profileTriggerName,
  openProfileMenu,
  profileRowSwitch,
  openProfileEditor,
  handlers,
} from "./team-providers-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));
vi.mock("@/components/settings/secrets/secret-row", () => ({
  SecretRow: () => null,
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => () => Promise.resolve(),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({ pick: null });
  setSystemTabModalApi(null);
});

beforeEach(() => {
  resetNegotiatedManifests();
});

describe("TeamProviders profiles", () => {
  it("reads the team's rows by environment and excludes another computer's Personal rows", async () => {
    negotiateMethods({ "environment.providers.list": { major: 1, minor: 0 } });
    const teamRows = [
      teamProviderProfile({
        profileId: "team-signed-in",
        label: "Team signed in",
        authStatus: "authenticated",
        personNotice: null,
        apiKeyConfigured: false,
      }),
      teamProviderProfile({
        profileId: "team-needs-sign-in",
        label: "Team needs sign-in",
        authStatus: "unknown",
        personNotice: "needs-sign-in",
        apiKeyConfigured: false,
      }),
      teamProviderProfile({
        profileId: "team-waiting",
        label: "Team waiting",
        authStatus: "unknown",
        personNotice: "waiting",
        apiKeyConfigured: false,
      }),
      teamProviderProfile({
        profileId: "team-api-key",
        label: "Team API key",
        authStatus: "configured",
        personNotice: null,
        apiKeyConfigured: true,
      }),
    ];
    const personalRow = teamProviderProfile({
      profileId: "personal-only",
      label: "Personal only",
      authStatus: "authenticated",
      personNotice: null,
      apiKeyConfigured: false,
    });
    const futureProviderRow = teamProviderProfile({
      profileId: "future-provider-only",
      label: "Future provider only",
      authStatus: "authenticated",
      personNotice: null,
      apiKeyConfigured: false,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => []),
      "environment.host.list": () => ({ hosts: [reachableHost] }),
      "environment.providers.list": () => ({
        profileSyncEnabled: true,
        providers: [
          { providerId: "future-provider", profiles: [futureProviderRow] },
          { providerId: "claude-code", profiles: teamRows },
        ],
      }),
      "providers.list": () => ({
        providers: [
          {
            ...cursorProviderListRow(),
            providerId: "claude-code",
            profiles: [personalRow],
          },
        ],
        native: null,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const trigger = await screen.findByRole("button", {
      name: "Claude Code profile: Team signed in",
    });
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage" })).toBeTruthy();

    await userEvent.click(trigger);
    expect(screen.getByText("Team needs sign-in")).toBeTruthy();
    expect(screen.getByText("Needs a sign-in")).toBeTruthy();
    expect(screen.getByText("Team waiting")).toBeTruthy();
    expect(screen.getByText("Waiting for Traycer")).toBeTruthy();
    expect(screen.getByText("Team API key")).toBeTruthy();
    expect(screen.queryByText("Personal only")).toBeNull();
    expect(screen.queryByText("Future provider only")).toBeNull();
    expect(harness.paramsOf("environment.providers.list")).toEqual([
      { environmentId: "env-a" },
    ]);
  });

  it("keeps the legacy profile panel when the environment says sync is off", async () => {
    negotiateMethods({ "environment.providers.list": { major: 1, minor: 0 } });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [profile(true, 4)]),
      "environment.providers.list": () => ({
        profileSyncEnabled: false,
        providers: [],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByRole("button", {
        name: profileTriggerName("Work", false),
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a profile" })).toBeNull();
    expect(harness.paramsOf("environment.providers.list")).toEqual([
      { environmentId: "env-a" },
    ]);
  });

  it("keeps legacy rows and sends no environment-profile request before method support is known", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [profile(true, 4)]),
      "environment.providers.list": () => ({
        profileSyncEnabled: true,
        providers: [],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByRole("button", {
        name: profileTriggerName("Work", false),
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a profile" })).toBeNull();
    expect(harness.paramsOf("environment.providers.list")).toEqual([]);
  });

  it("keeps the empty synced state and Add affordance for an editor", async () => {
    negotiateMethods({ "environment.providers.list": { major: 1, minor: 0 } });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => []),
      "environment.providers.list": () => ({
        profileSyncEnabled: true,
        providers: [],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("No profiles yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a profile" })).toBeTruthy();
    expect(harness.paramsOf("environment.providers.list")).toEqual([
      { environmentId: "env-a" },
    ]);
  });

  it("keeps legacy rows when the caller's own 10.11 list omits offersSignIns", async () => {
    negotiateMethods({ "providers.list": { major: 10, minor: 11 } });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [profile(true, 4)]),
      "environment.host.list": () => ({
        hosts: [{ ...reachableHost, hostId: WINDOW_HOST_ID, kind: "team" }],
      }),
      "providers.list": () => ({
        providers: [
          {
            ...cursorProviderListRow(),
            providerId: "claude-code",
            profiles: [
              teamProviderProfile({
                profileId: "computer-profile",
                label: "Computer profile",
                authStatus: "authenticated",
                personNotice: null,
                apiKeyConfigured: false,
              }),
            ],
          },
        ],
        native: null,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByRole("button", {
        name: profileTriggerName("Work", false),
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Computer profile")).toBeNull();
    expect(harness.paramsOf("environment.providers.list")).toEqual([]);
    expect(harness.paramsOf("providers.list")).toEqual([{ native: null }]);
  });

  it("gives a reader shared profile rows without Add, Sign in again or Manage", async () => {
    negotiateMethods({ "environment.providers.list": { major: 1, minor: 0 } });
    const harness = mountTeamPage(poolSource("viewer"), {
      ...handlers(() => []),
      "environment.providers.list": () => ({
        profileSyncEnabled: true,
        providers: [
          {
            providerId: "claude-code",
            profiles: [
              teamProviderProfile({
                profileId: "team-reader-row",
                label: "Team reader row",
                authStatus: "unauthenticated",
                personNotice: "needs-sign-in",
                apiKeyConfigured: false,
              }),
            ],
          },
        ],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByRole("button", {
        name: "Claude Code profile: Team reader row",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Needs a sign-in")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
    expect(harness.paramsOf("environment.providers.list")).toEqual([
      { environmentId: "env-a" },
    ]);
  });

  it("keeps Personal Providers on its existing rows without requesting environment profiles", async () => {
    negotiateMethods({ "environment.providers.list": { major: 1, minor: 0 } });
    const harness = mountTeamPage(personalPoolSource(), {
      ...handlers(() => [profile(true, 4)]),
      "environment.providers.list": () => ({
        profileSyncEnabled: true,
        providers: [
          {
            providerId: "claude-code",
            profiles: [
              teamProviderProfile({
                profileId: "must-not-enter-personal",
                label: "Team only row",
                authStatus: "authenticated",
                personNotice: null,
                apiKeyConfigured: false,
              }),
            ],
          },
        ],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByRole("button", {
        name: profileTriggerName("Work", false),
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Team only row")).toBeNull();
    expect(harness.paramsOf("environment.providers.list")).toEqual([]);
  });

  it("keeps the plan label, standing and quota while synced team admins lose Link and Unlink", async () => {
    negotiateMethods({ "environment.providers.list": { major: 1, minor: 0 } });
    const harness = mountTeamPage(poolSource("admin"), {
      ...handlers(() => []),
      "environment.providers.list": () => ({
        profileSyncEnabled: true,
        providers: [
          {
            providerId: "claude-code",
            profiles: [
              teamProviderProfile({
                profileId: "team-plan-row",
                label: "Team plan row",
                authStatus: "authenticated",
                personNotice: null,
                apiKeyConfigured: false,
              }),
            ],
          },
        ],
      }),
      "environment.plans.list": () => ({
        plans: [
          {
            profileId: "plan-claude",
            harness: "claude",
            status: "linked" as const,
            linkedBy: { name: "Ada", you: false },
          },
        ],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const plans = await screen.findByRole("region", { name: "Plans" });
    expect(
      within(plans).getByRole("combobox", { name: "Linked plan" }),
    ).toBeTruthy();
    expect(within(plans).getByText("Signed in")).toBeTruthy();
    expect(
      within(plans).getByText(
        "Shared Claude Code quota. Sandbox charges use Acme credits.",
      ),
    ).toBeTruthy();
    expect(
      within(plans).queryByRole("button", { name: "Link a plan" }),
    ).toBeNull();
    expect(within(plans).queryByRole("button", { name: "Unlink" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add a profile" })).toBeTruthy();
    expect(harness.paramsOf("environment.plans.list")).toEqual([
      { environmentId: "env-a" },
    ]);
  });

  it("toggles a synced row through its own harness and dotted profile item key, then rereads", async () => {
    negotiateMethods({ "environment.providers.list": { major: 1, minor: 0 } });
    const stored = {
      name: "Shared Work",
      color: null,
      harnessId: "claude",
      accountIdentity: "Shared identity",
      needsLink: false,
      enabled: true,
      mergedInto: "canonical-shared-work",
    };
    const row = configurationItem({
      kind: "managed_profile",
      key: "claude:profile.with.dots",
      value: stored,
      revision: 9,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [row]),
      "environment.providers.list": () => ({
        profileSyncEnabled: true,
        providers: [
          {
            providerId: "claude-code",
            profiles: [
              teamProviderProfile({
                profileId: "profile.with.dots",
                label: "Shared Work",
                authStatus: "authenticated",
                personNotice: null,
                apiKeyConfigured: false,
              }),
            ],
          },
        ],
      }),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 10,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const enabledSwitch = await screen.findByRole("switch", {
      name: "Allow agents to use Shared Work",
    });
    const reads = harness.paramsOf("environment.configuration.items").length;
    await userEvent.click(enabledSwitch);

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:profile.with.dots",
          os: null,
          value: { ...stored, enabled: false },
          revision: 9,
        },
      ]);
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(reads);
    });
  });

  it("toggles a profile against the displayed revision, and a conflict rereads it beside the changed-by line", async () => {
    let current = profile(true, 4);
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [current]),
      "environment.configuration.items.put": () => {
        current = profile(false, 5);
        return {
          outcome: "conflict",
          current: { revision: 5, changedBy: "Grace", changedAt: 2 },
        };
      },
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Work")).toBeTruthy();
    const checkboxItem = screen.getByRole("switch", {
      name: "Allow agents to use Work",
    });
    expect(checkboxItem.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(checkboxItem);

    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "managed_profile",
        key: "claude:prof-1",
        os: null,
        value: {
          name: "Work",
          color: null,
          harnessId: "claude",
          accountIdentity: "ada@example.com",
          needsLink: false,
          enabled: false,
          mergedInto: "kept-work",
        },
        revision: 4,
      },
    ]);
    expect(
      await screen.findByText("Changed by Grace a moment ago"),
    ).toBeTruthy();
    expect(screen.queryByText("Off")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: profileTriggerName("Work", true),
      }),
    ).toBeTruthy();
    await waitFor(() => {
      const updatedCheckboxItem = screen.getByRole("switch", {
        name: "Allow agents to use Work",
      });
      expect(updatedCheckboxItem.getAttribute("aria-checked")).toBe("false");
    });
  });

  it("does not label an editor profile control Use", async () => {
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers(() => [profile(true, 4)]),
    );
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Work")).toBeTruthy();
    expect(screen.queryByText("Use")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Use Work" })).toBeNull();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
  });

  it("lists every team profile and writes each row switch with that item's revision and stored record", async () => {
    const workValue = {
      name: "Work",
      color: null,
      harnessId: "claude",
      accountIdentity: "Work label",
      needsLink: false,
      enabled: true,
      mergedInto: "kept-work",
    };
    const homeValue = {
      name: "Home",
      color: null,
      harnessId: "claude",
      accountIdentity: "Home label",
      needsLink: false,
      enabled: true,
      mergedInto: "kept-home",
    };
    const work = configurationItem({
      kind: "managed_profile",
      key: "claude:work",
      value: workValue,
      revision: 4,
    });
    const home = configurationItem({
      kind: "managed_profile",
      key: "claude:home",
      value: homeValue,
      revision: 9,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work, home]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 10,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const trigger = await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const account = screen.getByText("Work label");
    expect(
      trigger.compareDocumentPosition(account) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Home label")).toBeNull();
    openProfileMenu(profileTriggerName("Work", false));
    const workRow = screen.getByRole("menuitem", { name: "Work" });
    const homeRow = screen.getByRole("menuitem", { name: "Home" });
    expect(
      workRow.compareDocumentPosition(homeRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: "Add a profile" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a profile" })).toBeNull();

    fireEvent.click(profileRowSwitch("Home"));
    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:home",
          os: null,
          value: { ...homeValue, enabled: false },
          revision: 9,
        },
      ]);
    });
    fireEvent.click(profileRowSwitch("Work"));
    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:home",
          os: null,
          value: { ...homeValue, enabled: false },
          revision: 9,
        },
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...workValue, enabled: false },
          revision: 4,
        },
      ]);
    });
  });

  it("gives a viewer On/Off for a profile with no switch, plus the member-only verbs withheld", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      ...handlers(() => [profile(true, 4)]),
      "environment.secrets.list": () => ({
        secrets: [
          cursorKey,
          { ...cursorKey, secretId: "second-key", name: "OPENAI_API_KEY" },
        ],
        removed: [],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const identity = await screen.findByText("ada@example.com");
    expect(identity.className).toContain("whitespace-normal");
    expect(identity.className).toContain("break-words");
    expect(screen.queryByText("Off")).toBeNull();
    expect(screen.queryByText("Use")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Key" })).toBeNull();
    expect(screen.queryByText("CURSOR_API_KEY")).toBeNull();
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.queryByText("Signed in")).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Secrets" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Profile" })).toBeNull();
    expect(
      screen.getByRole("button", { name: profileTriggerName("Work", false) }),
    ).toBeTruthy();
  });

  it("lets a reader select a disabled profile and keeps On or Off with no Manage", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      ...handlers(() => [
        teamProfile({
          key: "claude:work",
          name: "Work",
          revision: 4,
          enabled: true,
          mergedInto: "kept-work",
          accountIdentity: "Work label",
        }),
        teamProfile({
          key: "claude:home",
          name: "Home",
          revision: 8,
          enabled: false,
          mergedInto: "kept-home",
          accountIdentity: "Home label",
        }),
      ]),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    expect(screen.queryByRole("button", { name: "Manage profile" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    openProfileMenu(profileTriggerName("Work", false));
    const homeGroup = screen.getByRole("group", {
      name: "Home profile controls",
    });
    expect(within(homeGroup).getByText("Off")).toBeTruthy();
    expect(within(homeGroup).queryByRole("switch")).toBeNull();
    const homeRow = within(homeGroup).getByRole("menuitem", {
      name: "Home, Disabled",
    });
    expect(homeRow.getAttribute("aria-disabled")).not.toBe("true");
    const workGroup = screen.getByRole("group", {
      name: "Work profile controls",
    });
    expect(within(workGroup).getByText("On")).toBeTruthy();
    expect(within(workGroup).queryByRole("switch")).toBeNull();
    fireEvent.click(homeRow);

    expect(
      await screen.findByRole("button", {
        name: profileTriggerName("Home", true),
      }),
    ).toBeTruthy();
    expect(screen.getByText("Home label")).toBeTruthy();
    expect(screen.queryByText("Work label")).toBeNull();
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a profile" })).toBeNull();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
  });

  it("renames the selected profile through Manage and keeps the stored record", async () => {
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 4,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 5,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    expect(within(dialog).getByText("Update how Work appears.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Desk" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: {
            name: "Desk",
            color: null,
            harnessId: "claude",
            accountIdentity: "Work label",
            needsLink: false,
            enabled: true,
            mergedInto: "kept-work",
          },
          revision: 4,
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Edit profile" })).toBeNull();
    });
  });

  it("recolors the selected profile through Manage and warns when another profile uses that color", async () => {
    const sharedColor = "#3b82f6";
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 6,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const home = teamProfile({
      key: "claude:home",
      name: "Home",
      revision: 2,
      enabled: true,
      mergedInto: "kept-home",
      accountIdentity: "Home label",
      color: sharedColor,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work, home]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 7,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    expect(within(dialog).queryByText(/already uses this color/)).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: `Use color ${sharedColor}` }),
    );
    expect(
      within(dialog).getByText(/Home already uses this color/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: {
            name: "Work",
            color: sharedColor,
            harnessId: "claude",
            accountIdentity: "Work label",
            needsLink: false,
            enabled: true,
            mergedInto: "kept-work",
          },
          revision: 6,
        },
      ]);
    });
  });

  it("removes the selected profile through Manage at its revision", async () => {
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 11,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work]),
      "environment.configuration.items.delete": () => ({
        outcome: "saved",
        revision: null,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove profile" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Remove Work?",
    });
    expect(
      within(confirm).getByText("Remove this profile from the team."),
    ).toBeTruthy();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Remove" }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.delete"),
      ).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          revision: 11,
        },
      ]);
    });
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
  });

  it("refuses a blank profile name and a name past 64 characters, and saves a name at the limit", async () => {
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 3,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const limit = "a".repeat(64);
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 4,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    const nameField = within(dialog).getByLabelText("Profile name");
    expect(nameField).toHaveProperty("maxLength", 64);
    fireEvent.change(nameField, { target: { value: "   " } });
    expect(
      within(dialog).getByRole("button", { name: "Save changes" }),
    ).toHaveProperty("disabled", true);
    fireEvent.change(nameField, { target: { value: "a".repeat(65) } });
    expect(nameField).toHaveProperty("value", "a".repeat(65));
    expect(
      within(dialog).getByRole("button", { name: "Save changes" }),
    ).toHaveProperty("disabled", true);
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
    fireEvent.change(nameField, { target: { value: limit } });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: {
            name: limit,
            color: null,
            harnessId: "claude",
            accountIdentity: "Work label",
            needsLink: false,
            enabled: true,
            mergedInto: "kept-work",
          },
          revision: 3,
        },
      ]);
    });
  });

  it("leaves the edit dialog open when a rename conflicts", async () => {
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 4,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work]),
      "environment.configuration.items.put": () => ({
        outcome: "conflict",
        current: { revision: 5, changedBy: "Nora", changedAt: 2 },
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Desk" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    expect(
      await screen.findByText("Changed by Nora a moment ago"),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Edit profile" })).toBeTruthy();
    expect(screen.getByLabelText("Profile name")).toHaveProperty(
      "value",
      "Desk",
    );
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "managed_profile",
        key: "claude:work",
        os: null,
        value: {
          name: "Desk",
          color: null,
          harnessId: "claude",
          accountIdentity: "Work label",
          needsLink: false,
          enabled: true,
          mergedInto: "kept-work",
        },
        revision: 4,
      },
    ]);
    expect(harness.paramsOf("environment.configuration.items.delete")).toEqual(
      [],
    );
  });

  it("retries a rename after a conflict with the colour from the re-read", async () => {
    const stored = {
      name: "Work",
      color: null,
      harnessId: "claude",
      accountIdentity: "Work label",
      needsLink: false,
      enabled: true,
      mergedInto: "kept-work",
    };
    const teammateColor = "#3b82f6";
    const reread = { ...stored, color: teammateColor };
    let current = teamProfile({
      key: "claude:work",
      name: stored.name,
      revision: 4,
      enabled: stored.enabled,
      mergedInto: stored.mergedInto,
      accountIdentity: stored.accountIdentity,
      color: stored.color,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [current]),
      "environment.configuration.items.put": () => {
        if (current.revision === 4) {
          current = teamProfile({
            key: "claude:work",
            name: reread.name,
            revision: 5,
            enabled: reread.enabled,
            mergedInto: reread.mergedInto,
            accountIdentity: reread.accountIdentity,
            color: reread.color,
          });
          return {
            outcome: "conflict",
            current: { revision: 5, changedBy: "Nora", changedAt: 2 },
          };
        }
        return { outcome: "saved", revision: 6 };
      },
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    const reads = harness.paramsOf("environment.configuration.items").length;
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Desk" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(
      await screen.findByText("Changed by Nora a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(reads);
    });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...stored, name: "Desk" },
          revision: 4,
        },
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...reread, name: "Desk" },
          revision: 5,
        },
      ]);
    });
  });

  it("retries a recolor after a conflict with the name from the re-read", async () => {
    const stored = {
      name: "Work",
      color: null,
      harnessId: "claude",
      accountIdentity: "Work label",
      needsLink: false,
      enabled: true,
      mergedInto: "kept-work",
    };
    const pickedColor = "#ef4444";
    const reread = { ...stored, name: "Home" };
    let current = teamProfile({
      key: "claude:work",
      name: stored.name,
      revision: 4,
      enabled: stored.enabled,
      mergedInto: stored.mergedInto,
      accountIdentity: stored.accountIdentity,
      color: stored.color,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [current]),
      "environment.configuration.items.put": () => {
        if (current.revision === 4) {
          current = teamProfile({
            key: "claude:work",
            name: reread.name,
            revision: 5,
            enabled: reread.enabled,
            mergedInto: reread.mergedInto,
            accountIdentity: reread.accountIdentity,
            color: reread.color,
          });
          return {
            outcome: "conflict",
            current: { revision: 5, changedBy: "Nora", changedAt: 2 },
          };
        }
        return { outcome: "saved", revision: 6 };
      },
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    const reads = harness.paramsOf("environment.configuration.items").length;
    await userEvent.click(
      within(dialog).getByRole("button", { name: `Use color ${pickedColor}` }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(
      await screen.findByText("Changed by Nora a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(reads);
    });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...stored, color: pickedColor },
          revision: 4,
        },
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...reread, color: pickedColor },
          revision: 5,
        },
      ]);
    });
  });
});
