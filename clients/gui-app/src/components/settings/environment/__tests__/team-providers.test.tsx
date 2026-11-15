import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import {
  registerDetailsProvider,
  type DetailsProvider,
} from "@/lib/settings-details-entry";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { providerState, reachableHost } from "./mcp-skills-test-support";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  ProviderCliState,
  ProvidersBeginApiKeyChangeResponse,
} from "@traycer/protocol/host/provider-schemas";
import { providersSettleApiKeyChangeRequestSchema } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { ConfigurationSourceBoundary } from "@/components/settings/environment/configuration-source-boundary";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { useLocalTeamAdmissionStore } from "@/stores/host/local-team-admission-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { TeamMcpServers } from "@/components/settings/environment/team-mcp-servers";
import {
  mountTeamPage,
  personalPoolSource,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  mountTeamPageWithRealBoundary,
  configurationItem,
  teamProviderKeyHttpBoundary,
  type TeamPageHarness,
} from "./team-configuration-test-support";
import {
  profile,
  envOverride,
  pack,
  cursorProviderListRow,
  cursorProfile,
  cursorKey,
  publishSettingsApi,
  railButton,
  railPieces,
  accessibleName,
  profileTriggerName,
  handlers,
} from "./team-providers-test-support";
import {
  negotiateMethods,
  teamEnvironments,
  WINDOW_HOST_ID,
} from "./mcp-skills-test-support";

const apiKeyPageHost = vi.hoisted((): { hostId: string | null } => ({
  hostId: null,
}));
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
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => apiKeyPageHost.hostId,
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
  apiKeyPageHost.hostId = null;
  useLocalTeamAdmissionStore.setState({ byHost: new Map() });
  useSettingsEnvironmentPickStore.setState({ pick: null });
  setSystemTabModalApi(null);
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.doUnmock("@/lib/host");
  vi.doUnmock("@/lib/host/runtime");
  vi.doUnmock("@/hooks/chats/use-cloud-chat-queries");
  vi.doUnmock("@/hooks/host/use-host-client-for-host-id");
  vi.doUnmock("@/hooks/host/use-addressable-host-id");
  vi.doUnmock("@/components/settings/secrets/secret-row");
  vi.doUnmock("@/lib/links/open-link");
});

