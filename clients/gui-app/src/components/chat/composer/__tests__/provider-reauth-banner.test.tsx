import "../../../../../__tests__/test-browser-apis";
import {
  act,
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
type AwaitLoginVariables = {
  readonly providerId: string;
  readonly profileId: string | null;
};
// Mirrors only the fields the ambient flow hook actually reads off
// `providers.awaitLogin`'s response (`codeRejected`, `state.auth.status`) -
// not the full `ProviderCliState` schema, since the mocked hook below never
// goes through real schema parsing.
type AwaitLoginResult = {
  readonly codeRejected: boolean;
  readonly state: { readonly auth: { readonly status: string } } | undefined;
};
type AwaitLoginOptions = {
  readonly onSuccess: (result: AwaitLoginResult) => void;
  readonly onError: () => void;
};
type AwaitLoginMutate = (
  variables: AwaitLoginVariables,
  options: AwaitLoginOptions,
) => void;

type SubmitLoginCodeVariables = {
  readonly providerId: string;
  readonly profileId: string | null;
  readonly code: string;
};
type SubmitLoginCodeOptions = {
  readonly onSuccess: (result: {
    readonly outcome: "accepted" | "noActiveLogin";
  }) => void;
  readonly onError: () => void;
};
type SubmitLoginCodeMutate = (
  variables: SubmitLoginCodeVariables,
  options: SubmitLoginCodeOptions,
) => void;

const mocks = vi.hoisted(() => ({
  startLoginMutate: vi.fn(),
  awaitLoginMutate: vi.fn<AwaitLoginMutate>(),
  cancelLoginMutate: vi.fn(),
  cancelLoginPending: false,
  submitLoginCodeMutate: vi.fn<SubmitLoginCodeMutate>(),
  submitLoginCodeReset: vi.fn(),
  submitLoginCodePending: false,
  submitLoginCodeSuccess: false,
  submitLoginCodeData: undefined as
    { readonly outcome: "accepted" | "noActiveLogin" } | undefined,
  submitLoginCodeError: null as Error | null,
  touchLoginMutate: vi.fn(),
  touchLoginReset: vi.fn(),
  setEnvOverrideMutate: vi.fn(),
  setApiKeyMutate: vi.fn(),
  refreshProviders: vi.fn(() => Promise.resolve()),
  openExternalLink: vi.fn(),
  reportableErrorToast: vi.fn(),
  openSettings: vi.fn(),
  hostKind: "local",
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: mocks.openSettings }),
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
  useProvidersCancelLogin: () => ({
    mutate: mocks.cancelLoginMutate,
    isPending: mocks.cancelLoginPending,
  }),
}));
vi.mock("@/hooks/providers/use-providers-submit-login-code-mutation", () => ({
  useProvidersSubmitLoginCode: () => ({
    mutate: mocks.submitLoginCodeMutate,
    isPending: mocks.submitLoginCodePending,
    isSuccess: mocks.submitLoginCodeSuccess,
    data: mocks.submitLoginCodeData,
    error: mocks.submitLoginCodeError,
    reset: mocks.submitLoginCodeReset,
  }),
}));
vi.mock("@/hooks/providers/use-providers-touch-login-mutation", () => ({
  useProvidersTouchLogin: () => ({
    mutate: mocks.touchLoginMutate,
    isPending: false,
    error: null,
    reset: mocks.touchLoginReset,
  }),
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
vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => ({ mutate: mocks.openExternalLink }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ openExternalLink: mocks.openExternalLink }),
}));
vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: mocks.reportableErrorToast,
}));

import { ProviderReauthBanner } from "../provider-reauth-banner";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";

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

function mockStartLoginAlwaysSucceeds(): void {
  mocks.startLoginMutate.mockImplementation(
    (
      _vars: {
        readonly providerId: string;
        readonly profileId: string | null;
        readonly createProfile: unknown;
      },
      opts: {
        readonly onSuccess: (data: {
          readonly url: string;
          readonly started: boolean;
          readonly profileId: string | null;
        }) => void;
      },
    ) => {
      opts.onSuccess({
        url: "http://localhost:56988/callback",
        started: true,
        profileId: null,
      });
    },
  );
}

