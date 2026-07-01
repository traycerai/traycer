import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render as baseRender,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderLoginCapability,
} from "@traycer/protocol/host/provider-schemas";

// The banner shows only for web-login providers; it receives live provider
// `state` as a prop (from the composer's re-auth gate). Reconnect methods are
// OAuth (browser login) and/or pasting a fresh credential into an env var. A
// *rejected* credential never reaches the banner (it surfaces as a generic error
// row); API-key-only providers (Cursor) have no capability and no banner.
const mocks = vi.hoisted(() => ({
  startLoginMutate: vi.fn(),
  awaitLoginMutate: vi.fn(),
  cancelLoginMutate: vi.fn(),
  setEnvOverrideMutate: vi.fn(),
  setApiKeyMutate: vi.fn(),
  refreshProviders: vi.fn(() => Promise.resolve()),
  openExternalLink: vi.fn(),
  hostKind: "local",
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [{ hostId: "host-1", kind: mocks.hostKind }],
  }),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ id: "tab-client" }),
}));
vi.mock("@/lib/host/runtime", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    useHostBinding: () => ({ hostClient: { id: "real-client" } }),
  };
});
vi.mock("@/hooks/providers/use-providers-start-login-mutation", () => ({
  useProvidersStartLogin: () => ({
    mutate: mocks.startLoginMutate,
    isPending: false,
  }),
}));
vi.mock("@/hooks/providers/use-providers-await-login-mutation", () => ({
  useProvidersAwaitLogin: () => ({ mutate: mocks.awaitLoginMutate }),
}));
vi.mock("@/hooks/providers/use-providers-cancel-login-mutation", () => ({
  useProvidersCancelLogin: () => ({ mutate: mocks.cancelLoginMutate }),
}));
vi.mock("@/hooks/providers/use-providers-set-env-override-mutation", () => ({
  useProvidersSetEnvOverride: () => ({
    mutate: mocks.setEnvOverrideMutate,
    isPending: false,
  }),
}));
vi.mock("@/hooks/providers/use-providers-set-api-key-mutation", () => ({
  useProvidersSetApiKey: () => ({
    mutate: mocks.setApiKeyMutate,
    isPending: false,
  }),
}));
vi.mock("@/hooks/providers/use-tab-refresh-providers", () => ({
  useTabRefreshProviders: () => mocks.refreshProviders,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ openExternalLink: mocks.openExternalLink }),
}));

import { ProviderReauthBanner } from "../provider-reauth-banner";

// TokenReauthForm reads/writes the TanStack Query cache (useQueryClient +
// useTabRefreshProviders), so every banner render needs a QueryClient in scope.
function QueryWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

function render(ui: ReactElement) {
  return baseRender(ui, { wrapper: QueryWrapper });
}

const CLAUDE_CAP: ProviderLoginCapability = {
  oauthArgs: ["auth", "login"],
  token: { vars: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] },
};

// Droid has no headless login subcommand (bare `droid` is an interactive TUI
// that can't browser-OAuth over piped stdio), so it advertises no OAuth args -
// reauth is the FACTORY_API_KEY paste form only.
const DROID_CAP: ProviderLoginCapability = {
  oauthArgs: null,
  token: { vars: ["FACTORY_API_KEY"] },
};

function claudeState(
  loginCapability: ProviderLoginCapability | null,
): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability,
    availabilityPending: false,
  };
}

function cursorState(): ProviderCliState {
  return {
    providerId: "cursor",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: true, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    // API-key-only provider: no OAuth session to reconnect → no banner capability.
    loginCapability: null,
    availabilityPending: false,
  };
}

function droidState(): ProviderCliState {
  return {
    providerId: "droid",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: true, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: DROID_CAP,
    availabilityPending: false,
  };
}