describe("TeamProviders items", () => {
  it("shows every provider and follows the first configured row until a click", async () => {
    const setSection = vi.fn<(section: SettingsSectionId) => void>();
    publishSettingsApi(setSection);
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => []),
      "environment.plans.list": () => ({
        plans: [
          {
            profileId: "plan-codex",
            harness: "codex",
            status: "linked" as const,
            linkedBy: { name: "Ada", you: false },
          },
        ],
      }),
      "environment.secrets.list": () => ({
        secrets: [cursorKey],
        removed: [],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByRole("combobox", { name: "Provider" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Sign-ins, keys and tools for each coding agent."),
    ).toBeTruthy();
    const rail = await screen.findByRole("navigation", {
      name: "Providers",
    });
    expect(rail.className).toContain("hidden");
    expect(rail.className).toContain("lg:flex");
    await waitFor(() => {
      expect(railButton("Codex").getAttribute("aria-current")).toBe("true");
    });
    expect(screen.getByRole("combobox", { name: "Linked plan" })).toBeTruthy();
    expect(railPieces("Codex")).toEqual({ title: "Codex", subtitle: null });
    expect(railPieces("Cursor")).toEqual({ title: "Cursor", subtitle: "key" });
    expect(
      within(rail).queryByRole("button", { name: /^Claude Code/ }),
    ).toBeTruthy();
    expect(rail.textContent).not.toContain("plan");
    expect(rail.textContent).not.toContain("No profiles");
    expect(screen.queryByRole("button", { name: "Open Secrets" })).toBeNull();
    expect(
      within(rail).queryByRole("button", { name: "Add provider" }),
    ).toBeNull();
    expect(railPieces("Claude Code")).toEqual({
      title: "Claude Code",
      subtitle: null,
    });
    await userEvent.click(railButton("Claude Code"));
    expect(railButton("Claude Code").getAttribute("aria-current")).toBe("true");
    expect(railButton("Codex").getAttribute("aria-current")).toBeNull();
    expect(railButton("Claude Code")).toBeTruthy();
    expect(setSection).not.toHaveBeenCalled();
    expect(harness.paramsOf("environment.configuration.items")[0]).toEqual({
      environmentId: "env-a",
    });
  });

  it("keeps a provider on the rail while its plan or secrets read is still out", async () => {
    const plans = Promise.withResolvers<{ plans: [] }>();
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => []),
      "environment.plans.list": () => plans.promise,
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const rail = await screen.findByRole("navigation", {
      name: "Providers",
    });
    expect(
      within(rail).queryByRole("button", { name: "Add provider" }),
    ).toBeNull();
    expect(
      within(rail).getByRole("button", { name: "Command Code" }),
    ).toBeTruthy();
    expect(railButton("Claude Code").getAttribute("aria-current")).toBe("true");

    await act(async () => {
      plans.resolve({ plans: [] });
      await plans.promise;
    });
    expect(
      within(rail).queryByRole("button", { name: "Add provider" }),
    ).toBeNull();
    expect(
      within(rail).getByRole("button", { name: "Command Code" }),
    ).toBeTruthy();
    expect(railButton("Claude Code").getAttribute("aria-current")).toBe("true");
    expect(harness.paramsOf("environment.plans.list").length).toBeGreaterThan(
      0,
    );
  });

  it("puts a Personal provider with managed profiles in the configured group", async () => {
    const harness = mountTeamPage(personalPoolSource(), {
      ...handlers(() => [
        cursorProfile("Cursor Work", 1),
        cursorProfile("Cursor Home", 2),
      ]),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const rail = await screen.findByRole("navigation", {
      name: "Providers",
    });
    await waitFor(() => {
      expect(railButton("Cursor").getAttribute("aria-current")).toBe("true");
    });
    expect(railPieces("Cursor")).toEqual({
      title: "Cursor",
      subtitle: null,
    });
    expect(
      within(rail).queryByRole("button", { name: /^Claude Code/ }),
    ).toBeTruthy();
    expect(rail.textContent).not.toContain("plan");
    expect(rail.textContent).not.toContain("key");
    expect(rail.textContent).not.toContain("No profiles");
    await userEvent.click(railButton("Claude Code"));
    expect(railButton("Claude Code").getAttribute("aria-current")).toBe("true");
    expect(railButton("Cursor").getAttribute("aria-current")).toBeNull();
    expect(harness.paramsOf("environment.configuration.items")[0]).toEqual({
      environmentId: "env-personal",
    });
  });

  it("puts a Personal provider with a live key and no profiles in the configured group", async () => {
    const harness = mountTeamPage(personalPoolSource(), {
      ...handlers(() => []),
      "environment.secrets.list": () => ({
        secrets: [cursorKey],
        removed: [],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const rail = await screen.findByRole("navigation", {
      name: "Providers",
    });
    await waitFor(() => {
      expect(railButton("Cursor").getAttribute("aria-current")).toBe("true");
    });
    expect(railPieces("Cursor")).toEqual({ title: "Cursor", subtitle: "key" });
    expect(
      within(rail).queryByRole("button", { name: /^Claude Code/ }),
    ).toBeTruthy();
    expect(railButton("Claude Code").getAttribute("aria-current")).toBeNull();
  });

  it("puts a Personal provider with a linked plan and no profiles in the configured group", async () => {
    const harness = mountTeamPage(personalPoolSource(), {
      ...handlers(() => []),
      "environment.plans.list": () => ({
        plans: [
          {
            profileId: "plan-codex",
            harness: "codex",
            status: "linked" as const,
            linkedBy: { name: "Ada", you: true },
          },
        ],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const rail = await screen.findByRole("navigation", {
      name: "Providers",
    });
    await waitFor(() => {
      expect(railButton("Codex").getAttribute("aria-current")).toBe("true");
    });
    expect(railPieces("Codex")).toEqual({ title: "Codex", subtitle: null });
    expect(
      within(rail).queryByRole("button", { name: /^Cursor/ }),
    ).toBeTruthy();
    expect(
      within(rail).queryByRole("button", { name: /^Claude Code/ }),
    ).toBeTruthy();
  });

  it("keeps every Personal provider visible before and after its secrets read settles", async () => {
    const secrets = Promise.withResolvers<{ secrets: []; removed: [] }>();
    const harness = mountTeamPage(personalPoolSource(), {
      ...handlers(() => []),
      "environment.secrets.list": () => secrets.promise,
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const rail = await screen.findByRole("navigation", {
      name: "Providers",
    });
    expect(
      within(rail).queryByRole("button", { name: "Add provider" }),
    ).toBeNull();
    expect(
      within(rail).getByRole("button", { name: "Command Code" }),
    ).toBeTruthy();

    await act(async () => {
      secrets.resolve({ secrets: [], removed: [] });
      await secrets.promise;
    });
    expect(
      within(rail).getByRole("button", { name: "Command Code" }),
    ).toBeTruthy();
    expect(railButton("Claude Code").getAttribute("aria-current")).toBe("true");
  });

  it("orders Plans & limits as Plans, Profiles, then rate limits", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [cursorProfile("Cursor Work", 1)]),
      "environment.secrets.list": () => ({
        secrets: [cursorKey],
        removed: [],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(railButton("Cursor").getAttribute("aria-current")).toBe("true");
    });
    expect(screen.queryByRole("heading", { name: "Key" })).toBeNull();
    expect(screen.queryByText("CURSOR_API_KEY")).toBeNull();
    const panel = screen.getByRole("tabpanel");
    const labels = ["Plans", "Profiles", "Rate limits"].map((name) =>
      within(panel).getByRole("heading", { name }),
    );
    expect(
      labels[0]?.compareDocumentPosition(labels[1] ?? labels[0]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      labels[1]?.compareDocumentPosition(labels[2] ?? labels[1]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(panel).queryByRole("region", { name: "Key" })).toBeNull();
    expect(within(panel).getByRole("region", { name: "Plans" })).toBeTruthy();
    expect(harness.paramsOf("environment.secrets.list").length).toBeGreaterThan(
      0,
    );
  });

  it("saves a variable override under the provider's prefix at the displayed revision", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [envOverride("https://old.example", 7)]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 8,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await userEvent.click(await screen.findByRole("tab", { name: "Env" }));
    await userEvent.click(
      await screen.findByRole("textbox", {
        name: "Value for ANTHROPIC_BASE_URL",
      }),
    );
    const field = await screen.findByLabelText("Value for ANTHROPIC_BASE_URL");
    await userEvent.clear(field);
    await userEvent.type(field, "https://new.example");
    fireEvent.blur(field);

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "env_override",
          key: "claude:ANTHROPIC_BASE_URL",
          os: "any",
          value: { value: "https://new.example" },
          revision: 7,
        },
      ]);
    });
  });

  it("shows a provider override's awaiting-readback line and Retry only on the provider it belongs to", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [
        envOverride("https://old.example", 7),
        profile(true, 1),
        cursorProfile("Work", 1),
      ]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 8,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await waitFor(() => expect(railButton("Claude Code")).toBeTruthy());
    await userEvent.click(railButton("Claude Code"));
    await userEvent.click(await screen.findByRole("tab", { name: "Env" }));
    await userEvent.click(
      await screen.findByRole("textbox", {
        name: "Value for ANTHROPIC_BASE_URL",
      }),
    );
    const field = await screen.findByLabelText("Value for ANTHROPIC_BASE_URL");
    await userEvent.clear(field);
    await userEvent.type(field, "https://new.example");
    fireEvent.blur(field);
    const refreshed = "Saved, but latest settings haven't refreshed.";
    expect(await screen.findByText(refreshed)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    await userEvent.click(railButton("Cursor"));
    await userEvent.click(await screen.findByRole("tab", { name: "Env" }));
    expect(screen.queryByText(refreshed)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    await userEvent.click(railButton("Claude Code"));
    await userEvent.click(await screen.findByRole("tab", { name: "Env" }));
    expect(screen.getByText(refreshed)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("describes the selected provider's variables on its Env tab with a reachable host", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [envOverride("https://old.example", 7)]),
      "environment.host.list": () => ({ hosts: [reachableHost] }),
      "providers.list": () => ({
        providers: [
          providerState("claude-code", { mcp: false, skills: false }),
        ],
        native: null,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await userEvent.click(await screen.findByRole("tab", { name: "Env" }));

    const subtitle = await screen.findByTestId("team-provider-env-subtitle");
    expect(subtitle.textContent).toBe("Variables for the selected provider.");
  });

  it("describes the selected provider's variables on its Env tab without a reachable host", async () => {
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers(() => [envOverride("https://old.example", 7)]),
    );
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await userEvent.click(await screen.findByRole("tab", { name: "Env" }));

    const subtitle = await screen.findByTestId("team-provider-env-subtitle");
    expect(subtitle.textContent).toBe("Variables for the selected provider.");
  });

  it("describes a native-config-only provider's variables on its Env tab", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => []),
      "environment.host.list": () => ({ hosts: [reachableHost] }),
      "providers.list": () => ({
        providers: [cursorProviderListRow()],
        native: null,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: /^Cursor/ }),
    );
    await userEvent.click(await screen.findByRole("tab", { name: "Env" }));

    const subtitle = await screen.findByTestId("team-provider-env-subtitle");
    expect(subtitle.textContent).toBe("Variables for the selected provider.");
  });

  it("edits a pack policy against its revision for an editor and shows a viewer the text", async () => {
    const editor = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [pack("1.2.0", 3)]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 4,
      }),
    });
    const { unmount } = render(<TeamProviders />, { wrapper: editor.Wrapper });

    await userEvent.click(
      await screen.findByRole("tab", { name: "Pack version" }),
    );
    const field = await screen.findByLabelText("claude-pack pinned version");
    await userEvent.clear(field);
    await userEvent.type(field, "1.3.0");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(editor.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "pack_policy",
        key: "claude-pack",
        os: null,
        value: { pinnedVersion: "1.3.0", autoDownload: true },
        revision: 3,
      },
    ]);

    unmount();
    cleanup();
    resetTeamPageHarness();
    const viewer = mountTeamPage(
      poolSource("viewer"),
      handlers(() => [pack("1.2.0", 3)]),
    );
    render(<TeamProviders />, { wrapper: viewer.Wrapper });
    await userEvent.click(
      await screen.findByRole("tab", { name: "Pack version" }),
    );
    expect(
      await screen.findByText("claude-pack: 1.2.0 · Downloads automatically"),
    ).toBeTruthy();
    expect(screen.queryByLabelText("claude-pack pinned version")).toBeNull();
  });

  it("starts a newly selected provider on Plans & limits when the previous provider's Pack version tab is gone", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => []),
      "environment.host.list": () => ({ hosts: [reachableHost] }),
      "providers.list": () => ({
        providers: [
          {
            ...providerState("claude-code", { mcp: false, skills: false }),
            packId: "claude-pack",
          },
          providerState("codex", { mcp: false, skills: false }),
        ],
        native: null,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("tab", { name: "Pack version" }),
    );
    expect(
      screen
        .getByRole("tab", { name: "Pack version" })
        .getAttribute("aria-selected"),
    ).toBe("true");

    await userEvent.click(
      await screen.findByRole("button", { name: /^Codex/ }),
    );

    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: "Pack version" })).toBeNull();
    });
    const plans = screen.getByRole("tab", { name: "Plans & limits" });
    expect(plans.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("id")).toBe(
      plans.getAttribute("aria-controls"),
    );
  });

  it("opens a variable row's Details on its actual item key, and the profile picker has none", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const provider = vi.fn<DetailsProvider>(() =>
      Promise.reject(new Error("no evidence")),
    );
    const unregister = registerDetailsProvider("env_override", provider);
    try {
      const harness = mountTeamPage(
        poolSource("viewer"),
        handlers(() => [
          profile(true, 4),
          envOverride("https://old.example", 7),
        ]),
      );
      render(<TeamProviders />, { wrapper: harness.Wrapper });

      expect(await screen.findByText("On")).toBeTruthy();
      const profileCombobox = screen.queryByRole("combobox", {
        name: "Profile",
      });
      const profileTrigger = screen.queryByRole("button", {
        name: profileTriggerName("Work", false),
      });
      expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
      expect(screen.queryByText("Signed in")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Manage profile" }),
      ).toBeNull();

      await userEvent.click(await screen.findByRole("tab", { name: "Env" }));
      await userEvent.click(screen.getByRole("button", { name: "Details" }));

      const drawer = await screen.findByRole("dialog");
      expect(
        within(drawer).getByRole("heading", {
          name: "claude:ANTHROPIC_BASE_URL",
        }),
      ).toBeTruthy();
      expect(screen.queryByRole("menu")).toBeNull();

      await waitFor(() => {
        expect(provider).toHaveBeenCalled();
      });
      expect(provider.mock.calls[0]?.[0]).toEqual({
        environmentId: "env-a",
        kind: "env_override",
        key: "claude:ANTHROPIC_BASE_URL",
      });
      expect(profileCombobox).toBeNull();
      expect(profileTrigger).toBeTruthy();
    } finally {
      unregister();
    }
  });

  it("lists every rail row in the Provider select, including one that is not configured", async () => {
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers(() => []),
    );
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const rail = await screen.findByRole("navigation", { name: "Providers" });
    const trigger = screen.getByRole("combobox", { name: "Provider" });
    let wrapper: HTMLElement | null = trigger;
    let phone = false;
    while (wrapper !== null) {
      if (wrapper.className.includes("lg:hidden")) {
        phone = true;
        break;
      }
      wrapper = wrapper.parentElement;
    }
    expect(phone).toBe(true);
    const railNames = within(rail)
      .getAllByRole("button")
      .map((button) => accessibleName(button));
    await userEvent.click(trigger);
    const options = (await screen.findAllByRole("option")).map((option) =>
      accessibleName(option),
    );
    expect(options).toEqual(railNames);
    expect(options).toContain("Command Code");
    expect(
      harness.paramsOf("environment.configuration.items").length,
    ).toBeGreaterThan(0);
  });
});

