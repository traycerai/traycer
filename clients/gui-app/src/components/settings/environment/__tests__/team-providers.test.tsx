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
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import {
  registerDetailsProvider,
  type DetailsProvider,
} from "@/lib/settings-details-entry";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { providerState, reachableHost } from "./mcp-skills-test-support";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import {
  mountTeamPage,
  personalPoolSource,
  poolSource,
  requireTeamEnvironmentAuthnBinding,
  requireTeamHostClient,
  resetTeamPageHarness,
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

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
  useHostBinding: () => requireTeamEnvironmentAuthnBinding(),
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
  useSettingsEnvironmentPickStore.setState({ pick: null });
  setSystemTabModalApi(null);
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

  it("says on its Env tab that the team's variables reach every host running the team", async () => {
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
    expect(subtitle.textContent).not.toContain("Personal");
  });

  it("names no mechanism on its Env tab while the team has no reachable host to confirm the scope from", async () => {
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers(() => [envOverride("https://old.example", 7)]),
    );
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await userEvent.click(await screen.findByRole("tab", { name: "Env" }));

    const subtitle = await screen.findByTestId("team-provider-env-subtitle");
    expect(subtitle.textContent).toBe("Variables for the selected provider.");
    expect(subtitle.textContent).not.toContain("each time it starts");
    expect(subtitle.textContent).not.toContain("conversations");
  });

  it("says on its Env tab that a native-config-only provider's variables never reach its conversations", async () => {
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
    expect(subtitle.textContent).not.toContain("conversations");
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
