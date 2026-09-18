import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  type RenderResult,
} from "@testing-library/react";
import { StrictMode } from "react";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";

type StartLoginData = { readonly started: boolean };
type StartLoginVariables = {
  readonly providerId: string;
  readonly profileId: string | null;
  readonly createProfile: unknown;
};
type StartLoginOptions = {
  readonly onSuccess: (data: StartLoginData) => void;
  readonly onError: () => void;
};
type StartLoginMutate = (
  variables: StartLoginVariables,
  options: StartLoginOptions,
) => void;

type AwaitLoginVariables = {
  readonly providerId: string;
  readonly profileId: string | null;
};
type AwaitLoginCompletion = {
  readonly state: {
    readonly auth: { readonly status: string };
    // The host's "my auth probe has not answered yet" flag. Carried here
    // because the button's decision depends on it, not just on `status`.
    readonly authPending: boolean;
    // REQUIRED, exactly as on the wire: `providerCliStateBaseShapeV40` gives
    // `profiles` a `.catch([])`, so a parsed response always carries an array,
    // and the hook that consumes this response already maps over it
    // unguarded. Optional here would let a fixture omit the ambient ROW that
    // the button's verdict reconciles against the top-level status - the
    // divergence between these two signals is the whole subject of the
    // `isProviderAmbientAuthenticated` tests below.
    readonly profiles: readonly {
      readonly kind: string;
      readonly auth: { readonly status: string };
    }[];
  } | null;
};
type AwaitLoginOptions = {
  readonly onSuccess: (completion: AwaitLoginCompletion) => void;
  readonly onError: () => void;
};
type AwaitLoginMutate = (
  variables: AwaitLoginVariables,
  options: AwaitLoginOptions,
) => void;
type SetEnabledMutate = (variables: {
  readonly providerId: string;
  readonly enabled: boolean;
  readonly profileAction: unknown;
}) => void;
type SetEnabledVariables = Parameters<SetEnabledMutate>[0];

// `codex` is disabled with a DETECTED candidate, so it's the one row that
// satisfies `providerNeedsSignInToEnable` (`!state.enabled && installDetected`)
// and renders `SignInToEnableButton` - every other provider's row has no
// cached `ProviderCliState` at all, so its trailing content is null and
// cannot collide with the role queries below.
const fixtures = vi.hoisted(() => {
  const signInProvider: ProviderCliState = {
    providerId: "codex",
    enabled: false,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [
      {
        kind: "bundled",
        path: "/usr/bin/codex",
        version: "1.0.0",
        available: true,
        versionPending: false,
      },
    ],
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
    loginCapability: {
      oauthArgs: ["auth", "login"],
      token: null,
      codePaste: null,
      // Present but no terminal command: `providerSignInUnavailableHint`
      // requires this so the button (not the "Not signed in" tooltip
      // fallback) is what actually renders.
      terminalLogin: null,
      remoteSafe: null,
      selfOpensBrowser: null,
    },
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
  };
  return {
    signInProvider,
    providers: [] as ProviderCliState[],
    startLoginMutate: vi.fn<StartLoginMutate>(),
    startLoginPending: false,
    startLoginSuccess: false,
    startLoginData: undefined as StartLoginData | undefined,
    awaitLoginMutate: vi.fn<AwaitLoginMutate>(),
    awaitLoginReset: vi.fn(),
    // Modelled for the same reason `startLogin`'s are: the component derives
    // its "did not authenticate" row message from the mutation RESULT rather
    // than from local state, so a mock that carried only `mutate` would leave
    // that message permanently unrenderable - and the test asserting it
    // permanently vacuous.
    awaitLoginSuccess: false,
    awaitLoginData: undefined as AwaitLoginCompletion | undefined,
    setEnabledMutate: vi.fn<SetEnabledMutate>(),
    setEnabledPending: false,
    setEnabledVariables: undefined as SetEnabledVariables | undefined,
    // Onboarding really can target a remote host (`OnboardingHostPickerBar`),
    // and locality is a live input to `providerSignInUnavailableHint` - so it
    // has to be steerable rather than hardcoded, or the remote row of T7's
    // matrix cannot be written at all.
    isLocalMachine: true,
    toastError: vi.fn(),
  };
});

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: { providers: fixtures.providers },
    isPending: false,
    isError: false,
    fetchStatus: "idle",
  }),
}));

vi.mock("@/hooks/providers/use-providers-set-enabled-mutation", () => ({
  useProvidersSetEnabled: () => ({
    isPending: fixtures.setEnabledPending,
    variables:
      fixtures.setEnabledVariables ??
      fixtures.setEnabledMutate.mock.lastCall?.[0],
    mutate: fixtures.setEnabledMutate,
  }),
}));

vi.mock("@/hooks/providers/use-providers-start-login-mutation", () => ({
  useProvidersStartLogin: () => ({
    mutate: fixtures.startLoginMutate,
    isPending: fixtures.startLoginPending,
    isSuccess: fixtures.startLoginSuccess,
    data: fixtures.startLoginData,
  }),
}));

vi.mock("@/hooks/providers/use-providers-await-login-mutation", () => ({
  useHostScopedProvidersAwaitLogin: () => ({
    mutate: fixtures.awaitLoginMutate,
    isPending: false,
    isSuccess: fixtures.awaitLoginSuccess,
    data: fixtures.awaitLoginData,
    // Modelled as the real one behaves - clearing the result - rather than as a
    // bare spy, so a test can assert the CONSEQUENCE (no stale verdict on the
    // next attempt) instead of merely that a function was called.
    reset: () => {
      fixtures.awaitLoginReset();
      fixtures.awaitLoginSuccess = false;
      fixtures.awaitLoginData = undefined;
    },
  }),
}));

vi.mock("@/hooks/providers/use-providers-submit-login-code-mutation", () => ({
  useProvidersSubmitLoginCode: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
}));

vi.mock("@/hooks/providers/use-providers-touch-login-mutation", () => ({
  useProvidersTouchLogin: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(() => Promise.resolve()),
}));

