import "../../../../../__tests__/test-browser-apis";
import type {
  ProviderAuth,
  ProviderCliCandidate,
  ProviderCliState,
  ProviderSelection,
} from "@traycer/protocol/host/provider-schemas";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerMocks = vi.hoisted(() => ({
  listResult: {
    data: { providers: [] as ProviderCliState[] },
    isPending: false,
    isError: false,
    isFetching: false,
  },
  setSelectionMutate: vi.fn(),
  addCustomPathMutate: vi.fn(),
  removeCustomPathMutate: vi.fn(),
  setEnabledMutate: vi.fn(),
  setApiKeyMutate: vi.fn(),
  clearApiKeyMutate: vi.fn(),
  setTerminalAgentArgsMutate: vi.fn(),
  setEnvOverrideMutate: vi.fn(),
  deleteEnvOverrideMutate: vi.fn(),
  refreshProviders: vi.fn(() => Promise.resolve()),
  openExternalLink: vi.fn(),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => providerMocks.listResult,
}));

vi.mock("@/hooks/providers/use-providers-set-selection-mutation", () => ({
  useProvidersSetSelection: () => ({
    mutate: providerMocks.setSelectionMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-add-custom-path-mutation", () => ({
  useProvidersAddCustomPath: () => ({
    mutate: providerMocks.addCustomPathMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-remove-custom-path-mutation", () => ({
  useProvidersRemoveCustomPath: () => ({
    mutate: providerMocks.removeCustomPathMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-set-enabled-mutation", () => ({
  useProvidersSetEnabled: () => ({
    mutate: providerMocks.setEnabledMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-set-api-key-mutation", () => ({
  useProvidersSetApiKey: () => ({
    mutate: providerMocks.setApiKeyMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-clear-api-key-mutation", () => ({
  useProvidersClearApiKey: () => ({
    mutate: providerMocks.clearApiKeyMutate,
    isPending: false,
  }),
}));

vi.mock(
  "@/hooks/providers/use-providers-set-terminal-agent-args-mutation",
  () => ({
    useProvidersSetTerminalAgentArgs: () => ({
      mutate: providerMocks.setTerminalAgentArgsMutate,
      isPending: false,
    }),
  }),
);

vi.mock("@/hooks/providers/use-providers-set-env-override-mutation", () => ({
  useProvidersSetEnvOverride: () => ({
    mutate: providerMocks.setEnvOverrideMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-delete-env-override-mutation", () => ({
  useProvidersDeleteEnvOverride: () => ({
    mutate: providerMocks.deleteEnvOverrideMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-detect-version-query", () => ({
  useProvidersDetectVersion: () => ({
    isFetching: false,
    data: undefined,
  }),
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({
    data: { harnesses: [] },
  }),
}));

vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => providerMocks.refreshProviders,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    openExternalLink: providerMocks.openExternalLink,
  }),
}));

// The Traycer provider mounts the subscription card; stub its credits query so
// the real AuthService (which needs a host-runtime provider) isn't invoked.
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: null,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve({}),
  }),
}));

// Pure side-effect hook in the Traycer subscription card; no render output, and
// it needs a QueryClient this harness doesn't set up.
vi.mock("@/hooks/auth/use-refresh-credits-on-traycer-turn", () => ({
  useRefreshCreditsOnTraycerTurn: () => {},
}));

// Rate-limit usage query + its refresh hook (RateLimitView). Same reason:
// no host client/QueryClient in this harness.
vi.mock("@/hooks/host/use-host-rate-limit-usage-query", () => ({
  useHostRateLimitUsageQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/host/use-refresh-rate-limit-usage-on-traycer-turn", () => ({
  useRefreshRateLimitUsageOnTraycerTurn: () => {},
}));

// Host picker plumbing: a single active host and no transient client means
// the panel renders inline (no runtime-context re-provide), and `useHostBinding`
// returns null without a `<HostRuntimeProvider>`.
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "local",
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "local",
        label: "Local host",
        status: "available",
        websocketUrl: "ws://127.0.0.1:0",
      },
    ],
  }),
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));

import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { TooltipProvider } from "@/components/ui/tooltip";

const OPENCODE_CANDIDATES: readonly ProviderCliCandidate[] = [
  {
    kind: "bundled",
    path: "/bundled/opencode",
    version: "1.0.0",
    available: true,
    versionPending: false,
  },
  {
    kind: "path",
    path: "/usr/local/bin/opencode",
    version: "1.1.0",
    available: true,
    versionPending: false,
  },
];

