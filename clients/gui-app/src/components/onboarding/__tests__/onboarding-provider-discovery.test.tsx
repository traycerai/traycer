import type {
  ProviderPlugin,
  ProviderSkill,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingProviderDiscovery } from "@/components/onboarding/onboarding-provider-discovery";
import { ProviderList } from "@/components/providers/provider-list";

type NativeListArgs = {
  readonly providerId: string;
  readonly scope: string;
  readonly workspaceRoot: string | null;
  readonly enabled: boolean;
};

const queryMocks = vi.hoisted(() => ({
  skills: undefined as
    | { readonly skills: readonly ProviderSkill[] }
    | undefined,
  plugins: undefined as
    | { readonly plugins: readonly ProviderPlugin[] }
    | undefined,
  skillsPending: false,
  pluginsPending: false,
  skillsError: false,
  pluginsError: false,
  skillCalls: [] as NativeListArgs[],
  pluginCalls: [] as NativeListArgs[],
  skillRefetch: vi.fn(),
  pluginRefetch: vi.fn(),
}));

vi.mock("@/hooks/providers/use-providers-skills-list-query", () => ({
  useProvidersSkillsList: (args: NativeListArgs) => {
    queryMocks.skillCalls.push(args);
    return {
      data: queryMocks.skills,
      isPending: queryMocks.skillsPending,
      isError: queryMocks.skillsError,
      refetch: queryMocks.skillRefetch,
    };
  },
}));

vi.mock("@/hooks/providers/use-providers-plugins-list-query", () => ({
  useProvidersPluginsList: (args: NativeListArgs) => {
    queryMocks.pluginCalls.push(args);
    return {
      data: queryMocks.plugins,
      isPending: queryMocks.pluginsPending,
      isError: queryMocks.pluginsError,
      refetch: queryMocks.pluginRefetch,
    };
  },
}));