vi.mock("@/components/onboarding/onboarding-provider-discovery", () => ({
  OnboardingProviderDiscovery: () => null,
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: [{ isActive: true, isLocalMachine: fixtures.isLocalMachine }],
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: fixtures.toastError,
    success: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import { OnboardingDetectedAgents } from "@/components/onboarding/onboarding-detected-agents";
import {
  AMBIENT_AUTH_PENDING_REPOLL_CAP,
  AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS,
} from "@/lib/providers/provider-ambient-auth";

function latestStartLoginCall(): readonly [
  StartLoginVariables,
  StartLoginOptions,
] {
  const call = fixtures.startLoginMutate.mock.calls.at(-1);
  if (call === undefined) throw new Error("Expected a startLogin call.");
  return call;
}

function latestAwaitLoginOptions(): AwaitLoginOptions {
  const call = fixtures.awaitLoginMutate.mock.calls.at(-1);
  if (call === undefined) throw new Error("Expected an awaitLogin call.");
  return call[1];
}

function signInButton(): HTMLElement {
  return screen.getByRole("button", { name: /sign in & enable/i });
}

function providerButton(name: string, pressed: boolean): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name, pressed });
}

/**
 * The whole mutable surface of `fixtures`, back to its declared state. Shared
 * by every block below: this suite mocks its hooks at module scope, so a value
 * left set by one test is read by the next one that renders.
 */
function resetFixtures(): void {
  cleanup();
  fixtures.providers = [];
  fixtures.startLoginMutate.mockReset();
  fixtures.startLoginPending = false;
  fixtures.startLoginSuccess = false;
  fixtures.startLoginData = undefined;
  fixtures.awaitLoginMutate.mockReset();
  fixtures.awaitLoginReset.mockReset();
  fixtures.awaitLoginSuccess = false;
  fixtures.awaitLoginData = undefined;
  fixtures.setEnabledMutate.mockReset();
  fixtures.setEnabledPending = false;
  fixtures.setEnabledVariables = undefined;
  fixtures.isLocalMachine = true;
  fixtures.toastError.mockReset();
}

/**
 * Render the codex row and drive it to the point where the login started.
 *
 * `strict` renders under `<StrictMode>`, which is how the desktop and mobile
 * dev builds actually mount this act - and the one place an effect runs
 * setup -> cleanup -> setup.
 */
function startSignInAttempt(strict: boolean): RenderResult {
  fixtures.providers = [fixtures.signInProvider];
  const tree = <OnboardingDetectedAgents />;
  const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  fireEvent.click(signInButton());
  const [, startOptions] = latestStartLoginCall();
  act(() => {
    startOptions.onSuccess({ started: true });
  });
  return view;
}