const API_KEY_TEST_VALUE = "synthetic-key-test-value";
const PAGE_ENVIRONMENT_ID = "env-a";

type KeyAction = "set" | "clear";

type TeamPageRole = "admin" | "editor" | "viewer";

type KeyPageTarget =
  | { readonly kind: "team"; readonly environmentId: string }
  | { readonly kind: "personal" };

interface ProviderKeyPageOptions {
  readonly target: KeyPageTarget;
  readonly role: TeamPageRole;
  readonly row: ProviderCliState;
  readonly begin: ProvidersBeginApiKeyChangeResponse;
  readonly includeBeginMethod: boolean;
  readonly section: SettingsSectionId;
}

interface TeamBoundaryPageOptions {
  readonly target: KeyPageTarget;
  readonly role: TeamPageRole;
  readonly handlers: MockHandlerMap<HostRpcRegistry>;
  readonly section: SettingsSectionId;
  readonly child: ReactNode;
}

function providerRowWithKey(
  recordEnvironmentId: string | null | undefined,
  configured: boolean,
): ProviderCliState {
  return {
    ...cursorProviderListRow(),
    apiKey: {
      supported: true,
      configured,
      source: configured ? "stored" : null,
      ...(recordEnvironmentId === undefined ? {} : { recordEnvironmentId }),
    },
  };
}

