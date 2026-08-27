import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
    setEnabledMutate: vi.fn<SetEnabledMutate>(),
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
    isPending: false,
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
  }),
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: [{ isActive: true, isLocalMachine: true }],
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
  return screen.getByRole("button", { name: /sign in to enable/i });
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
  fixtures.setEnabledMutate.mockReset();
  fixtures.toastError.mockReset();
}

/** Render the codex row and drive it to the point where the login started. */
function startSignInAttempt(): void {
  fixtures.providers = [fixtures.signInProvider];
  render(<OnboardingDetectedAgents />);
  fireEvent.click(signInButton());
  const [, startOptions] = latestStartLoginCall();
  act(() => {
    startOptions.onSuccess({ started: true });
  });
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

  it("shows only the toggle for a disabled traycer row - no sign-in affordance, no 'Not signed in' fallback", () => {
    // Traycer seeds disabled on purpose (its inference bills credits), and its
    // account IS the host session - there is nothing to sign into. Without the
    // traycer guard in `providerNeedsSignInToEnable`, the row would fall
    // through `providerSignInUnavailableHint` to a muted "Not signed in",
    // which is exactly backwards for the one provider that is always signed
    // in. The enable toggle is the whole gesture.
    fixtures.providers = [
      {
        ...fixtures.signInProvider,
        providerId: "traycer",
        loginCapability: null,
      },
    ];
    render(<OnboardingDetectedAgents />);

    expect(
      screen.queryByRole("button", { name: /sign in to enable/i }),
    ).toBeNull();
    expect(screen.queryByText("Not signed in")).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Enable Traycer Inference" }),
    ).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: /sign in to enable/i }));
    const [, options] = latestStartLoginCall();
    act(() => {
      fixtures.startLoginPending = false;
      fixtures.startLoginSuccess = true;
      fixtures.startLoginData = { started: false };
      options.onSuccess({ started: false });
    });
    view.rerender(<OnboardingDetectedAgents />);

    expect(screen.getByRole("alert").textContent).toBe(
      "Sign-in did not start. Try again when ready.",
    );
    expect(fixtures.awaitLoginMutate).not.toHaveBeenCalled();
  });

  it("renders no alert and awaits login when the CLI starts", () => {
    fixtures.providers = [fixtures.signInProvider];
    const view = render(<OnboardingDetectedAgents />);

    fireEvent.click(screen.getByRole("button", { name: /sign in to enable/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /sign in to enable/i }));
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
        state: { auth: { status: "unauthenticated" }, authPending: false },
      });
    });
    expect(fixtures.setEnabledMutate).not.toHaveBeenCalled();

    act(() => {
      awaitOptions.onSuccess({
        state: { auth: { status: "authenticated" }, authPending: false },
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

    fireEvent.click(screen.getByRole("button", { name: /sign in to enable/i }));
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
    fireEvent.click(screen.getByRole("button", { name: /sign in to enable/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /sign in to enable/i }));
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
// "Sign in to enable" must not silently decline to enable on one.
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
      startSignInAttempt();
      expect(fixtures.awaitLoginMutate).toHaveBeenCalledTimes(1);

      act(() => {
        latestAwaitLoginOptions().onSuccess({
          state: { auth: { status: "unknown" }, authPending: true },
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
          state: { auth: { status: "authenticated" }, authPending: false },
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
      startSignInAttempt();
      // One completion per await: the initial one plus each re-poll. The last
      // iteration is the one whose completion finds the budget spent.
      for (
        let attempt = 0;
        attempt <= AMBIENT_AUTH_PENDING_REPOLL_CAP;
        attempt += 1
      ) {
        act(() => {
          latestAwaitLoginOptions().onSuccess({
            state: { auth: { status: "unknown" }, authPending: true },
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
      startSignInAttempt();
      act(() => {
        latestAwaitLoginOptions().onSuccess({
          state: { auth: { status: "unauthenticated" }, authPending: true },
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