function latestAwaitLoginCall(): readonly [
  AwaitLoginVariables,
  AwaitLoginOptions,
] {
  const call = mocks.awaitLoginMutate.mock.calls.at(-1);
  if (call === undefined) throw new Error("Expected an awaitLogin call.");
  return call;
}

function latestSubmitLoginCodeCall(): readonly [
  SubmitLoginCodeVariables,
  SubmitLoginCodeOptions,
] {
  const call = mocks.submitLoginCodeMutate.mock.calls.at(-1);
  if (call === undefined) throw new Error("Expected a submitLoginCode call.");
  return call;
}

const CLAUDE_CAP: ProviderLoginCapability = {
  oauthArgs: ["auth", "login"],
  token: { vars: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] },
  codePaste: null,
};

// Droid has no headless login subcommand (bare `droid` is an interactive TUI
// that can't browser-OAuth over piped stdio), so it advertises no OAuth args -
// reauth is the FACTORY_API_KEY paste form only.
const DROID_CAP: ProviderLoginCapability = {
  oauthArgs: null,
  token: { vars: ["FACTORY_API_KEY"] },
  codePaste: null,
};

const CODE_PASTE_CLAUDE_CAP: ProviderLoginCapability = {
  oauthArgs: ["auth", "login"],
  token: { vars: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] },
  codePaste: {},
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
    profiles: [],
  };
}

function codexState(
  loginCapability: ProviderLoginCapability | null,
): ProviderCliState {
  return { ...claudeState(loginCapability), providerId: "codex" };
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
    profiles: [],
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
    profiles: [],
  };
}