describe("OnboardingDetectedAgents", () => {
  afterEach(resetFixtures);

  it("renders providers in the shared provider order", () => {
    render(<OnboardingDetectedAgents />);

    const expectedNames = [
      "Codex",
      "Claude Code",
      "OpenCode",
      "Traycer Inference",
      "OpenRouter",
      "Hugging Face",
      "Droid",
      "Cursor",
      "Copilot",
      "Grok",
      "Kiro",
      "Kilo Code",
      "Kimi",
      "Qwen Code",
      "Antigravity",
      "Amp",
      "Devin",
      "Pi",
      "Hermes Agent",
      "Oh My Pi",
      "Reasonix",
    ];
    const textOrEmpty = (text: string | null): string => text ?? "";
    // Longest match, not first match: display names overlap ("Pi" is a
    // substring of "Oh My Pi"), so a first-match probe would label the Oh My Pi
    // row "Pi" and silently pass a wrong order.
    const longestMatch = (text: string): string =>
      expectedNames
        .filter((name) => text.includes(name))
        .reduce(
          (longest, name) => (name.length > longest.length ? name : longest),
          "",
        );

    expect(
      screen.getAllByRole("listitem").map((row) => {
        const text = textOrEmpty(row.textContent);
        return longestMatch(text);
      }),
    ).toEqual(expectedNames);
  });

  it("puts enabled providers before disabled providers", () => {
    fixtures.providers = [
      { ...fixtures.signInProvider, providerId: "codex", enabled: false },
      {
        ...fixtures.signInProvider,
        providerId: "claude-code",
        enabled: true,
      },
    ];
    render(<OnboardingDetectedAgents />);

    const firstRows = screen
      .getAllByRole("listitem")
      .slice(0, 2)
      .map((row) => row.textContent);
    expect(firstRows[0]).toContain("Claude Code");
    expect(firstRows[1]).toContain("Codex");
  });

  it("shows a disabled Traycer card without sign-in or 'Not signed in' copy", () => {
    // Traycer seeds disabled on purpose (its inference bills credits), and its
    // account IS the host session - there is nothing to sign into. Without the
    // traycer guard in `providerNeedsSignInToEnable`, the row would fall
    // through `providerSignInUnavailableHint` to a muted "Not signed in",
    // which is exactly backwards for the one provider that is always signed
    // in. The card is the enable gesture.
    fixtures.providers = [
      {
        ...fixtures.signInProvider,
        providerId: "traycer",
        loginCapability: null,
      },
    ];
    render(<OnboardingDetectedAgents />);

    expect(
      screen.queryByRole("button", { name: /sign in & enable/i }),
    ).toBeNull();
    expect(screen.queryByText("Not signed in")).toBeNull();
    expect(
      screen.getByText("Available with your Traycer subscription"),
    ).toBeTruthy();
    expect(providerButton("Traycer Inference", false)).toBeTruthy();
  });

  // "Off" is not evidence that an account is missing. These two rows carry
  // POSITIVE evidence of credentials that needs no probe, so the sign-in
  // affordance is wrong on both - the row is one toggle away from working.
  it("shows a disabled provider card without sign-in copy when its API key is configured", () => {
    // The actively wrong case, not merely the redundant one. An API-key-only
    // provider ships no `oauthArgs`, so it fell to
    // `providerSignInUnavailableHint`'s first branch and rendered a muted "Not
    // signed in" over a key the user had already set - under a hint telling
    // them to go set one.
    fixtures.providers = [
      {
        ...fixtures.signInProvider,
        loginCapability: null,
        apiKey: { supported: true, configured: true, source: "stored" },
      },
    ];
    render(<OnboardingDetectedAgents />);

    expect(
      screen.queryByRole("button", { name: /sign in & enable/i }),
    ).toBeNull();
    expect(screen.queryByText("Not signed in")).toBeNull();
    expect(providerButton("Codex", false)).toBeTruthy();
  });

  it("enables a disabled provider card directly when its account is already signed in", () => {
    fixtures.providers = [
      {
        ...fixtures.signInProvider,
        auth: {
          status: "authenticated",
          badgeText: null,
          label: null,
          detail: null,
        },
      },
    ];
    render(<OnboardingDetectedAgents />);

    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /sign in & enable/i }),
    ).toBeNull();
    fireEvent.click(providerButton("Codex", false));

    expect(fixtures.setEnabledMutate).toHaveBeenCalledTimes(1);
    expect(fixtures.startLoginMutate).not.toHaveBeenCalled();
  });

  it("toggles the provider card, keeps the initial enabled-first order, and leaves sign-in as a sibling action", () => {
    fixtures.providers = [
      { ...fixtures.signInProvider, providerId: "codex", enabled: false },
      {
        ...fixtures.signInProvider,
        providerId: "claude-code",
        enabled: true,
      },
    ];
    const view = render(<OnboardingDetectedAgents />);

    const names = (): (string | null)[] =>
      screen
        .getAllByRole("listitem")
        .slice(0, 2)
        .map((row) => row.textContent);
    expect(names()[0]).toContain("Claude Code");
    expect(names()[1]).toContain("Codex");

    const codexRow = screen.getByText("Codex").closest("li");
    if (codexRow === null) throw new Error("Expected the Codex provider card.");
    const codexButton = within(codexRow).getByRole("button", {
      name: "Codex",
      pressed: false,
    });
    const signIn = within(codexRow).getByRole("button", {
      name: /sign in & enable/i,
    });
    expect(codexRow.querySelector("button button")).toBeNull();
    expect(codexButton.contains(signIn)).toBe(false);

    fireEvent.click(codexButton);
    expect(fixtures.setEnabledMutate).toHaveBeenCalledWith({
      providerId: "codex",
      enabled: true,
      profileAction: null,
    });

    fixtures.providers = fixtures.providers.map((provider) =>
      provider.providerId === "codex"
        ? { ...provider, enabled: true }
        : provider,
    );
    view.rerender(<OnboardingDetectedAgents />);

    expect(names()[0]).toContain("Claude Code");
    expect(names()[1]).toContain("Codex");
    expect(providerButton("Codex", true)).toBeTruthy();

    fireEvent.click(providerButton("Codex", true));
    expect(fixtures.setEnabledMutate).toHaveBeenLastCalledWith({
      providerId: "codex",
      enabled: false,
      profileAction: null,
    });
    fixtures.providers = fixtures.providers.map((provider) =>
      provider.providerId === "codex"
        ? { ...provider, enabled: false }
        : provider,
    );
    view.rerender(<OnboardingDetectedAgents />);

    expect(names()[0]).toContain("Claude Code");
    expect(names()[1]).toContain("Codex");
    expect(providerButton("Codex", false)).toBeTruthy();
  });

  it("disables the last enabled card and blocks repeated clicks while the mutation is pending", () => {
    fixtures.providers = [
      {
        ...fixtures.signInProvider,
        enabled: true,
        auth: {
          status: "authenticated",
          badgeText: null,
          label: null,
          detail: null,
        },
      },
    ];
    const view = render(<OnboardingDetectedAgents />);
    const codexButton = providerButton("Codex", true);
    // Guarded with a reason: inert but still in the tab order, so the reason
    // it describes stays reachable by keyboard and screen reader.
    expect(codexButton.getAttribute("aria-disabled")).toBe("true");
    expect(codexButton.disabled).toBe(false);
    fireEvent.click(codexButton);
    expect(fixtures.setEnabledMutate).not.toHaveBeenCalled();

    fixtures.providers = [
      ...fixtures.providers,
      { ...fixtures.signInProvider, providerId: "claude-code", enabled: true },
    ];
    view.rerender(<OnboardingDetectedAgents />);
    const enabledCodexButton = providerButton("Codex", true);
    expect(enabledCodexButton.disabled).toBe(false);
    expect(enabledCodexButton.getAttribute("aria-disabled")).toBeNull();

    fixtures.setEnabledPending = true;
    view.rerender(<OnboardingDetectedAgents />);
    const pendingCodexButton = providerButton("Codex", true);
    expect(pendingCodexButton.disabled).toBe(true);
    fireEvent.click(pendingCodexButton);
    expect(fixtures.setEnabledMutate).not.toHaveBeenCalled();
  });

  it("shows enablement pending only on the provider whose mutation is running", () => {
    fixtures.providers = [
      fixtures.signInProvider,
      { ...fixtures.signInProvider, providerId: "claude-code" },
    ];
    const view = render(<OnboardingDetectedAgents />);

    fireEvent.click(providerButton("Codex", false));
    fixtures.setEnabledPending = true;
    fixtures.setEnabledVariables = {
      providerId: "codex",
      enabled: true,
      profileAction: null,
    };
    view.rerender(<OnboardingDetectedAgents />);

    const codexRow = screen.getByText("Codex").closest("li");
    const claudeRow = screen.getByText("Claude Code").closest("li");
    if (codexRow === null || claudeRow === null) {
      throw new Error("Expected both provider rows.");
    }
    const codexSignIn = within(codexRow).getByRole<HTMLButtonElement>(
      "button",
      { name: /sign in & enable/i },
    );
    const claudeSignIn = within(claudeRow).getByRole<HTMLButtonElement>(
      "button",
      { name: /sign in & enable/i },
    );

    expect(codexSignIn.disabled).toBe(true);
    expect(claudeSignIn.disabled).toBe(true);
    expect(codexSignIn.getAttribute("aria-busy")).toBe("true");
    expect(claudeSignIn.getAttribute("aria-busy")).toBe("false");
  });
});

