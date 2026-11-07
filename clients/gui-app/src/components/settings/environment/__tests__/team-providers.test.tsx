import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentConfigurationItem } from "@traycer/protocol/host/environment/configuration-contracts";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
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
  configurationItem,
  mountTeamPage,
  personalPoolSource,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";

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
  useSettingsEnvironmentPickStore.setState({ pick: null });
  setSystemTabModalApi(null);
});

const profile = (enabled: boolean, revision: number) =>
  configurationItem({
    kind: "managed_profile",
    key: "claude:prof-1",
    value: {
      name: "Work",
      color: null,
      harnessId: "claude",
      accountIdentity: "ada@example.com",
      needsLink: false,
      enabled,
    },
    revision,
  });

const envOverride = (value: string, revision: number) =>
  configurationItem({
    kind: "env_override",
    key: "claude:ANTHROPIC_BASE_URL",
    os: "any",
    value: { value },
    revision,
  });

const pack = (pinnedVersion: string | null, revision: number) =>
  configurationItem({
    kind: "pack_policy",
    key: "claude-pack",
    value: { pinnedVersion, autoDownload: true },
    revision,
  });

const environments = {
  environments: [
    {
      environmentId: "env-a",
      ownerKind: "organization" as const,
      ownerId: "team-a",
      roomId: "room-a",
      label: "Acme",
      effectiveRole: "editor" as const,
      kind: "team" as const,
      hostCount: 0,
      providerHandle: "handle-a",
    },
  ],
};

/** A `providers.list` row whose Env override only reaches Traycer's own
 *  native config (MCP setup), never the provider's conversations - Cursor's
 *  actual `envOverrideScope`, as `providerNativeConfigOnlyEnvSubtitle` names
 *  it. */
