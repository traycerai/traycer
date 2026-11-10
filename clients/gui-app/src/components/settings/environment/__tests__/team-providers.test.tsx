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
      mergedInto: "kept-work",
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
 *  native config (MCP setup), never the provider's conversations. Cursor's
 *  `envOverrideScope` is `native-config-only`. */
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

function railButton(name: string): HTMLElement {
  const rail = screen.getByRole("navigation", { name: "Providers" });
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

/**
 * The name a role query uses. An `aria-hidden` icon's SVG title is in
 * `textContent` and is not part of the name.
 */
function accessibleName(element: HTMLElement): string {
  const clone = element.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return "";
  for (const hidden of clone.querySelectorAll("[aria-hidden='true']")) {
    hidden.remove();
  }
  return clone.textContent.replace(/\s+/g, " ").trim();
}

function teamProfile(input: {
  readonly key: string;
  readonly name: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly mergedInto: string;
  readonly accountIdentity: string | null;
  readonly color?: string | null;
}): EnvironmentConfigurationItem {
  return configurationItem({
    kind: "managed_profile",
    key: input.key,
    revision: input.revision,
    value: {
      name: input.name,
      color: input.color ?? null,
      harnessId: "claude",
      accountIdentity: input.accountIdentity,
      needsLink: false,
      enabled: input.enabled,
      mergedInto: input.mergedInto,
    },
  });
}

function profileTriggerName(profileName: string, disabled: boolean): string {
  return disabled
    ? `Claude Code profile: ${profileName}, Disabled`
    : `Claude Code profile: ${profileName}`;
}

function openProfileMenu(accessibleName: string): HTMLElement {
  const trigger = screen.getByRole("button", { name: accessibleName });
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger);
  return trigger;
}

function profileRowSwitch(profileName: string): HTMLElement {
  return within(
    screen.getByRole("group", { name: `${profileName} profile controls` }),
  ).getByRole("switch", { name: `Allow agents to use ${profileName}` });
}

async function openProfileEditor(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name: "Manage profile" }));
  return screen.findByRole("dialog", { name: "Edit profile" });
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
      await screen.findByText(
        "Sign-ins, keys and tools for each coding agent, on every host running Acme.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Provider" })).toBeTruthy();
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
      screen.queryByRole("menuitem", { name: "Create new profile" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a profile" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Create new profile" }),
    ).toBeNull();

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
