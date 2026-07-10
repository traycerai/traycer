import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F4 (durability audit), settings surface: `ProviderProfileScopedSection` /
 * `ProviderProfileCard` (provider-profile-scoped-section.tsx,
 * provider-profile-card.tsx) render a profile's `label` and `identity.email`
 * as plain JSX text (`profileDisplayLabel`, `ProfileCardIdentityLine`) - no
 * `dangerouslySetInnerHTML` anywhere in either file (grepped). This proves
 * the runtime half: a hostile label/email renders as literal text with no
 * injected elements, and the panel doesn't crash.
 */

// Render the profile dropdown inline + always-open so the test can select
// the hostile-labeled row without fighting Radix's pointerdown-based open
// gesture in jsdom (mirrors the established mock in
// worktrees-settings-panel.test / folder-controls.test).
vi.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = (props: { readonly children: ReactNode }): ReactNode =>
    props.children;
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: (props: {
      readonly children: ReactNode;
      readonly onSelect: (() => void) | undefined;
      readonly "aria-label": string | undefined;
      readonly "aria-current": "true" | undefined;
      readonly className: string | undefined;
    }): ReactNode => (
      <button
        type="button"
        role="menuitem"
        aria-label={props["aria-label"]}
        aria-current={props["aria-current"]}
        className={props.className}
        onClick={props.onSelect}
      >
        {props.children}
      </button>
    ),
    DropdownMenuSeparator: (): ReactNode => <div role="separator" />,
    DropdownMenuShortcut: (props: {
      readonly children: ReactNode;
      readonly "data-testid": string | undefined;
    }): ReactNode => (
      <span data-testid={props["data-testid"]}>{props.children}</span>
    ),
  };
});

const providerMocks = vi.hoisted(() => ({
  listResult: {
    data: { providers: [] as ProviderCliState[] },
    isPending: false,
    isError: false,
    isFetching: false,
  },
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => providerMocks.listResult,
}));
vi.mock("@/hooks/providers/use-providers-set-selection-mutation", () => ({
  useProvidersSetSelection: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-add-custom-path-mutation", () => ({
  useProvidersAddCustomPath: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-remove-custom-path-mutation", () => ({
  useProvidersRemoveCustomPath: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-set-enabled-mutation", () => ({
  useProvidersSetEnabled: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-set-api-key-mutation", () => ({
  useProvidersSetApiKey: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-clear-api-key-mutation", () => ({
  useProvidersClearApiKey: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock(
  "@/hooks/providers/use-providers-set-terminal-agent-args-mutation",
  () => ({
    useProvidersSetTerminalAgentArgs: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  }),
);
vi.mock("@/hooks/providers/use-providers-set-env-override-mutation", () => ({
  useProvidersSetEnvOverride: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-delete-env-override-mutation", () => ({
  useProvidersDeleteEnvOverride: () => ({ mutate: vi.fn(), isPending: false }),
}));
// Both the plain and `*ForClient` names are exported - see the equivalent
// comment in `providers-settings-panel.test.tsx`.
vi.mock("@/hooks/providers/use-providers-start-login-mutation", () => {
  const useProvidersStartLogin = () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  });
  return {
    useProvidersStartLogin,
    useProvidersStartLoginForClient: useProvidersStartLogin,
  };
});
vi.mock("@/hooks/providers/use-providers-await-login-mutation", () => {
  const useProvidersAwaitLogin = () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  });
  return {
    useHostScopedProvidersAwaitLogin: useProvidersAwaitLogin,
    useProvidersAwaitLoginForClient: useProvidersAwaitLogin,
  };
});
vi.mock("@/hooks/providers/use-providers-cancel-login-mutation", () => {
  const useProvidersCancelLogin = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useProvidersCancelLogin,
    useProvidersCancelLoginForClient: useProvidersCancelLogin,
  };
});
vi.mock("@/hooks/providers/use-rename-provider-profile-mutation", () => {
  const useRenameProviderProfile = () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  });
  return {
    useRenameProviderProfile,
    useRenameProviderProfileForClient: useRenameProviderProfile,
  };
});
vi.mock("@/hooks/providers/use-recolor-provider-profile-mutation", () => {
  const useRecolorProviderProfile = () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  });
  return {
    useRecolorProviderProfile,
    useRecolorProviderProfileForClient: useRecolorProviderProfile,
  };
});
vi.mock("@/hooks/providers/use-remove-provider-profile-mutation", () => {
  const useRemoveProviderProfile = () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  });
  return {
    useRemoveProviderProfile,
    useRemoveProviderProfileForClient: useRemoveProviderProfile,
  };
});
vi.mock("@/hooks/providers/use-providers-detect-version-query", () => ({
  useProvidersDetectVersion: () => ({ isFetching: false, data: undefined }),
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({ data: { harnesses: [] } }),
}));
vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => () => Promise.resolve(),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ openExternalLink: vi.fn() }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: null,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve({}),
  }),
}));
vi.mock("@/hooks/auth/use-refresh-credits-on-traycer-turn", () => ({
  useRefreshCreditsOnTraycerTurn: () => {},
}));
vi.mock("@/hooks/host/use-host-rate-limit-usage-query", () => ({
  useHostRateLimitUsageQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/host/use-refresh-rate-limit-usage-on-traycer-turn", () => ({
  useRefreshRateLimitUsageOnTraycerTurn: () => {},
}));
vi.mock("@/hooks/host/use-host-provider-rate-limits-query", () => ({
  useHostProviderRateLimitsQuery: () => ({
    data: undefined,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve({}),
  }),
}));
vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-turn", () => ({
  useRefreshProviderRateLimitsOnTurn: () => {},
}));
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "local",
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "local",
        kind: "local",
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
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});