describe("<ProviderReauthBanner />", () => {
  beforeEach(() => {
    mocks.startLoginMutate.mockReset();
    mocks.awaitLoginMutate.mockClear();
    mocks.cancelLoginMutate.mockClear();
    mocks.cancelLoginPending = false;
    mocks.submitLoginCodeMutate.mockReset();
    mocks.submitLoginCodePending = false;
    mocks.submitLoginCodeSuccess = false;
    mocks.submitLoginCodeData = undefined;
    mocks.submitLoginCodeError = null;
    mocks.submitLoginCodeMutate.mockImplementation(() => {
      mocks.submitLoginCodePending = true;
      mocks.submitLoginCodeSuccess = false;
      mocks.submitLoginCodeData = undefined;
      mocks.submitLoginCodeError = null;
    });
    mocks.submitLoginCodeReset.mockReset();
    mocks.submitLoginCodeReset.mockImplementation(() => {
      mocks.submitLoginCodePending = false;
      mocks.submitLoginCodeSuccess = false;
      mocks.submitLoginCodeData = undefined;
      mocks.submitLoginCodeError = null;
    });
    mocks.touchLoginMutate.mockReset();
    mocks.touchLoginReset.mockClear();
    mocks.setEnvOverrideMutate.mockClear();
    mocks.setApiKeyMutate.mockClear();
    mocks.refreshProviders.mockClear();
    mocks.openExternalLink.mockClear();
    mocks.reportableErrorToast.mockClear();
    mocks.hostKind = "local";
    useProvidersFocusStore.getState().clearFocusHarnessId();
  });

  afterEach(() => {
    cleanup();
  });

  it("offers the OAuth button on a local host", () => {
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    expect(screen.getByRole("button", { name: /Authenticate/ })).toBeDefined();
  });

  it("offers only the token paste form (no Authenticate) for a CLI with no headless login (Droid)", () => {
    render(
      <ProviderReauthBanner
        providerId="droid"
        state={droidState()}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

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
    render(
      <ProviderReauthBanner
        providerId="droid"
        state={droidState()}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

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
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
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
        opts: {
          onSuccess: (data: {
            readonly url: string;
            readonly started: boolean;
            readonly profileId: string | null;
          }) => void;
        },
      ) => {
        opts.onSuccess({
          url: "http://localhost:56988/callback",
          started: true,
          profileId: null,
        });
      },
    );
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    // Spinner shows, and we await the host's completion edge instead of a
    // 2s `forceAuthRefresh` poll.
    expect(screen.getByText(/Approve sign-in in your browser/)).toBeDefined();
    expect(mocks.awaitLoginMutate).toHaveBeenCalledWith(
      { providerId: "claude-code", profileId: null },
      expect.anything(),
    );
  });

  it("does not show a code-paste field for a provider without the codePaste capability", () => {
    mockStartLoginAlwaysSucceeds();
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    expect(screen.getByText(/Approve sign-in in your browser/)).toBeDefined();
    expect(screen.queryByLabelText("Paste the code")).toBeNull();
  });

  it("expands into a compact code-paste row and submits with the ambient (null) profile id", () => {
    mockStartLoginAlwaysSucceeds();
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CODE_PASTE_CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    expect(screen.getByText(/Approve sign-in in your browser/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Open browser again" }));
    expect(mocks.openExternalLink).toHaveBeenCalledWith(
      "http://localhost:56988/callback",
    );

    const input = screen.getByLabelText("Paste the code");
    fireEvent.paste(input, {
      clipboardData: { getData: () => "abc123#xyz789" },
    });

    expect(mocks.submitLoginCodeMutate).toHaveBeenCalledWith(
      { providerId: "claude-code", profileId: null, code: "abc123#xyz789" },
      expect.anything(),
    );
  });

  it("touches the keepalive with the ambient (null) profile id when the paste field is focused", () => {
    mockStartLoginAlwaysSucceeds();
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CODE_PASTE_CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    fireEvent.focus(screen.getByLabelText("Paste the code"));

    expect(mocks.touchLoginMutate).toHaveBeenCalledWith({
      providerId: "claude-code",
      profileId: null,
    });
  });

  it("keeps an untouched browser-approval leg alive beyond three minutes and stops after settlement", async () => {
    vi.useFakeTimers();
    try {
      mockStartLoginAlwaysSucceeds();
      render(
        <ProviderReauthBanner
          providerId="claude-code"
          state={claudeState(CODE_PASTE_CLAUDE_CAP)}
          reason="provider_unauthenticated"
          profileId={null}
          profileLabel={null}
          onContinueOnAmbient={null}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
      await act(() => vi.advanceTimersByTimeAsync(181_000));

      expect(mocks.touchLoginMutate).toHaveBeenCalledTimes(3);
      expect(mocks.touchLoginMutate).toHaveBeenLastCalledWith({
        providerId: "claude-code",
        profileId: null,
      });

      const [, awaitOptions] = latestAwaitLoginCall();
      act(() => {
        awaitOptions.onSuccess({
          codeRejected: false,
          state: { auth: { status: "authenticated" } },
        });
      });
      await act(() => vi.advanceTimersByTimeAsync(120_000));
      expect(mocks.touchLoginMutate).toHaveBeenCalledTimes(3);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("stops the waiting-state keepalive after cancellation", async () => {
    vi.useFakeTimers();
    try {
      mockStartLoginAlwaysSucceeds();
      render(
        <ProviderReauthBanner
          providerId="claude-code"
          state={claudeState(CODE_PASTE_CLAUDE_CAP)}
          reason="provider_unauthenticated"
          profileId={null}
          profileLabel={null}
          onContinueOnAmbient={null}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
      await act(() => vi.advanceTimersByTimeAsync(61_000));
      expect(mocks.touchLoginMutate).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await act(() => vi.advanceTimersByTimeAsync(120_000));
      expect(mocks.touchLoginMutate).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("reports a clipboard failure from the banner copy action", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) },
    });

    try {
      mockStartLoginAlwaysSucceeds();
      render(
        <ProviderReauthBanner
          providerId="claude-code"
          state={claudeState(CODE_PASTE_CLAUDE_CAP)}
          reason="provider_unauthenticated"
          profileId={null}
          profileLabel={null}
          onContinueOnAmbient={null}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Copy sign-in link" }),
        );
        await Promise.resolve();
      });

      expect(mocks.reportableErrorToast).toHaveBeenCalledWith(
        "Couldn't copy the sign-in link.",
        undefined,
        {
          title: "Could not copy sign-in link",
          message: null,
          code: null,
          source: "Provider sign-in",
        },
      );
    } finally {
      cleanup();
      if (clipboardDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      }
    }
  });

  it("allows the fresh child's first keepalive immediately after an auto-restart", () => {
    mockStartLoginAlwaysSucceeds();
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CODE_PASTE_CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    fireEvent.focus(screen.getByLabelText("Paste the code"));
    expect(mocks.touchLoginMutate).toHaveBeenCalledTimes(1);

    const [, firstAwaitOptions] = latestAwaitLoginCall();
    act(() => {
      firstAwaitOptions.onSuccess({ codeRejected: true, state: undefined });
    });
    expect(mocks.startLoginMutate).toHaveBeenCalledTimes(2);

    fireEvent.focus(screen.getByLabelText("Paste the code"));
    expect(mocks.touchLoginMutate).toHaveBeenCalledTimes(2);
  });

  it("keeps an authenticated ambient result terminal even when awaitLogin also reports codeRejected", () => {
    mockStartLoginAlwaysSucceeds();
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CODE_PASTE_CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    const [, awaitOptions] = latestAwaitLoginCall();
    act(() => {
      awaitOptions.onSuccess({
        codeRejected: true,
        state: { auth: { status: "authenticated" } },
      });
    });

    expect(mocks.startLoginMutate).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(
        "That code didn't work - a new sign-in link was generated.",
      ),
    ).toBeNull();
  });

  it("auto-restarts with a fresh sign-in link when the submitted code is rejected, keeping the user in the banner", () => {
    mockStartLoginAlwaysSucceeds();
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CODE_PASTE_CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    const input = screen.getByLabelText("Paste the code");
    fireEvent.paste(input, {
      clipboardData: { getData: () => "abc123#xyz789" },
    });

    const [, awaitOptions] = latestAwaitLoginCall();
    act(() => {
      awaitOptions.onSuccess({ codeRejected: true, state: undefined });
    });

    // The rejection triggered a fresh `startLogin` call and stayed in the
    // banner's waiting UI, instead of dropping back to the Authenticate
    // button or leaving the user with a dead child.
    expect(mocks.startLoginMutate).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText(
        "That code didn't work - a new sign-in link was generated.",
      ),
    ).toBeDefined();
    // Fresh, unmasked field for the new attempt.
    expect(screen.getByLabelText("Paste the code")).toHaveProperty("value", "");
  });

  it("restarts with a session-expired notice when awaitLogin resolves not-authenticated before a late noActiveLogin submit response arrives (fixup settlement join, ambient await-first ordering)", () => {
    mockStartLoginAlwaysSucceeds();
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CODE_PASTE_CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    const input = screen.getByLabelText("Paste the code");
    fireEvent.paste(input, {
      clipboardData: { getData: () => "abc123#xyz789" },
    });

    const [, awaitOptions] = latestAwaitLoginCall();
    // `awaitLogin` resolves not-authenticated first - previously this
    // reverted straight to the Authenticate button, dropping the later
    // `noActiveLogin` verdict on the floor instead of restarting.
    act(() => {
      awaitOptions.onSuccess({
        codeRejected: false,
        state: { auth: { status: "unauthenticated" } },
      });
    });

    // The submit's verdict arrives late and must still settle the attempt.
    const [, submitOptions] = latestSubmitLoginCodeCall();
    act(() => {
      submitOptions.onSuccess({ outcome: "noActiveLogin" });
    });

    expect(mocks.startLoginMutate).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText("That sign-in link expired - a new one was generated."),
    ).toBeDefined();
  });

  it("restarts with a session-expired notice when a noActiveLogin submit response is followed by a fulfilled-but-unauthenticated awaitLogin (fixup settlement join, ambient submit-first ordering)", () => {
    mockStartLoginAlwaysSucceeds();
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CODE_PASTE_CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    const input = screen.getByLabelText("Paste the code");
    fireEvent.paste(input, {
      clipboardData: { getData: () => "abc123#xyz789" },
    });

    const [, submitOptions] = latestSubmitLoginCodeCall();
    act(() => {
      submitOptions.onSuccess({ outcome: "noActiveLogin" });
    });

    // `awaitLogin` then resolves - the call went through, but the re-probed
    // status is still not authenticated. Presence of a completed call is
    // not success; only an authenticated status is (fixup review finding 2).
    const [, awaitOptions] = latestAwaitLoginCall();
    act(() => {
      awaitOptions.onSuccess({
        codeRejected: false,
        state: { auth: { status: "unauthenticated" } },
      });
    });

    expect(mocks.startLoginMutate).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText("That sign-in link expired - a new one was generated."),
    ).toBeDefined();
  });

  it("shows a verifying header and locks the field once the relay is accepted and the exchange is still pending (statefulness fixup)", () => {
    mockStartLoginAlwaysSucceeds();
    const view = render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CODE_PASTE_CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    const input = screen.getByLabelText("Paste the code");
    fireEvent.paste(input, {
      clipboardData: { getData: () => "abc123#xyz789" },
    });
    view.rerender(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CODE_PASTE_CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );
    expect(input).toHaveProperty("readOnly", true);

    const [, submitOptions] = latestSubmitLoginCodeCall();
    act(() => {
      mocks.submitLoginCodePending = false;
      mocks.submitLoginCodeSuccess = true;
      mocks.submitLoginCodeData = { outcome: "accepted" };
      submitOptions.onSuccess({ outcome: "accepted" });
    });
    view.rerender(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CODE_PASTE_CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    expect(screen.getByText("Checking approval…")).toBeDefined();
    expect(input).toHaveProperty("readOnly", true);
    expect(
      screen.queryByRole("button", { name: "Open browser again" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("shows the Cancel button's pending state per the AGENTS.md recipe (disabled, unchanged label, inline spinner)", () => {
    mocks.cancelLoginPending = true;
    mockStartLoginAlwaysSucceeds();
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton.textContent).toContain("Cancel");
    expect(cancelButton).toHaveProperty("disabled", true);
  });

  it("saves a pasted token as an env override for the first credential var", () => {
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
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
        opts: {
          onSuccess: (data: {
            readonly url: string;
            readonly started: boolean;
            readonly profileId: string | null;
          }) => void;
        },
      ) => {
        opts.onSuccess({
          url: "http://localhost:56988/callback",
          started: true,
          profileId: null,
        });
      },
    );
    const { unmount } = render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    // Now waiting on the browser loopback; the child must stay alive.
    expect(screen.getByText(/Approve sign-in in your browser/)).toBeDefined();

    // Teardown (remount/fast-refresh/gate re-render) must NOT kill the child -
    // doing so drops the loopback port mid-sign-in.
    unmount();
    expect(mocks.cancelLoginMutate).not.toHaveBeenCalled();

    // Only an explicit Cancel tears down the host-side login child.
    mocks.startLoginMutate.mockImplementation(
      (
        _vars: { providerId: string },
        opts: {
          onSuccess: (data: {
            readonly url: string;
            readonly started: boolean;
            readonly profileId: string | null;
          }) => void;
        },
      ) => {
        opts.onSuccess({
          url: "http://localhost:56988/callback",
          started: true,
          profileId: null,
        });
      },
    );
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState(CLAUDE_CAP)}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Authenticate/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.cancelLoginMutate).toHaveBeenCalledWith({
      providerId: "claude-code",
      profileId: null,
    });
  });

  it("shows a no-method stub for an OAuth-only provider (no paste vars) on a remote host", () => {
    mocks.hostKind = "remote";
    render(
      <ProviderReauthBanner
        providerId="claude-code"
        state={claudeState({
          oauthArgs: ["auth", "login"],
          token: null,
          codePaste: null,
        })}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
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
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

    // OAuth needs a local host, but pasting a credential works on any host.
    expect(screen.queryByRole("button", { name: /Authenticate/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });

  it("offers the paste form for an API-key-only provider (Cursor) with no OAuth", () => {
    render(
      <ProviderReauthBanner
        providerId="cursor"
        state={cursorState()}
        reason="provider_unauthenticated"
        profileId={null}
        profileLabel={null}
        onContinueOnAmbient={null}
      />,
    );

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

  describe("profile-specific reasons", () => {
    it("offers only the ambient fallback (no OAuth/token form) for a missing profile", () => {
      const onContinueOnAmbient = vi.fn();
      render(
        <ProviderReauthBanner
          providerId="claude-code"
          state={claudeState(CLAUDE_CAP)}
          reason="profile_missing"
          profileId="removed-profile"
          profileLabel={null}
          onContinueOnAmbient={onContinueOnAmbient}
        />,
      );

      expect(
        screen.getByText(
          "This agent's Claude Code profile is no longer available.",
        ),
      ).toBeDefined();
      expect(screen.queryByRole("button", { name: /Authenticate/ })).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Continue on Terminal account" }),
      );
      expect(onContinueOnAmbient).toHaveBeenCalledTimes(1);

      fireEvent.click(
        screen.getByRole("button", { name: "Manage in Settings" }),
      );
      expect(useProvidersFocusStore.getState()).toEqual(
        expect.objectContaining({
          focusHarnessId: "claude",
          focusHostId: "host-1",
          focusProfileId: "removed-profile",
          startSignIn: false,
        }),
      );
      expect(mocks.openSettings).toHaveBeenCalledWith({
        section: "providers",
        resetToGeneral: false,
      });
    });

    it("names the profile for profile_unauthenticated and still offers the ambient fallback", () => {
      const onContinueOnAmbient = vi.fn();
      render(
        <ProviderReauthBanner
          providerId="claude-code"
          state={claudeState(CLAUDE_CAP)}
          reason="profile_unauthenticated"
          profileId="work-profile"
          profileLabel="Work"
          onContinueOnAmbient={onContinueOnAmbient}
        />,
      );

      expect(screen.getByText('"Work" is signed out.')).toBeDefined();
      fireEvent.click(
        screen.getByRole("button", { name: "Continue on Terminal account" }),
      );
      expect(onContinueOnAmbient).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      expect(useProvidersFocusStore.getState()).toEqual(
        expect.objectContaining({
          focusHarnessId: "claude",
          focusHostId: "host-1",
          focusProfileId: "work-profile",
          startSignIn: true,
        }),
      );
      expect(mocks.openSettings).toHaveBeenCalledWith({
        section: "providers",
        resetToGeneral: false,
      });
    });

    it("opens the exact signed-out Codex profile in Settings", () => {
      render(
        <ProviderReauthBanner
          providerId="codex"
          state={codexState(CLAUDE_CAP)}
          reason="profile_unauthenticated"
          profileId="codex-work-profile"
          profileLabel="Codex Work"
          onContinueOnAmbient={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

      expect(useProvidersFocusStore.getState()).toEqual(
        expect.objectContaining({
          focusHarnessId: "codex",
          focusHostId: "host-1",
          focusProfileId: "codex-work-profile",
          startSignIn: true,
        }),
      );
      expect(mocks.openSettings).toHaveBeenCalledWith({
        section: "providers",
        resetToGeneral: false,
      });
    });
  });
});