function cursorProviderListRow(): ProviderCliState {
  return {
    providerId: "cursor",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      ...DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
      envOverrideScope: "native-config-only",
    },
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

const cursorProfile = (name: string, revision: number) =>
  configurationItem({
    kind: "managed_profile",
    key: `cursor:${name}`,
    value: {
      name,
      color: null,
      harnessId: "cursor",
      accountIdentity: null,
      needsLink: false,
      enabled: true,
    },
    revision,
  });

const cursorKey = {
  secretId: "secret-cursor",
  name: "CURSOR_API_KEY",
  kind: "provider" as const,
  protocol: null,
  destinations: [],
  ...RETIRED_SECRET_ROW_FIELDS,
  providerVariables: [...RETIRED_PROVIDER_VARIABLES],
  currentVersionId: "v1",
  revoked: false,
  updatedAt: 1,
  variables: [],
};

function publishSettingsApi(
  setSection: (section: SettingsSectionId) => void,
): void {
  setSystemTabModalApi({
    active: null,
    openSettings: () => undefined,
    openHistory: () => undefined,
    close: () => undefined,
    setSection,
    replaceOwnedSettingsRoute: () => undefined,
    promoteToTab: () => undefined,
    isOverlayActive: () => true,
  });
}

async function openProfileMore(name: string): Promise<void> {
  const trigger = await screen.findByRole("button", {
    name: `More for ${name}`,
  });
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("menu");
}

async function activateProfileMenuRow(name: string): Promise<void> {
  const menu = screen.getByRole("menu");
  const rows = Array.from(
    menu.querySelectorAll<HTMLElement>(
      '[role="menuitem"], [role="menuitemcheckbox"]',
    ),
  );
  const target = rows.find(
    (row) =>
      row.getAttribute("aria-label") === name ||
      row.textContent.trim() === name,
  );
  if (target === undefined) throw new Error(`missing menu row: ${name}`);
  const targetIndex = rows.indexOf(target);
  for (let index = 0; index < targetIndex; index += 1) {
    await userEvent.keyboard("{ArrowDown}");
  }
  await userEvent.keyboard("{Enter}");
}

function railButton(name: string): HTMLElement {
  const rail = screen.getByRole("navigation", { name: "Configured providers" });
  return within(rail).getByRole("button", { name: new RegExp(`^${name}`) });
}

/** Name and subtitle are sibling spans, so `textContent` has no space between them. */
function railPieces(name: string): { title: string; subtitle: string | null } {
  const spans = [...railButton(name).querySelectorAll(":scope > span")];
  const title = (spans[0]?.textContent ?? "").replace(/\s+/g, " ").trim();
  const subtitle =
    spans.length < 2
      ? null
      : (spans[1]?.textContent ?? "").replace(/\s+/g, " ").trim();
  return { title, subtitle };
}

function handlers(items: () => EnvironmentConfigurationItem[]) {
  return {
    "environment.configuration.items": () => ({ items: items() }),
    "environment.list": () => environments,
    "environment.host.list": () => ({ hosts: [] }),
    "environment.plans.list": () => ({ plans: [] }),
    "environment.secrets.list": () => ({ secrets: [], removed: [] }),
    "environment.members": () => ({
      members: [],
      nextCursor: null,
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    }),
  } as const;
}

describe("TeamProviders items", () => {
  it("puts configured providers first, folds the rest, and follows the first configured row until a click", async () => {
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
      await screen.findByText(
        "Sign-ins, keys and tools for each coding agent.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    const rail = await screen.findByRole("navigation", {
      name: "Configured providers",
    });
    await waitFor(() => {
      expect(railButton("Codex").getAttribute("aria-current")).toBe("true");
    });
    expect(railPieces("Codex")).toEqual({ title: "Codex", subtitle: null });
    expect(railButton("Codex").className).toContain("whitespace-normal");
    expect(railButton("Codex").className).toContain("break-words");
    expect(railButton("Codex").className).not.toContain("truncate");
    expect(railPieces("Cursor")).toEqual({ title: "Cursor", subtitle: null });
    expect(
      within(rail).queryByRole("button", { name: /^Claude Code/ }),
    ).toBeNull();
    expect(rail.textContent).not.toContain("plan");
    expect(rail.textContent).not.toContain("key");
    expect(rail.textContent).not.toContain("No profiles");
    const callsBeforeToggle = harness.messenger.calls.length;
    const add = within(rail).getByRole("button", { name: "Add provider" });
    expect(add.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(add);
    expect(harness.messenger.calls.length).toBe(callsBeforeToggle);
    expect(add.getAttribute("aria-expanded")).toBe("true");
    expect(railPieces("Claude Code")).toEqual({
      title: "Claude Code",
      subtitle: null,
    });
    await userEvent.click(railButton("Claude Code"));
    expect(railButton("Claude Code").getAttribute("aria-current")).toBe("true");
    expect(railButton("Codex").getAttribute("aria-current")).toBeNull();
    expect(railButton("Claude Code")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open Secrets" }));
    expect(setSection).toHaveBeenCalledWith("secrets");
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
      name: "Configured providers",
    });
    expect(
      within(rail).queryByRole("button", { name: "Add provider" }),
    ).toBeNull();
    expect(
      within(rail).getByRole("button", { name: "Command Code" }),
    ).toBeTruthy();
    expect(railButton("Claude Code").getAttribute("aria-current")).toBe("true");

    plans.resolve({ plans: [] });

    const add = await within(rail).findByRole("button", {
      name: "Add provider",
    });
    expect(add.getAttribute("aria-expanded")).toBe("false");
    expect(
      within(rail).queryByRole("button", { name: "Command Code" }),
    ).toBeNull();
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
      name: "Configured providers",
    });
    await waitFor(() => {
      expect(railButton("Cursor").getAttribute("aria-current")).toBe("true");
    });
    expect(railPieces("Cursor")).toEqual({
      title: "Cursor",
      subtitle: "2 profiles",
    });
    expect(
      within(rail).queryByRole("button", { name: /^Claude Code/ }),
    ).toBeNull();
    expect(rail.textContent).not.toContain("plan");
    expect(rail.textContent).not.toContain("key");
    expect(rail.textContent).not.toContain("No profiles");
    await userEvent.click(
      within(rail).getByRole("button", { name: "Add provider" }),
    );
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
      name: "Configured providers",
    });
    await waitFor(() => {
      expect(railButton("Cursor").getAttribute("aria-current")).toBe("true");
    });
    expect(railPieces("Cursor")).toEqual({ title: "Cursor", subtitle: null });
    expect(
      within(rail).queryByRole("button", { name: /^Claude Code/ }),
    ).toBeNull();
    await userEvent.click(
      within(rail).getByRole("button", { name: "Add provider" }),
    );
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
      name: "Configured providers",
    });
    await waitFor(() => {
      expect(railButton("Codex").getAttribute("aria-current")).toBe("true");
    });
    expect(railPieces("Codex")).toEqual({ title: "Codex", subtitle: null });
    expect(within(rail).queryByRole("button", { name: /^Cursor/ })).toBeNull();
    expect(
      within(rail).queryByRole("button", { name: /^Claude Code/ }),
    ).toBeNull();
  });

  it("keeps every Personal provider on the rail while its secrets read is out, then folds the empty ones", async () => {
    const secrets = Promise.withResolvers<{ secrets: []; removed: [] }>();
    const harness = mountTeamPage(personalPoolSource(), {
      ...handlers(() => []),
      "environment.secrets.list": () => secrets.promise,
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const rail = await screen.findByRole("navigation", {
      name: "Configured providers",
    });
    expect(
      within(rail).queryByRole("button", { name: "Add provider" }),
    ).toBeNull();
    expect(
      within(rail).getByRole("button", { name: "Command Code" }),
    ).toBeTruthy();

    secrets.resolve({ secrets: [], removed: [] });

    await within(rail).findByRole("button", { name: "Add provider" });
    expect(
      within(rail).queryByRole("button", { name: "Command Code" }),
    ).toBeNull();
    expect(railButton("Claude Code").getAttribute("aria-current")).toBe("true");
  });

  it("orders Plans & limits as Key, Plans, Profiles, then rate limits", async () => {
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
    expect(screen.queryByRole("heading", { name: "Key" })).toBeTruthy();
    const panel = screen.getByRole("tabpanel");
    const labels = ["Key", "Plans", "Profiles", "Rate limits"].map((name) =>
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
    expect(
      labels[2]?.compareDocumentPosition(labels[3] ?? labels[2]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(panel).getByRole("region", { name: "Key" })).toBeTruthy();
    expect(within(panel).getByRole("region", { name: "Plans" })).toBeTruthy();
    expect(harness.paramsOf("environment.secrets.list").length).toBeGreaterThan(
      0,
    );
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
    await openProfileMore("Work");
    const checkboxItem = screen.getByRole("menuitemcheckbox", {
      name: "Use Work",
    });
    expect(checkboxItem.getAttribute("aria-checked")).toBe("true");
    await activateProfileMenuRow("Use Work");

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
        },
        revision: 4,
      },
    ]);
    expect(
      await screen.findByText("Changed by Grace a moment ago"),
    ).toBeTruthy();
    expect(screen.getByText("Off")).toBeTruthy();
    if (screen.queryByRole("menu") !== null) {
      await userEvent.keyboard("{Escape}");
    }
    await openProfileMore("Work");
    await waitFor(() => {
      const updatedCheckboxItem = screen.getByRole("menuitemcheckbox", {
        name: "Use Work",
      });
      expect(updatedCheckboxItem.getAttribute("aria-checked")).toBe("false");
    });
  });

  it("gives a viewer On/Off for a profile with no switch, plus the member-only verbs withheld", async () => {
    const harness = mountTeamPage(
      poolSource("viewer"),
      handlers(() => [profile(true, 4)]),
    );
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const name = await screen.findByText("Work");
    expect(name.className).toContain("whitespace-normal");
    expect(name.className).toContain("break-words");
    expect(name.className).not.toContain("truncate");
    expect(screen.getByText("ada@example.com").className).toContain(
      "whitespace-normal",
    );
    expect(screen.queryByText("Off")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Key" })).toBeNull();
    await openProfileMore("Work");
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a key" })).toBeNull();
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
      await screen.findByRole("button", {
        name: "Edit claude:ANTHROPIC_BASE_URL value",
      }),
    );
    const field = await screen.findByLabelText(
      "claude:ANTHROPIC_BASE_URL value",
    );
    await userEvent.clear(field);
    await userEvent.type(field, "https://new.example");
    const row = screen.getByRole("region", {
      name: "claude:ANTHROPIC_BASE_URL",
    });
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));

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
      await screen.findByRole("button", {
        name: "Edit claude:ANTHROPIC_BASE_URL value",
      }),
    );
    const field = await screen.findByLabelText(
      "claude:ANTHROPIC_BASE_URL value",
    );
    await userEvent.clear(field);
    await userEvent.type(field, "https://new.example");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const refreshed = "Saved, but latest settings haven't refreshed.";
    expect(await screen.findByText(refreshed)).toBeTruthy();

    await userEvent.click(railButton("Cursor"));
    await userEvent.click(await screen.findByRole("tab", { name: "Env" }));
    expect(screen.queryByText(refreshed)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    await userEvent.click(railButton("Claude Code"));
    await userEvent.click(await screen.findByRole("tab", { name: "Env" }));
    expect(screen.getByText(refreshed)).toBeTruthy();
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
    expect(subtitle.textContent).toMatch(
      /^Set for .+ each time it starts, on every host running Acme\. Unset removes a variable .+ would otherwise get from the shell\.$/,
    );
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
    expect(subtitle.textContent).toBe(
      "Set for Claude Code on every host running Acme. Unset removes a variable Claude Code would otherwise get from the shell.",
    );
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
      await screen.findByRole("button", { name: "Add provider" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^Cursor/ }),
    );
    await userEvent.click(await screen.findByRole("tab", { name: "Env" }));

    const subtitle = await screen.findByTestId("team-provider-env-subtitle");
    expect(subtitle.textContent).toBe(
      "Set for Cursor when Traycer sets up its tools, such as MCP servers, on every host running Acme. Cursor's conversations don't get them. Unset removes a variable Cursor would otherwise get from the shell.",
    );
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
      await screen.findByRole("button", { name: "Add provider" }),
    );
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

  it("opens a profile's Details on its actual item key", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    // No provider of evidence is registered by the page itself, so the test
    // registers one for the kind and reads the subject the page mounted.
    const provider = vi.fn<DetailsProvider>(() =>
      Promise.reject(new Error("no evidence")),
    );
    const unregister = registerDetailsProvider("managed_profile", provider);
    try {
      const harness = mountTeamPage(
        poolSource("viewer"),
        handlers(() => [profile(true, 4)]),
      );
      render(<TeamProviders />, { wrapper: harness.Wrapper });

      expect(await screen.findByText("Work")).toBeTruthy();
      await openProfileMore("Work");
      await activateProfileMenuRow("Details");

      const drawer = await screen.findByRole("dialog");
      expect(
        within(drawer).getByRole("heading", { name: "Work" }),
      ).toBeTruthy();
      expect(screen.queryByRole("menu")).toBeNull();

      await waitFor(() => {
        expect(provider).toHaveBeenCalled();
      });
      expect(provider.mock.calls[0]?.[0]).toEqual({
        environmentId: "env-a",
        kind: "managed_profile",
        key: "claude:prof-1",
      });
    } finally {
      unregister();
    }
  });
});