function providerState(enabled: boolean, installed: boolean): ProviderCliState {
  return {
    providerId: "codex",
    enabled,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: installed
      ? [
          {
            kind: "bundled",
            path: "/usr/bin/codex",
            version: "1.0.0",
            available: true,
            versionPending: false,
          },
        ]
      : [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
    nativeCapabilities: {
      supportedTabs: ["skills", "plugins"],
      mcp: null,
      skills: {
        actionScopes: {
          list: ["global"],
          add: [],
          create: [],
          import: [],
          remove: [],
        },
      },
      plugins: {
        addModes: ["read-only"],
        marketplaceBrowse: false,
        traycerSessionToolsNotice: false,
        actionScopes: {
          list: ["global"],
          add: [],
          remove: [],
          setEnabled: [],
        },
      },
      modelProviders: null,
    },
  };
}

function plugin(overrides: Partial<ProviderPlugin>): ProviderPlugin {
  return {
    id: "plugin-one",
    name: "plugin-one",
    version: null,
    enabled: true,
    source: null,
    readOnly: true,
    description: null,
    displayName: null,
    hasIcon: false,
    hasDarkIcon: false,
    ...overrides,
  };
}

function renderDiscovery(visible: boolean, state: ProviderCliState) {
  const onSelect = vi.fn();
  const discovery = (
    <OnboardingProviderDiscovery
      state={state}
      visible={visible}
      presentation="popover"
    />
  );
  const view = render(
    <ProviderList
      rows={[
        {
          providerId: "codex",
          active: false,
          dimmed: true,
          enabled: false,
          badge: null,
          description: null,
          trailing: discovery,
          disabledReason: null,
          phoneDescription: null,
          onSelect,
        },
      ]}
      variant="onboarding"
      ariaLabel="Providers"
      className=""
      phone={false}
    />,
  );
  return { ...view, onSelect };
}

describe("OnboardingProviderDiscovery", () => {
  beforeEach(() => {
    queryMocks.skills = undefined;
    queryMocks.plugins = undefined;
    queryMocks.skillsPending = false;
    queryMocks.pluginsPending = false;
    queryMocks.skillsError = false;
    queryMocks.pluginsError = false;
    queryMocks.skillCalls = [];
    queryMocks.pluginCalls = [];
    queryMocks.skillRefetch.mockReset();
    queryMocks.pluginRefetch.mockReset();
  });

  afterEach(cleanup);

  it("counts conflict-free global skills and enabled plugins, while labeling disabled plugins", () => {
    queryMocks.skills = {
      skills: [
        {
          name: "Useful skill",
          description: "Ready to use",
          path: "/global/useful",
          source: "shared",
        },
        {
          name: "Conflicting skill",
          description: null,
          path: "/global/conflict",
          source: "shared",
          conflict: true,
        },
      ],
    };
    queryMocks.plugins = {
      plugins: [
        plugin({ id: "enabled-plugin", displayName: "Enabled plugin" }),
        plugin({
          id: "disabled-plugin",
          name: "disabled-plugin",
          displayName: "Disabled plugin",
          enabled: false,
        }),
      ],
    };
    const { onSelect } = renderDiscovery(true, providerState(true, false));

    expect(
      screen.getByRole("button", { name: "Discoveries for Codex" }).textContent,
    ).toContain("1 skill · 1 plugin enabled");
    expect(queryMocks.skillCalls[0]).toMatchObject({
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
      enabled: true,
    });
    expect(queryMocks.pluginCalls[0]).toMatchObject({
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
      enabled: true,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Discoveries for Codex" }),
    );
    expect(screen.getByText("Useful skill")).toBeTruthy();
    expect(screen.queryByText("Conflicting skill")).toBeNull();
    expect(screen.getByText("Plugins · 1 enabled")).toBeTruthy();
    expect(screen.getByText("Enabled plugin")).toBeTruthy();
    expect(screen.getByText("Disabled plugin")).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Codex", pressed: false }),
    ).toBeTruthy();
  });

  it("shows zero counts for successful empty results", () => {
    queryMocks.skills = { skills: [] };
    queryMocks.plugins = { plugins: [] };
    renderDiscovery(true, providerState(true, false));

    expect(
      screen.getByRole("button", { name: "Discoveries for Codex" }).textContent,
    ).toContain("0 skills · 0 plugins enabled");
    fireEvent.click(
      screen.getByRole("button", { name: "Discoveries for Codex" }),
    );
    expect(screen.getByText("Skills · 0")).toBeTruthy();
    expect(screen.getByText("Plugins · 0 enabled")).toBeTruthy();
  });

  it("shows errors as unavailable instead of reporting false zero counts", () => {
    queryMocks.skillsError = true;
    queryMocks.pluginsError = true;
    renderDiscovery(true, providerState(true, false));

    expect(
      screen.getByRole("button", { name: "Discoveries for Codex" }).textContent,
    ).toContain("Discovery unavailable");
    expect(screen.queryByText("0 skills · 0 plugins enabled")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Discoveries for Codex" }),
    );
    expect(
      screen.getByText("Some discoveries couldn’t be loaded."),
    ).toBeTruthy();
    expect(screen.queryByText("Skills · 0")).toBeNull();
    expect(screen.queryByText("Plugins · 0 enabled")).toBeNull();
  });

  it("does not query discovery for a provider that is neither enabled nor installed", () => {
    render(
      <OnboardingProviderDiscovery
        state={providerState(false, false)}
        visible
        presentation="popover"
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Discoveries for Codex" }),
    ).toBeNull();
    expect(queryMocks.skillCalls[0]?.enabled).toBe(false);
    expect(queryMocks.pluginCalls[0]?.enabled).toBe(false);
  });

  it("queries global discovery for an installed provider even when it is disabled", () => {
    renderDiscovery(true, providerState(false, true));

    expect(queryMocks.skillCalls[0]).toMatchObject({
      scope: "global",
      workspaceRoot: null,
      enabled: true,
    });
    expect(queryMocks.pluginCalls[0]).toMatchObject({
      scope: "global",
      workspaceRoot: null,
      enabled: true,
    });
  });

  it("prefetches without showing a popover trigger when hidden", () => {
    renderDiscovery(false, providerState(true, false));

    expect(
      screen.queryByRole("button", { name: "Discoveries for Codex" }),
    ).toBeNull();
    expect(queryMocks.skillCalls[0]?.enabled).toBe(true);
    expect(queryMocks.pluginCalls[0]?.enabled).toBe(true);
  });
});