function recordBegin(
  environmentId: string,
): ProvidersBeginApiKeyChangeResponse {
  return {
    mode: "record",
    changeToken: "opaque-test-change-token",
    environmentId,
  };
}

function legacyBegin(): ProvidersBeginApiKeyChangeResponse {
  return { mode: "legacy", changeToken: null, environmentId: null };
}

function personalDescriptor(): EnvironmentDescriptorV11 {
  return {
    environmentId: "env-personal",
    ownerKind: "user",
    ownerId: "team-test-user",
    roomId: "personal-room",
    label: "Personal",
    effectiveRole: "owner",
    kind: "personal",
    hostCount: 1,
    providerHandle: null,
  };
}

function providerKeyHandlers(
  row: ProviderCliState,
  begin: ProvidersBeginApiKeyChangeResponse,
): MockHandlerMap<HostRpcRegistry> {
  return {
    ...handlers(() => []),
    "environment.status": () =>
      environmentStatusFixture({
        principal: { kind: "team", teamName: "Acme" },
      }),
    "providers.list": () => ({ providers: [row] }),
    "providers.beginApiKeyChange": () => begin,
    "providers.settleApiKeyChange": () => ({
      state: row,
      result: "installed",
    }),
  };
}

async function renderProviderKeyPage(
  options: ProviderKeyPageOptions,
): Promise<TeamPageHarness> {
  const { target, role, row, begin, includeBeginMethod, section } = options;
  teamProviderKeyHttpBoundary.matchesKey = (key) => key === API_KEY_TEST_VALUE;
  teamProviderKeyHttpBoundary.calls.length = 0;
  const manifest: Record<string, { major: number; minor: number }> = {
    "environment.status": { major: 1, minor: 2 },
    "providers.list": { major: 10, minor: 13 },
    "providers.settleApiKeyChange": { major: 1, minor: 0 },
  };
  if (includeBeginMethod) {
    manifest["providers.beginApiKeyChange"] = { major: 1, minor: 0 };
  }
  negotiateMethods(manifest);
  return renderBoundaryPage({
    target,
    role,
    handlers: providerKeyHandlers(row, begin),
    section,
    child: <TeamProviders />,
  });
}

