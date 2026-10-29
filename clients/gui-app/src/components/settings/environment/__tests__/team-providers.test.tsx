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
import { reachableHost } from "./mcp-skills-test-support";
import {
  configurationItem,
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

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
 *  it (NEW-154-15 class sweep). */
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
  it("words each rail row from the team's plans and keys: plan, key, no plan", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [profile(true, 4)]),
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
        secrets: [
          {
            secretId: "secret-cursor",
            name: "CURSOR_API_KEY",
            kind: "provider",
            protocol: null,
            destinations: [],
            mode: "brokered",
            state: "live",
            currentVersionId: "v1",
            revoked: false,
            updatedAt: 1,
            variables: [],
            providerVariables: [],
          },
        ],
        removed: [],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const rail = await screen.findByRole("navigation", { name: "Providers" });
    const wordOf = (name: string): string => {
      const row = within(rail).getByRole("button", { name: new RegExp(name) });
      return row.textContent.replace(name, "");
    };
    await waitFor(() => {
      expect(wordOf("Codex")).toBe("plan");
    });
    expect(wordOf("Cursor")).toBe("key");
    expect(within(rail).getAllByText("no plan").length).toBeGreaterThan(0);
    expect(within(rail).queryByText("No profiles")).toBeNull();
    expect(harness.paramsOf("environment.configuration.items")[0]).toEqual({
      environmentId: "env-a",
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

    const toggle = await screen.findByRole("switch", { name: "Use Work" });
    await userEvent.click(toggle);

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
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Use Work" })).toHaveProperty(
        "ariaChecked",
        "false",
      );
    });
  });

  it("gives a viewer On/Off for a profile with no switch, plus the member-only verbs withheld", async () => {
    const harness = mountTeamPage(
      poolSource("viewer"),
      handlers(() => [profile(true, 4)]),
    );
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Work")).toBeTruthy();
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

  it("says on its Env tab that the team's variables reach every host running the team", async () => {
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers(() => [envOverride("https://old.example", 7)]),
    );
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await userEvent.click(await screen.findByRole("tab", { name: "Env" }));

    const subtitle = await screen.findByTestId("team-provider-env-subtitle");
    expect(subtitle.textContent).toMatch(
      /^Set for .+ each time it starts, on every host running Acme\. Unset removes a variable .+ would otherwise get from the shell\.$/,
    );
    expect(subtitle.textContent).not.toContain("Personal");
  });

  it("says on its Env tab that a native-config-only provider's variables never reach its conversations (NEW-154-15)", async () => {
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

      const card = (await screen.findByText("Work")).closest("div.rounded-lg");
      if (!(card instanceof HTMLElement))
        throw new Error("profile row not found");
      await userEvent.click(
        within(card).getByRole("button", { name: "Details" }),
      );

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