describe("<ProviderReauthBanner />", () => {
  beforeEach(() => {
    mocks.startLoginMutate.mockReset();
    mocks.awaitLoginMutate.mockClear();
    mocks.cancelLoginMutate.mockClear();
    mocks.setEnvOverrideMutate.mockClear();
    mocks.setApiKeyMutate.mockClear();
    mocks.refreshProviders.mockClear();
    mocks.hostKind = "local";
  });

  afterEach(() => {
    cleanup();
  });

  it("offers the OAuth button on a local host", () => {
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
      />,
    );

    expect(screen.getByRole("button", { name: /Authenticate/ })).toBeDefined();
  });

  it("offers only the token paste form (no Authenticate) for a CLI with no headless login (Droid)", () => {
    render(<ProviderReauthBanner providerId="droid" state={droidState()} />);

    // Droid has no spawnable OAuth login, so no Authenticate button is offered -
    // it would only hang on "Waiting for browser sign-in…".
    expect(screen.queryByRole("button", { name: /Authenticate/ })).toBeNull();
    // The FACTORY_API_KEY paste form is the reconnect path instead.
    expect(
      screen.getByPlaceholderText("Paste your FACTORY_API_KEY"),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
    expect(mocks.startLoginMutate).not.toHaveBeenCalled();
  });

  it("stores a pasted Droid key as the encrypted API-key secret, not an env override", () => {
    render(<ProviderReauthBanner providerId="droid" state={droidState()} />);

    const input = screen.getByPlaceholderText("Paste your FACTORY_API_KEY");
    fireEvent.change(input, { target: { value: "  fk-droid-123  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Droid has an encrypted host-side key store, so the banner persists the key
    // as that secret (`providers.setApiKey`) — exactly like Settings > Providers —
    // rather than a plaintext env override.
    expect(mocks.setApiKeyMutate).toHaveBeenCalledWith(
      { providerId: "droid", apiKey: "fk-droid-123" },
      expect.anything(),
    );
    expect(mocks.setEnvOverrideMutate).not.toHaveBeenCalled();
  });

  it("re-checks sign-in status via the manual Refresh button", () => {
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Check sign-in status" }),
    );
    expect(mocks.refreshProviders).toHaveBeenCalled();
  });

  it("awaits the login-completion edge on Authenticate (no polling)", () => {
    mocks.startLoginMutate.mockImplementation(
      (
        _vars: { providerId: string },
        opts: { onSuccess: (data: { url: string }) => void },
      ) => {
        opts.onSuccess({ url: "http://localhost:56988/callback" });
      },
    );
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    // Spinner shows, and we await the host's completion edge instead of a
    // 2s `forceAuthRefresh` poll.
    expect(screen.getByText(/Waiting for browser sign-in/)).toBeDefined();
    expect(mocks.awaitLoginMutate).toHaveBeenCalledWith(
      { providerId: "claude-code" },
      expect.anything(),
    );
  });

  it("saves a pasted token as an env override for the first credential var", () => {
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
      />,
    );

    // Two vars → a credential-type select is offered alongside the OAuth button.
    expect(
      screen.getByRole("combobox", { name: "Credential type" }),
    ).toBeDefined();

    const input = screen.getByPlaceholderText("Paste your ANTHROPIC_API_KEY");
    fireEvent.change(input, { target: { value: "  sk-ant-123  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.setEnvOverrideMutate).toHaveBeenCalledWith(
      {
        providerId: "claude-code",
        key: "ANTHROPIC_API_KEY",
        value: "sk-ant-123",
      },
      expect.anything(),
    );
  });

  it("kills the login child on explicit Cancel but not on teardown", () => {
    // Drive the OAuth flow into its awaiting state by completing startLogin.
    mocks.startLoginMutate.mockImplementation(
      (
        _vars: { providerId: string },
        opts: { onSuccess: (data: { url: string }) => void },
      ) => {
        opts.onSuccess({ url: "http://localhost:56988/callback" });
      },
    );
    const { unmount } = render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    // Now waiting on the browser loopback; the child must stay alive.
    expect(screen.getByText(/Waiting for browser sign-in/)).toBeDefined();

    // Teardown (remount/fast-refresh/gate re-render) must NOT kill the child -
    // doing so drops the loopback port mid-sign-in.
    unmount();
    expect(mocks.cancelLoginMutate).not.toHaveBeenCalled();

    // Only an explicit Cancel tears down the host-side login child.
    mocks.startLoginMutate.mockImplementation(
      (
        _vars: { providerId: string },
        opts: { onSuccess: (data: { url: string }) => void },
      ) => {
        opts.onSuccess({ url: "http://localhost:56988/callback" });
      },
    );
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.cancelLoginMutate).toHaveBeenCalledWith({
      providerId: "claude-code",
    });
  });

  it("shows a no-method stub for an OAuth-only provider (no paste vars) on a remote host", () => {
    mocks.hostKind = "remote";
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState({ oauthArgs: ["auth", "login"], token: null })}
      />,
    );

    // Remote host → no OAuth loopback; no token vars → no paste form either.
    expect(screen.queryByRole("button", { name: /Authenticate/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText(/Reconnect .* from its CLI/)).toBeDefined();
  });

  it("still offers the paste form on a remote host when OAuth is unavailable", () => {
    mocks.hostKind = "remote";
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
      />,
    );

    // OAuth needs a local host, but pasting a credential works on any host.
    expect(screen.queryByRole("button", { name: /Authenticate/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });

  it("offers the paste form for an API-key-only provider (Cursor) with no OAuth", () => {
    render(<ProviderReauthBanner providerId="cursor" state={cursorState()} />);

    expect(screen.getByPlaceholderText("Paste your API key")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Authenticate/ })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Paste your API key"), {
      target: { value: "  cursor-key  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.setApiKeyMutate).toHaveBeenCalledWith(
      { providerId: "cursor", apiKey: "cursor-key" },
      expect.anything(),
    );
  });
});