// Regression coverage for the declined-sign-in path: the GUI rules
// (`clients/gui-app/AGENTS.md`, "Backend calls -> TanStack Query") forbid
// ad-hoc `toast.error` in components, so a `providers.startLogin` success with
// `started: false` must render as an inline row error DERIVED from the
// mutation result, not a toast and not `useState`.
describe("SignInToEnableButton declined sign-in", () => {
  afterEach(resetFixtures);

  it("renders the inline alert and does not await login when the CLI declines to start", () => {
    fixtures.providers = [fixtures.signInProvider];
    const view = render(<OnboardingDetectedAgents />);

    fireEvent.click(screen.getByRole("button", { name: /sign in & enable/i }));
    const [, options] = latestStartLoginCall();
    act(() => {
      fixtures.startLoginPending = false;
      fixtures.startLoginSuccess = true;
      fixtures.startLoginData = { started: false };
      options.onSuccess({ started: false });
    });
    view.rerender(<OnboardingDetectedAgents />);

    expect(screen.getByRole("alert").textContent).toBe(
      "Sign-in did not start. Try again.",
    );
    expect(fixtures.awaitLoginMutate).not.toHaveBeenCalled();
  });

  it("renders no alert and awaits login when the CLI starts", () => {
    fixtures.providers = [fixtures.signInProvider];
    const view = render(<OnboardingDetectedAgents />);

    fireEvent.click(screen.getByRole("button", { name: /sign in & enable/i }));
    const [, options] = latestStartLoginCall();
    act(() => {
      fixtures.startLoginPending = false;
      fixtures.startLoginSuccess = true;
      fixtures.startLoginData = { started: true };
      options.onSuccess({ started: true });
    });
    view.rerender(<OnboardingDetectedAgents />);

    expect(screen.queryByRole("alert")).toBeNull();
    const awaitCall = fixtures.awaitLoginMutate.mock.calls.at(-1);
    if (awaitCall === undefined) {
      throw new Error("Expected an awaitLogin call.");
    }
    expect(awaitCall[0]).toEqual({ providerId: "codex", profileId: null });
    // The options object carries the enable-on-authenticated chain; its
    // behaviour is pinned by the next test.
    expect(typeof awaitCall[1].onSuccess).toBe("function");
  });

  it("enables the provider only on an authenticated completion", () => {
    fixtures.providers = [fixtures.signInProvider];
    render(<OnboardingDetectedAgents />);

    fireEvent.click(screen.getByRole("button", { name: /sign in & enable/i }));
    const [, startOptions] = latestStartLoginCall();
    act(() => {
      startOptions.onSuccess({ started: true });
    });
    const awaitCall = fixtures.awaitLoginMutate.mock.calls.at(-1);
    if (awaitCall === undefined) {
      throw new Error("Expected an awaitLogin call.");
    }
    const [, awaitOptions] = awaitCall;

    // A cancelled/failed login (null state) and a signed-out completion must
    // both leave the sticky choice alone - the button is "sign in TO enable",
    // and only a completed, authenticated login is that gesture.
    act(() => {
      awaitOptions.onSuccess({ state: null });
      awaitOptions.onSuccess({
        state: {
          auth: { status: "unauthenticated" },
          authPending: false,
          profiles: [],
        },
      });
    });
    expect(fixtures.setEnabledMutate).not.toHaveBeenCalled();

    act(() => {
      awaitOptions.onSuccess({
        state: {
          auth: { status: "authenticated" },
          authPending: false,
          profiles: [],
        },
      });
    });
    expect(fixtures.setEnabledMutate).toHaveBeenCalledWith({
      providerId: "codex",
      enabled: true,
      profileAction: null,
    });
  });

  it("clears the message once a subsequent attempt is in flight, and stays clear on success", () => {
    fixtures.providers = [fixtures.signInProvider];
    const view = render(<OnboardingDetectedAgents />);

    fireEvent.click(screen.getByRole("button", { name: /sign in & enable/i }));
    const [, firstOptions] = latestStartLoginCall();
    act(() => {
      fixtures.startLoginPending = false;
      fixtures.startLoginSuccess = true;
      fixtures.startLoginData = { started: false };
      firstOptions.onSuccess({ started: false });
    });
    view.rerender(<OnboardingDetectedAgents />);
    expect(screen.getByRole("alert")).toBeTruthy();

    // A fresh `mutate()` resets `isSuccess` synchronously, before the new
    // attempt resolves - the derived `declined` flag must clear at that
    // point, not only once the retry succeeds.
    fireEvent.click(screen.getByRole("button", { name: /sign in & enable/i }));
    act(() => {
      fixtures.startLoginPending = true;
      fixtures.startLoginSuccess = false;
      fixtures.startLoginData = undefined;
    });
    view.rerender(<OnboardingDetectedAgents />);
    expect(screen.queryByRole("alert")).toBeNull();

    const [, secondOptions] = latestStartLoginCall();
    act(() => {
      fixtures.startLoginPending = false;
      fixtures.startLoginSuccess = true;
      fixtures.startLoginData = { started: true };
      secondOptions.onSuccess({ started: true });
    });
    view.rerender(<OnboardingDetectedAgents />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never raises a sonner toast on the declined path", () => {
    fixtures.providers = [fixtures.signInProvider];
    const view = render(<OnboardingDetectedAgents />);

    fireEvent.click(screen.getByRole("button", { name: /sign in & enable/i }));
    const [, options] = latestStartLoginCall();
    act(() => {
      fixtures.startLoginPending = false;
      fixtures.startLoginSuccess = true;
      fixtures.startLoginData = { started: false };
      options.onSuccess({ started: false });
    });
    view.rerender(<OnboardingDetectedAgents />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(fixtures.toastError).not.toHaveBeenCalled();
  });
});

// The window where `providers.awaitLogin` has settled but the host's ambient
// auth probe has not. It is not a verdict, and a button whose whole promise is
// "Sign in & enable" must not silently decline to enable on one.
describe("SignInToEnableButton unsettled auth verdict", () => {
  afterEach(resetFixtures);

  it("re-polls an unsettled ambient verdict instead of reading it as a failed sign-in", () => {
    // The host's `providers.awaitLogin` can settle before its auth probe does
    // (the login runner evicts the ambient cache when the child closes; older
    // hosts always assemble the response from a non-blocking probe). Reading
    // that window as "not authenticated" would make a button called "Sign in
    // to enable" complete a successful sign-in and then silently not enable.
    vi.useFakeTimers();
    try {
      startSignInAttempt(false);
      expect(fixtures.awaitLoginMutate).toHaveBeenCalledTimes(1);

      act(() => {
        latestAwaitLoginOptions().onSuccess({
          state: {
            auth: { status: "unknown" },
            authPending: true,
            profiles: [],
          },
        });
      });
      expect(fixtures.setEnabledMutate).not.toHaveBeenCalled();
      // Still this button's work, so it stays busy: neither mutation is in
      // flight during the gap, and an idle-looking button invites a second
      // login child for a sign-in that is about to land.
      expect(signInButton()).toHaveProperty("disabled", true);

      act(() => {
        vi.advanceTimersByTime(AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS);
      });
      expect(fixtures.awaitLoginMutate).toHaveBeenCalledTimes(2);

      act(() => {
        latestAwaitLoginOptions().onSuccess({
          state: {
            auth: { status: "authenticated" },
            authPending: false,
            profiles: [],
          },
        });
      });
      expect(fixtures.setEnabledMutate).toHaveBeenCalledWith({
        providerId: "codex",
        enabled: true,
        profileAction: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("spends the shared re-poll budget and then stops, without enabling", () => {
    vi.useFakeTimers();
    try {
      startSignInAttempt(false);
      // One completion per await: the initial one plus each re-poll. The last
      // iteration is the one whose completion finds the budget spent.
      for (
        let attempt = 0;
        attempt <= AMBIENT_AUTH_PENDING_REPOLL_CAP;
        attempt += 1
      ) {
        act(() => {
          latestAwaitLoginOptions().onSuccess({
            state: {
              auth: { status: "unknown" },
              authPending: true,
              profiles: [],
            },
          });
        });
        act(() => {
          vi.advanceTimersByTime(AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS);
        });
      }

      expect(fixtures.awaitLoginMutate).toHaveBeenCalledTimes(
        AMBIENT_AUTH_PENDING_REPOLL_CAP + 1,
      );
      // A never-settled probe is not consent to enable, and it must not leave
      // the button spinning forever either.
      expect(fixtures.setEnabledMutate).not.toHaveBeenCalled();
      expect(signInButton()).toHaveProperty("disabled", false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a DEFINITIVE unauthenticated verdict as final, pending flag or not", () => {
    // `authPending` alone does not buy time - only an unsettled STATUS does.
    // A host that reports a settled `unauthenticated` while some other probe
    // is still running has already answered this question.
    vi.useFakeTimers();
    try {
      startSignInAttempt(false);
      act(() => {
        latestAwaitLoginOptions().onSuccess({
          state: {
            auth: { status: "unauthenticated" },
            authPending: true,
            profiles: [],
          },
        });
      });
      act(() => {
        vi.advanceTimersByTime(
          AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS *
            (AMBIENT_AUTH_PENDING_REPOLL_CAP + 1),
        );
      });

      expect(fixtures.awaitLoginMutate).toHaveBeenCalledTimes(1);
      expect(fixtures.setEnabledMutate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// The attempt that ends without an account used to end SILENTLY: the spinner
// stopped, the card had not changed state, and nothing said the enable this
// button promised had not happened.
describe("SignInToEnableButton unauthenticated outcome", () => {
  afterEach(resetFixtures);

  const FAILED_OUTCOMES: readonly {
    readonly label: string;
    readonly completion: AwaitLoginCompletion;
  }[] = [
    {
      label: "a cancelled login the host has no outcome for",
      completion: { state: null },
    },
    {
      label: "a settled unauthenticated verdict",
      completion: {
        state: {
          auth: { status: "unauthenticated" },
          authPending: false,
          profiles: [],
        },
      },
    },
  ];

  /**
   * Settle the attempt and re-render.
   *
   * The mock has to advance the way the real hook does - `isSuccess`/`data`
   * carry the completion once the mutation resolves, and the message is DERIVED
   * from them. The explicit re-render is not ceremony: `handleCompletion` ends
   * these paths with `setSettling(false)` while `settling` is ALREADY false, so
   * React bails out and nothing re-reads the fixtures on its own.
   */
  function settleWith(
    view: RenderResult,
    completion: AwaitLoginCompletion,
  ): void {
    act(() => {
      latestAwaitLoginOptions().onSuccess(completion);
    });
    fixtures.awaitLoginSuccess = true;
    fixtures.awaitLoginData = completion;
    act(() => {
      view.rerender(<OnboardingDetectedAgents />);
    });
  }

  for (const { label, completion } of FAILED_OUTCOMES) {
    it(`states the outcome in the row after ${label}`, () => {
      settleWith(startSignInAttempt(false), completion);

      expect(fixtures.setEnabledMutate).not.toHaveBeenCalled();
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("did not complete");
      expect(alert.textContent).toContain("still off");
    });
  }

  it("says nothing when the sign-in DID authenticate", () => {
    settleWith(startSignInAttempt(false), {
      state: {
        auth: { status: "authenticated" },
        authPending: false,
        profiles: [],
      },
    });

    expect(fixtures.setEnabledMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retries the ENABLE, not the login, after an authenticated sign-in whose enable failed", () => {
    // Sign-in succeeded; the enable is what did not take, so the row is still
    // off and this button is still rendered. Pressing it again must resume at
    // the failed step. Restarting the login is not just wasted work: a CLI that
    // refuses to start one while already signed in answers `started: false`, so
    // the retry would report "sign-in did not start" and the button could never
    // do what it advertises.
    const view = startSignInAttempt(false);
    settleWith(view, {
      state: {
        auth: { status: "authenticated" },
        authPending: false,
        profiles: [],
      },
    });
    expect(fixtures.setEnabledMutate).toHaveBeenCalledTimes(1);

    fireEvent.click(providerButton("Codex", false));

    // The enable was retried directly, and no second OAuth flow was spawned.
    expect(fixtures.setEnabledMutate).toHaveBeenCalledTimes(2);
    expect(fixtures.startLoginMutate).toHaveBeenCalledTimes(1);
  });

  it("does not carry a settled verdict into an attempt that never started", () => {
    // The two messages are only mutually exclusive because each attempt RESETS
    // the await mutation. Without that, attempt 1's completion outlives it: a
    // retry whose `startLogin` comes back `started: false` never calls
    // `awaitLogin`, ends pending, and the row renders "did not start" AND "did
    // not complete" together - the second describing an attempt the user has
    // already moved on from.
    const view = startSignInAttempt(false);
    settleWith(view, { state: null });
    expect(screen.getByRole("alert").textContent).toContain("did not complete");

    // Retry, this time declined by the host.
    fireEvent.click(signInButton());
    const [, startOptions] = latestStartLoginCall();
    act(() => {
      startOptions.onSuccess({ started: false });
    });
    fixtures.startLoginSuccess = true;
    fixtures.startLoginData = { started: false };
    act(() => {
      view.rerender(<OnboardingDetectedAgents />);
    });

    expect(fixtures.awaitLoginReset).toHaveBeenCalled();
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain("did not start");
  });

  it("hides the previous verdict while a fresh attempt is running", () => {
    // `startLogin.mutate` does not touch `awaitLogin`, so its `data` survives
    // into the retry it is no longer about. Without the pending gate the row
    // would accuse the attempt that is currently spinning.
    const view = startSignInAttempt(false);
    settleWith(view, { state: null });
    expect(screen.getByRole("alert").textContent).toContain("did not complete");

    fixtures.startLoginPending = true;
    act(() => {
      view.rerender(<OnboardingDetectedAgents />);
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  // The completion carries TWO views of the same ambient login - the top-level
  // summary and the ambient profile ROW - and they converge at different
  // times. Deciding on the summary alone is wrong in both directions, so both
  // directions are pinned here.
  it("enables on an ambient PROFILE row that authenticates before the summary does", () => {
    // Summary still lagging at a non-definitive `unavailable`, and no probe in
    // flight (`authPending: false`), so nothing re-polls. Reading only the
    // top-level status calls a successful sign-in a failure and states "did not
    // complete" over an account that is in fact signed in.
    settleWith(startSignInAttempt(false), {
      state: {
        auth: { status: "unavailable" },
        authPending: false,
        profiles: [{ kind: "ambient", auth: { status: "authenticated" } }],
      },
    });

    expect(fixtures.setEnabledMutate).toHaveBeenCalledTimes(1);
    // The complement half: both phases derive from ONE verdict, so a
    // completion that enables can never also render the failure message.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses to enable when the ambient row definitively contradicts a stale top-level authenticated", () => {
    // Signed-out wins. The auth poison and the probe-less `providers.list`
    // path stamp a definitive `unauthenticated` on the ambient ROW the instant
    // a credential fails, while the summary can still be carrying the previous
    // `authenticated`. Enabling on the stale half hands the user a provider
    // whose next turn cannot run.
    settleWith(startSignInAttempt(false), {
      state: {
        auth: { status: "authenticated" },
        authPending: false,
        profiles: [{ kind: "ambient", auth: { status: "unauthenticated" } }],
      },
    });

    expect(fixtures.setEnabledMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("did not complete");
  });

  it("reads the AMBIENT row only - a managed profile is not the terminal account", () => {
    // This button always signs in ambiently (`profileId: null`), so a healthy
    // MANAGED profile says nothing about whether the terminal account got an
    // account. A verdict that scanned every row would enable here on the
    // strength of a login this attempt never performed.
    settleWith(startSignInAttempt(false), {
      state: {
        auth: { status: "unauthenticated" },
        authPending: false,
        profiles: [{ kind: "managed", auth: { status: "authenticated" } }],
      },
    });

    expect(fixtures.setEnabledMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("did not complete");
  });
});

// Two ways the button can look done while it is not: an unmount latch that
// StrictMode leaves stuck on, and a spinner that stops at the AUTHENTICATION
// boundary rather than the enable this button actually promises.
describe("SignInToEnableButton pending lifecycle", () => {
  afterEach(resetFixtures);

  it("still enables under StrictMode, whose effects run setup - cleanup - setup", () => {
    // The dev builds mount this act inside `<StrictMode>`, so the unmount
    // latch is set by that first throwaway cleanup. A latch that is only ever
    // SET would then make every completion return early for the life of the
    // button - the sign-in completes and the provider silently stays off,
    // exactly where a developer would be looking at it.
    startSignInAttempt(true);

    act(() => {
      latestAwaitLoginOptions().onSuccess({
        state: {
          auth: { status: "authenticated" },
          authPending: false,
          profiles: [],
        },
      });
    });

    expect(fixtures.setEnabledMutate).toHaveBeenCalledWith({
      providerId: "codex",
      enabled: true,
      profileAction: null,
    });
  });

  it("stays pending through the enable, not just through the authentication", () => {
    // `providers.setEnabled` is the parent's mutation and the row only flips
    // once its refresh lands, so between those two moments the button would
    // otherwise re-arm - long enough for a second press to spawn a redundant
    // login child for a provider already being turned on.
    const view = startSignInAttempt(false);

    act(() => {
      latestAwaitLoginOptions().onSuccess({
        state: {
          auth: { status: "authenticated" },
          authPending: false,
          profiles: [],
        },
      });
    });
    expect(fixtures.setEnabledMutate).toHaveBeenCalledTimes(1);

    act(() => {
      fixtures.setEnabledPending = true;
    });
    view.rerender(<OnboardingDetectedAgents />);
    expect(signInButton()).toHaveProperty("disabled", true);

    // ...and it comes back if the enable fails, so a failed mutation cannot
    // strand the row with a dead button.
    act(() => {
      fixtures.setEnabledPending = false;
    });
    view.rerender(<OnboardingDetectedAgents />);
    expect(signInButton()).toHaveProperty("disabled", false);
  });
});

// The row is where the enable lives, so anything that can unmount it mid-
// attempt can strand a successful sign-in with the provider still off.
describe("SignInToEnableButton mount survival", () => {
  afterEach(resetFixtures);

  it("stays mounted when the authenticated echo lands before the completion callback", () => {
    // `awaitLogin`'s own `onSuccess` overlays the authenticated echo into
    // `providers.list` and AWAITS that invalidation before TanStack runs the
    // per-`mutate` `onSuccess` this button enables from - and TanStack drops
    // those per-call callbacks once the observer unmounts
    // (`use-host-scoped-mutation.ts`). So a mount gate that reads the ambient
    // auth verdict deletes this row in exactly that window: the account
    // authenticates and the provider stays OFF, which is the single outcome
    // this button exists to prevent.
    const view = startSignInAttempt(false);

    // The overlay: authenticated now, still disabled.
    fixtures.providers = [
      {
        ...fixtures.signInProvider,
        auth: {
          status: "authenticated",
          badgeText: null,
          label: null,
          detail: null,
        },
      },
    ];
    act(() => {
      view.rerender(<OnboardingDetectedAgents />);
    });

    // The provider card remains available even though the separate sign-in
    // action disappears once the auth echo lands.
    expect(providerButton("Codex", false)).toBeTruthy();

    // ...and so the completion still reaches the enable.
    act(() => {
      latestAwaitLoginOptions().onSuccess({
        state: {
          auth: { status: "authenticated" },
          authPending: false,
          profiles: [],
        },
      });
    });
    expect(fixtures.setEnabledMutate).toHaveBeenCalledTimes(1);
  });
});

// Sign-in AVAILABILITY and sign-in NECESSITY are different questions, and the
// row asked the first one first. For an account that needs no login the answer
// is irrelevant, and letting it win renders a false status over a working
// account while withholding the only action left.
describe("SignInToEnableButton already-authenticated with sign-in unavailable", () => {
  afterEach(resetFixtures);

  it("enables an authenticated provider that cannot start a browser sign-in", () => {
    // No `oauthArgs`, so `providerSignInUnavailableHint` is non-null and its
    // early return used to win - rendering the muted "Not signed in" fallback
    // over an authenticated account. The same shape is reached by a
    // terminal-login provider and by any OAuth provider on a remote host.
    fixtures.providers = [
      {
        ...fixtures.signInProvider,
        loginCapability: null,
        auth: {
          status: "authenticated",
          badgeText: null,
          label: null,
          detail: null,
        },
      },
    ];
    render(<OnboardingDetectedAgents />);

    expect(screen.queryByText("Not signed in")).toBeNull();

    fireEvent.click(providerButton("Codex", false));

    expect(fixtures.setEnabledMutate).toHaveBeenCalledTimes(1);
    expect(fixtures.startLoginMutate).not.toHaveBeenCalled();
  });

  it("still states the unavailable hint when the account is NOT signed in", () => {
    // The gate is skipped only for an authenticated account. Without this
    // control the fix above would read as "the hint never renders", which
    // would be a different bug wearing the same green.
    //
    // The hint is no longer a visible caption row - it would have been a third
    // line of grey text on most of the board - so this asserts what a screen
    // reader gets from the status line, which is where the redesign moved it.
    fixtures.providers = [
      { ...fixtures.signInProvider, loginCapability: null },
    ];
    render(<OnboardingDetectedAgents />);

    expect(screen.getByText("Not signed in")).toBeTruthy();
    expect(screen.queryByText("Sign-in unavailable here")).toBeNull();
    expect(
      screen.getByText(/Codex does not support browser sign-in\./),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /sign in & enable/i }),
    ).toBeNull();
  });
});

// A terminal-login provider signs in from a PTY the host opens. Onboarding has
// no canvas and no terminal panel to open one into - deliberately, so this
// screen offers no sign-in affordance for that class at all. What it used to
// offer was WORSE than nothing: `providerSignInUnavailableHint` answered the
// terminal branch first, so the mounted button collapsed to a dead, tooltip'd
// "Not signed in" label sitting next to a switch that already worked.
//
// The population is the part most likely to be got wrong, so it is stated
// here rather than inferred: the gate reads `terminalLogin` ALONE, so this is
// a change to the SIX providers that declare it today - opencode, qwen,
// droid, copilot, omp and reasonix - not to the providers the terminal
// sign-in design adds later. The fixture below is copilot's real shape.
describe("OnboardingDetectedAgents terminal-login rows", () => {
  afterEach(resetFixtures);

  const TERMINAL_SETUP_SUBTEXT =
    "Turn it on now. The first time you pick it, the model picker will walk you through its terminal setup.";

  // The base fixture with `terminalLogin` declared. Every OTHER input the
  // three guards read is held where the base fixture has it - not `traycer`,
  // `apiKey.configured` false, installed, disabled - and `oauthArgs` stays
  // NON-null, so no pre-existing guard and no `providerSignInUnavailableHint`
  // branch can account for anything asserted below. Against the headless
  // control at the bottom of this block, `terminalLogin` is the varied field.
  //
  // Copilot's real row in `cli-profiles.ts`: `oauthArgs` is kept alongside
  // `terminalLogin` so a client predating the capability still renders a
  // sign-in the host harmlessly refuses. So this shape is measured, not
  // constructed to suit the test.
  const terminalLoginRow: ProviderCliState = {
    ...fixtures.signInProvider,
    providerId: "copilot",
    loginCapability: {
      oauthArgs: ["login"],
      token: null,
      codePaste: null,
      terminalLogin: {},
      remoteSafe: null,
      selfOpensBrowser: null,
    },
  };

  /** Rows 1-3 of the matrix all render identically; this is that shape. */
  function expectToggleOnlyWithSubtext(): void {
    expect(
      screen.queryByRole("button", { name: /sign in & enable/i }),
    ).toBeNull();
    // The line the subtext displaces, and the one assertion here that still
    // DISCRIMINATES after the tours redesign (#1974).
    //
    // This block originally asserted `queryByText("Disabled")` was null, on
    // the reasoning that the subtext had replaced that word. #1974 removed the
    // `!state.enabled` early return from `accountLineFor` outright, so
    // "Disabled" is now absent from EVERY row and that assertion would pass on
    // a row this change never touched - vacuous, and worse than nothing since
    // it reads as coverage. A disabled terminal-login row now falls through to
    // the auth ladder and would land on "Not signed in", so that is what the
    // subtext displaces and what must be absent.
    expect(screen.queryByText("Not signed in")).toBeNull();
    // The enable gesture is the CARD since #1974 - a toggle button named for
    // the provider carrying `aria-pressed` - not the separate switch this
    // block was first written against. `pressed: false` is load-bearing: it is
    // what makes this an assertion about a DISABLED row rather than merely a
    // present control.
    expect(
      screen.getByRole("button", { name: "Copilot", pressed: false }),
    ).toBeTruthy();
    expect(screen.getByText(TERMINAL_SETUP_SUBTEXT)).toBeTruthy();
  }

  it("shows the toggle and the setup subtext, never the dead label, on a local host", () => {
    fixtures.providers = [terminalLoginRow];
    render(<OnboardingDetectedAgents />);

    expectToggleOnlyWithSubtext();

    // The user is not blocked, which is the whole basis for suppressing the
    // affordance rather than replacing it: the card IS the enable gesture and
    // it works from here.
    fireEvent.click(screen.getByRole("button", { name: "Copilot" }));
    expect(fixtures.setEnabledMutate).toHaveBeenCalledWith({
      providerId: "copilot",
      enabled: true,
      profileAction: null,
    });
  });

  it("is identical on a REMOTE host - terminal login has no locality gate", () => {
    // The control that is easiest to get backwards. The terminal branch of
    // `providerSignInUnavailableHint` is answered BEFORE its remote-host
    // branch, and a terminal login genuinely works remotely (the PTY opens on
    // whichever host the composer runs on) - so "a remote host is unchanged"
    // is false for this class: a remote terminal-login row gets exactly the
    // local treatment. Only a NON-terminal-login provider keeps the remote
    // label, and onboarding really can target a remote host.
    fixtures.isLocalMachine = false;
    fixtures.providers = [terminalLoginRow];
    render(<OnboardingDetectedAgents />);

    expectToggleOnlyWithSubtext();
  });

  it("covers a `configured` credential, which is not a short-circuit", () => {
    // The second control the prose version got backwards. "Signed out" is too
    // narrow: `authenticatedAwaitingEnable` short-circuits only on a
    // definitive `authenticated`, so a credential that exists but was never
    // validated resolves `configured`, seeds the provider OFF, and lands in
    // this row today - where the old affordance would tell it to go sign in.
    fixtures.providers = [
      {
        ...terminalLoginRow,
        auth: {
          status: "configured",
          badgeText: null,
          label: null,
          detail: "Credential found, not verified",
        },
      },
    ];
    render(<OnboardingDetectedAgents />);

    expectToggleOnlyWithSubtext();
  });

  it("suppresses the affordance for an `authenticated` account, and does NOT promise it a setup walkthrough", () => {
    // The row where the two predicates part company, and the one T7's matrix
    // gets wrong. The matrix says "unchanged from today (direct-enable arm
    // still reached)", which the specified change cannot deliver: the guard
    // lives in `providerNeedsSignInToEnable`, which DECIDES MOUNTING and may
    // only read inputs constant across an attempt - and the ambient auth
    // verdict is the docblock's own named counter-example, because keying
    // mounting on it unmounts the row in the window the enable still needs.
    // So the guard cannot be narrowed to "not authenticated", and this row
    // loses the button with the rest of the class.
    //
    // Nothing is lost by that: the button's authenticated branch only calls
    // `onEnable`, and the card itself does the same thing under an aria-label
    // that already names the provider. The direct-enable arm itself is still
    // exercised, by the headless row's own test above ("enables directly,
    // without a login, for a disabled provider that is already signed in").
    //
    // The DESCRIPTION is a separate question and takes the opposite answer,
    // which is why the subtext carries its own condition. This user has
    // nothing to set up - the picker will not walk them through anything - so
    // the subtext would describe an event that never happens. Since #1974 the
    // true sentence here is the account's own, "Signed in", rather than the
    // "Disabled" this row used to show; reading the verdict for a display
    // choice is safe in a way reading it for a mount choice is not.
    fixtures.providers = [
      {
        ...terminalLoginRow,
        auth: {
          status: "authenticated",
          badgeText: null,
          label: null,
          detail: null,
        },
      },
    ];
    render(<OnboardingDetectedAgents />);

    expect(
      screen.queryByRole("button", { name: /sign in & enable/i }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Copilot", pressed: false }),
    ).toBeTruthy();
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.queryByText(TERMINAL_SETUP_SUBTEXT)).toBeNull();
    expect(fixtures.startLoginMutate).not.toHaveBeenCalled();
  });

  it("leaves a headless-only row alone - 'Sign in & enable' and the account line both stay", () => {
    // The row that keeps the guard from over-applying, and the ablation that
    // makes the four above mean something: same provider shape, same install
    // state, same signed-out account, `terminalLogin: null` instead of `{}`.
    // A guard that read anything wider than `terminalLogin` would take this
    // row's button too.
    fixtures.providers = [fixtures.signInProvider];
    render(<OnboardingDetectedAgents />);

    expect(signInButton()).toBeTruthy();
    // "Not signed in", not "Disabled": #1974 removed the enabled/disabled word
    // from `accountLineFor`, so a signed-out headless row now shows its account
    // status. This is the positive half of the same discrimination the helper
    // makes negatively - the line a terminal-login row does NOT get.
    expect(screen.getByText("Not signed in")).toBeTruthy();
    expect(screen.queryByText(TERMINAL_SETUP_SUBTEXT)).toBeNull();
  });
});