import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { TooltipProvider } from "@/components/ui/tooltip";

const VERY_LONG_LABEL = "C".repeat(2000);
const HTML_LOOKING_LABEL = '<img src=x onerror="alert(1)">';
const HTML_LOOKING_EMAIL = '<img src=x onerror="alert(1)">@example.com';

function hostileProfile(label: string, email: string): ProviderProfile {
  return {
    profileId: "hostile-uuid",
    kind: "managed",
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email, tier: null, accountUuid: "acct-1" },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function ambientProfile(): ProviderProfile {
  return {
    profileId: "ambient",
    kind: "ambient",
    authType: "oauth",
    label: "Terminal account",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function claudeStateWithProfiles(
  profiles: readonly ProviderProfile[],
): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
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
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [...profiles],
  };
}

describe("F4: hostile profile labels - settings Profiles section", () => {
  beforeEach(() => {
    providerMocks.listResult = {
      data: { providers: [] },
      isPending: false,
      isError: false,
      isFetching: false,
    };
  });
  afterEach(() => cleanup());

  it("renders a 2000-char profile label without crashing", () => {
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([
            ambientProfile(),
            hostileProfile(VERY_LONG_LABEL, "user@example.com"),
          ]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };
    const { container } = render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // The section defaults to the ambient profile - select the hostile one to
    // bring its details (and the raw label) into the DOM. It then also
    // labels the (mocked, always-open) dropdown trigger, so more than one
    // element carries the raw label - assert presence, not a single match.
    fireEvent.click(screen.getByRole("menuitem", { name: VERY_LONG_LABEL }));

    expect(screen.getAllByText(VERY_LONG_LABEL).length).toBeGreaterThan(0);
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders an HTML-looking label AND HTML-looking email as literal text with no injected <img>", () => {
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([
            ambientProfile(),
            hostileProfile(HTML_LOOKING_LABEL, HTML_LOOKING_EMAIL),
          ]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };
    const { container } = render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // The section defaults to the ambient profile - select the hostile one to
    // bring its details (and the raw label) into the DOM. It then also
    // labels the (mocked, always-open) dropdown trigger, so more than one
    // element carries the raw label - assert presence, not a single match.
    fireEvent.click(screen.getByRole("menuitem", { name: HTML_LOOKING_LABEL }));

    expect(screen.getAllByText(HTML_LOOKING_LABEL).length).toBeGreaterThan(0);
    // The email is redacted by default (see the reveal toggle); click it to
    // exercise the hostile string in its fully-rendered form too.
    fireEvent.click(
      screen.getByRole("button", {
        name: `Reveal email for ${HTML_LOOKING_LABEL}`,
      }),
    );
    expect(screen.getByText(HTML_LOOKING_EMAIL)).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});