async function renderBoundaryPage(
  options: TeamBoundaryPageOptions,
): Promise<TeamPageHarness> {
  const { target, role, handlers, section, child } = options;
  apiKeyPageHost.hostId = WINDOW_HOST_ID;
  const environments =
    target.kind === "personal"
      ? [personalDescriptor()]
      : teamEnvironments.environments.map((environment) => ({
          ...environment,
          effectiveRole: role,
        }));
  const harness = mountTeamPageWithRealBoundary({
    ...handlers,
    "environment.list": () => ({ environments }),
  });
  await waitFor(() => {
    expect(useAuthStore.getState().status).toBe("signed-in");
  });
  const userId = useAuthStore.getState().contextMetadata?.userId;
  if (userId === undefined) {
    throw new Error("test session was not verified");
  }
  useLocalTeamAdmissionStore.setState({
    byHost: new Map([
      [mockLocalHostEntry.hostId, { userId, state: "admitted" }],
    ]),
  });
  render(
    <ConfigurationSourceBoundary target={target} section={section}>
      {child}
    </ConfigurationSourceBoundary>,
    { wrapper: harness.Wrapper },
  );
  return harness;
}

async function openCursorKeyField(): Promise<HTMLElement> {
  await screen.findByRole("navigation", { name: "Providers" });
  await userEvent.click(railButton("Cursor"));
  return screen.findByLabelText("API key");
}