function providerState(input: {
  readonly providerId: ProviderCliState["providerId"];
  readonly selected: ProviderSelection;
  readonly candidates: readonly ProviderCliCandidate[];
  readonly envOverrides: ProviderCliState["envOverrides"];
}): ProviderCliState {
  return {
    providerId: input.providerId,
    enabled: true,
    disabledBy: null,
    selected: input.selected,
    candidates: [...input.candidates],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [...input.envOverrides],
    loginCapability: null,
  };
}

function providerStateWithAuth(
  input: {
    readonly providerId: ProviderCliState["providerId"];
    readonly selected: ProviderSelection;
    readonly candidates: readonly ProviderCliCandidate[];
    readonly envOverrides: ProviderCliState["envOverrides"];
  },
  auth: ProviderAuth,
  authPending: boolean,
): ProviderCliState {
  return { ...providerState(input), auth, authPending };
}

describe("<ProvidersSettingsPanel />", () => {
  beforeEach(() => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "opencode",
          selected: { kind: "bundled" },
          candidates: OPENCODE_CANDIDATES,
          envOverrides: [],
        }),
        providerState({
          providerId: "traycer",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "openrouter",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
      ],
    };
    providerMocks.setSelectionMutate.mockClear();
    providerMocks.setEnabledMutate.mockClear();
    providerMocks.setEnvOverrideMutate.mockClear();
    providerMocks.deleteEnvOverrideMutate.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("lists OpenCode CLI candidates for Traycer and mutates Traycer selection", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Traycer/i }));

    expect(screen.getByText("/usr/local/bin/opencode")).toBeDefined();

    fireEvent.click(
      screen.getByRole("radio", {
        name: "Select /usr/local/bin/opencode",
      }),
    );

    expect(providerMocks.setSelectionMutate).toHaveBeenCalledWith({
      providerId: "traycer",
      selection: { kind: "path" },
    });
  });

  it("orders the provider rail by the default provider order", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "openrouter",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "qwen",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "codex",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "cursor",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "droid",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "kilocode",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "claude-code",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "copilot",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    const nav = screen.getByRole("navigation", { name: "Providers" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Codex",
      "Claude Code",
      "OpenRouter",
      "Droid",
      "Cursor",
      "Copilot",
      "Kilo Code",
      "Qwen Code",
    ]);
  });

  it("renders configured, unavailable, and pending auth statuses", () => {
    providerMocks.listResult.data = {
      providers: [
        providerStateWithAuth(
          {
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
          },
          {
            status: "configured",
            badgeText: "Codex API Key",
            label: null,
            detail: null,
          },
          false,
        ),
        providerStateWithAuth(
          {
            providerId: "cursor",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
          },
          {
            status: "unavailable",
            badgeText: null,
            label: null,
            detail: "network failed",
          },
          false,
        ),
        providerStateWithAuth(
          {
            providerId: "qwen",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
          },
          {
            status: "authenticated",
            badgeText: null,
            label: "Authenticated as qwen@example.test",
            detail: null,
          },
          true,
        ),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.getByText("Configured, not verified")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Cursor" }));
    expect(screen.getByText("Could not check account status")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Qwen Code" }));
    expect(screen.getByText("Checking account")).toBeDefined();
  });

  it("lists OpenCode CLI candidates for OpenRouter and mutates OpenRouter selection", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /OpenRouter/i }));

    expect(screen.getByText("/usr/local/bin/opencode")).toBeDefined();

    fireEvent.click(
      screen.getByRole("radio", {
        name: "Select /usr/local/bin/opencode",
      }),
    );

    expect(providerMocks.setSelectionMutate).toHaveBeenCalledWith({
      providerId: "openrouter",
      selection: { kind: "path" },
    });
  });

  it("shows provider-scoped environment controls from provider state", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "opencode",
          selected: { kind: "bundled" },
          candidates: OPENCODE_CANDIDATES,
          envOverrides: [{ key: "OPENAI_API_KEY", value: null }],
        }),
        providerState({
          providerId: "traycer",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.getByText("Environment variables")).toBeDefined();
    expect(screen.getByDisplayValue("OPENAI_API_KEY")).toBeDefined();
    expect(
      screen.getByText(/Applied when Traycer spawns the OpenCode/),
    ).toBeDefined();
  });

  it("renders the host picker in the header (like Worktrees)", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.getByRole("combobox", { name: "Host" })).toBeDefined();
  });

  it("blocks disabling the last enabled provider", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "traycer",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    const switchElement = screen.getByRole("switch");
    if (!(switchElement instanceof HTMLButtonElement)) {
      throw new Error("Expected provider switch to render as a button.");
    }

    expect(switchElement.disabled).toBe(true);
    fireEvent.click(switchElement);

    expect(providerMocks.setEnabledMutate).not.toHaveBeenCalled();
  });
});