function safeInputValue(element: HTMLElement): string | null {
  return element instanceof HTMLInputElement ? element.value : null;
}

function expectSettledKeyChange(
  harness: TeamPageHarness,
  action: KeyAction,
): void {
  expectBeganKeyChange(harness);
  const settleCalls = harness.paramsOf("providers.settleApiKeyChange");
  expect(settleCalls).toHaveLength(1);
  const settled = providersSettleApiKeyChangeRequestSchema.safeParse(
    settleCalls[0],
  );
  expect(
    settled.success &&
      settled.data.providerId === "cursor" &&
      settled.data.action === action &&
      settled.data.recordId === "team-provider-key-record" &&
      settled.data.signInNumber === "3" &&
      settled.data.recordRevision === "5" &&
      settled.data.changeToken === "opaque-test-change-token",
  ).toBe(true);
}

function expectBeganKeyChange(harness: TeamPageHarness): void {
  const beginCalls = harness.paramsOf("providers.beginApiKeyChange");
  expect(beginCalls).toHaveLength(1);
  expect(beginCalls[0]).toEqual({ providerId: "cursor" });
}

function expectNoLegacyKeyCalls(harness: TeamPageHarness): void {
  expect(harness.paramsOf("providers.setApiKey")).toHaveLength(0);
  expect(harness.paramsOf("providers.clearApiKey")).toHaveLength(0);
}

function expectNoKeyRecordChanges(harness: TeamPageHarness): void {
  expect(teamProviderKeyHttpBoundary.calls).toHaveLength(0);
  expect(harness.paramsOf("providers.settleApiKeyChange")).toHaveLength(0);
  expectNoLegacyKeyCalls(harness);
}

async function expectNoFieldAfterCursorSelection(): Promise<void> {
  await screen.findByRole("navigation", { name: "Providers" });
  await userEvent.click(railButton("Cursor"));
  expect(screen.queryByLabelText("API key")).toBeNull();
}

const TEAM_TARGET: KeyPageTarget = {
  kind: "team",
  environmentId: PAGE_ENVIRONMENT_ID,
};
const PERSONAL_TARGET: KeyPageTarget = { kind: "personal" };

async function attemptEnvironmentMismatch(
  action: KeyAction,
  begin: ProvidersBeginApiKeyChangeResponse,
): Promise<void> {
  const harness = await renderProviderKeyPage({
    target: TEAM_TARGET,
    role: "admin",
    row: providerRowWithKey(PAGE_ENVIRONMENT_ID, action === "clear"),
    begin,
    includeBeginMethod: true,
    section: "providers",
  });
  const input = await openCursorKeyField();
  fireEvent.change(input, { target: { value: API_KEY_TEST_VALUE } });
  await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
  const listReadsBefore = harness.paramsOf("providers.list").length;
  const statusReadsBefore = harness.paramsOf("environment.status").length;
  const errorToast = vi.spyOn(toast, "error");

  await userEvent.click(
    screen.getByRole("button", {
      name: action === "set" ? "Save" : "Clear",
    }),
  );

  const expectedFailureCopy =
    action === "set"
      ? "Couldn't save the API key."
      : "Couldn't clear the API key.";
  await waitFor(() => {
    expect(
      errorToast.mock.calls.some(
        ([message]) =>
          typeof message === "string" && message === expectedFailureCopy,
      ),
    ).toBe(true);
    expect(harness.paramsOf("providers.list").length).toBeGreaterThan(
      listReadsBefore,
    );
    expect(harness.paramsOf("environment.status").length).toBeGreaterThan(
      statusReadsBefore,
    );
    expect(harness.queryClient.isFetching()).toBe(0);
  });

  expect(safeInputValue(input) === API_KEY_TEST_VALUE).toBe(true);
  expectBeganKeyChange(harness);
  expectNoKeyRecordChanges(harness);
}

describe("TeamProviders provider-key record guard", () => {
  it.each(["admin", "editor"] as const)(
    "%s can set a key on an admitted computer through the person's session",
    async (role) => {
      const harness = await renderProviderKeyPage({
        target: TEAM_TARGET,
        role,
        row: providerRowWithKey(PAGE_ENVIRONMENT_ID, false),
        begin: recordBegin(PAGE_ENVIRONMENT_ID),
        includeBeginMethod: true,
        section: "providers",
      });
      const input = await openCursorKeyField();
      fireEvent.change(input, { target: { value: API_KEY_TEST_VALUE } });

      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        expectSettledKeyChange(harness, "set");
        expect(harness.queryClient.isFetching()).toBe(0);
      });

      expect(teamProviderKeyHttpBoundary.calls).toHaveLength(1);
      const [call] = teamProviderKeyHttpBoundary.calls;
      expect(
        call.action === "set" &&
          call.routeMatches &&
          call.authorized &&
          call.keyMatches === true,
      ).toBe(true);
      expectNoLegacyKeyCalls(harness);
      expect(safeInputValue(input) === "").toBe(true);
      expect(
        screen.queryByText("You can see Acme's settings but not change them."),
      ).toBeNull();
    },
  );

  it.each(["admin", "editor"] as const)(
    "%s can clear a stored key on an admitted computer through the person's session",
    async (role) => {
      const harness = await renderProviderKeyPage({
        target: TEAM_TARGET,
        role,
        row: providerRowWithKey(PAGE_ENVIRONMENT_ID, true),
        begin: recordBegin(PAGE_ENVIRONMENT_ID),
        includeBeginMethod: true,
        section: "providers",
      });
      await openCursorKeyField();

      await userEvent.click(screen.getByRole("button", { name: "Clear" }));
      await waitFor(() => {
        expectSettledKeyChange(harness, "clear");
        expect(harness.queryClient.isFetching()).toBe(0);
      });

      expect(teamProviderKeyHttpBoundary.calls).toHaveLength(1);
      const [call] = teamProviderKeyHttpBoundary.calls;
      expect(
        call.action === "clear" &&
          call.routeMatches &&
          call.authorized &&
          call.keyMatches === null,
      ).toBe(true);
      expectNoLegacyKeyCalls(harness);
      expect(
        screen.queryByText("You can see Acme's settings but not change them."),
      ).toBeNull();
    },
  );

  it("keeps the key field unavailable to a viewer with a matching live record", async () => {
    const harness = await renderProviderKeyPage({
      target: TEAM_TARGET,
      role: "viewer",
      row: providerRowWithKey(PAGE_ENVIRONMENT_ID, true),
      begin: recordBegin(PAGE_ENVIRONMENT_ID),
      includeBeginMethod: true,
      section: "providers",
    });

    await expectNoFieldAfterCursorSelection();

    expect(harness.paramsOf("providers.beginApiKeyChange")).toHaveLength(0);
    expectNoKeyRecordChanges(harness);
    expect(
      screen.getByText("You can see Acme's settings but not change them."),
    ).toBeTruthy();
  });

  it("hides the field when the computer's key record belongs to another team", async () => {
    const harness = await renderProviderKeyPage({
      target: TEAM_TARGET,
      role: "editor",
      row: providerRowWithKey("env-b", true),
      begin: recordBegin(PAGE_ENVIRONMENT_ID),
      includeBeginMethod: true,
      section: "providers",
    });

    await expectNoFieldAfterCursorSelection();
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));

    expect(harness.paramsOf("providers.beginApiKeyChange")).toHaveLength(0);
    expectNoKeyRecordChanges(harness);
  });

  it.each([undefined, null])(
    "hides the field when the key record environment is %s",
    async (recordEnvironmentId: string | null | undefined) => {
      const harness = await renderProviderKeyPage({
        target: TEAM_TARGET,
        role: "editor",
        row: providerRowWithKey(recordEnvironmentId, true),
        begin: recordBegin(PAGE_ENVIRONMENT_ID),
        includeBeginMethod: true,
        section: "providers",
      });

      await expectNoFieldAfterCursorSelection();
      await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));

      expect(harness.paramsOf("providers.beginApiKeyChange")).toHaveLength(0);
      expectNoKeyRecordChanges(harness);
    },
  );

  it("hides the field when the computer has not negotiated beginApiKeyChange", async () => {
    const harness = await renderProviderKeyPage({
      target: TEAM_TARGET,
      role: "editor",
      row: providerRowWithKey(PAGE_ENVIRONMENT_ID, true),
      begin: recordBegin(PAGE_ENVIRONMENT_ID),
      includeBeginMethod: false,
      section: "providers",
    });

    await expectNoFieldAfterCursorSelection();

    expect(harness.paramsOf("providers.beginApiKeyChange")).toHaveLength(0);
    expectNoKeyRecordChanges(harness);
  });

  it("does not show a team key field for Personal settings", async () => {
    const harness = await renderProviderKeyPage({
      target: PERSONAL_TARGET,
      role: "admin",
      row: providerRowWithKey("env-personal", true),
      begin: recordBegin("env-personal"),
      includeBeginMethod: true,
      section: "providers",
    });

    await expectNoFieldAfterCursorSelection();

    expect(harness.paramsOf("providers.beginApiKeyChange")).toHaveLength(0);
    expectNoKeyRecordChanges(harness);
  });

  it.each([
    { action: "set", begin: recordBegin("env-b") },
    { action: "clear", begin: recordBegin("env-b") },
    { action: "set", begin: legacyBegin() },
    { action: "clear", begin: legacyBegin() },
  ] satisfies readonly {
    action: KeyAction;
    begin: ProvidersBeginApiKeyChangeResponse;
  }[])(
    "keeps the draft and refuses $action for a mismatched or legacy begin answer",
    async ({ action, begin }) => {
      await attemptEnvironmentMismatch(action, begin);
    },
  );

  it("keeps the draft when authn refuses Set after the team's role changes", async () => {
    teamProviderKeyHttpBoundary.status = 403;
    const harness = await renderProviderKeyPage({
      target: TEAM_TARGET,
      role: "admin",
      row: providerRowWithKey(PAGE_ENVIRONMENT_ID, false),
      begin: recordBegin(PAGE_ENVIRONMENT_ID),
      includeBeginMethod: true,
      section: "providers",
    });
    const input = await openCursorKeyField();
    fireEvent.change(input, { target: { value: API_KEY_TEST_VALUE } });
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    const listReadsBefore = harness.paramsOf("providers.list").length;
    const errorToast = vi.spyOn(toast, "error");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(
        errorToast.mock.calls.some(
          ([message]) =>
            typeof message === "string" &&
            message === "You don't have permission to do that.",
        ),
      ).toBe(true);
      expect(harness.paramsOf("providers.list").length).toBeGreaterThan(
        listReadsBefore,
      );
      expect(harness.queryClient.isFetching()).toBe(0);
    });

    expectBeganKeyChange(harness);
    expect(teamProviderKeyHttpBoundary.calls).toHaveLength(1);
    const [call] = teamProviderKeyHttpBoundary.calls;
    expect(
      call.action === "set" &&
        call.routeMatches &&
        call.authorized &&
        call.keyMatches === true,
    ).toBe(true);
    expect(safeInputValue(input) === API_KEY_TEST_VALUE).toBe(true);
    expect(
      errorToast.mock.calls.some(
        ([message]) =>
          typeof message === "string" && message.includes(API_KEY_TEST_VALUE),
      ),
    ).toBe(false);
    expect(harness.paramsOf("providers.settleApiKeyChange")).toHaveLength(0);
    expectNoLegacyKeyCalls(harness);
  });

  it.each(["admin", "editor", "viewer"] as const)(
    "keeps computer-written MCP controls read-only for a %s on another section",
    async (role) => {
      const harness = await renderBoundaryPage({
        target: TEAM_TARGET,
        role,
        handlers: {
          ...handlers(() => []),
          "environment.configuration.items": () => ({
            items: [
              configurationItem({
                kind: "mcp_server",
                key: "github",
                value: {
                  mcpServerId: "server-test",
                  toolToggles: { claude: { search: true } },
                },
              }),
            ],
          }),
        },
        section: "mcp-servers",
        child: <TeamMcpServers />,
      });

      expect(await screen.findByText("github")).toBeTruthy();
      await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
      expect(
        screen.queryByRole("switch", { name: "github claude search" }),
      ).toBeNull();
      expect(
        screen.getByText("You can see Acme's settings but not change them."),
      ).toBeTruthy();
    },
  );
});
