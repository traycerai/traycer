import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
  fixtures.awaitLoginReset.mockReset();
  fixtures.awaitLoginSuccess = false;
  fixtures.awaitLoginData = undefined;
  fixtures.setEnabledMutate.mockReset();
  fixtures.setEnabledPending = false;
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

  // "Off" is not evidence that an account is missing. These two rows carry
  // POSITIVE evidence of credentials that needs no probe, so the sign-in
  // affordance is wrong on both - the row is one toggle away from working.
  it("shows only the toggle for a disabled provider whose API key is already configured", () => {
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
      screen.queryByRole("button", { name: /sign in to enable/i }),
    ).toBeNull();
    expect(screen.queryByText("Not signed in")).toBeNull();
    expect(screen.getByRole("switch", { name: /^Enable / })).toBeTruthy();
  });

  it("enables directly, without a login, for a disabled provider that is already signed in", () => {
    // A provider the user deliberately switched off keeps its account, so the
    // remaining gesture is the ENABLE. Starting an OAuth round trip would
    // arrive exactly where they already were - and a CLI that refuses to start
    // a login while signed in answers `started: false`, so the press would
    // report a failure for a state that is not one.
    //
    // The row still MOUNTS: the auth verdict decides what a press does, never
    // whether the row exists. Keying mounting on it is what strands the enable
    // (see the mid-attempt test below).
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

    fireEvent.click(signInButton());

    expect(fixtures.setEnabledMutate).toHaveBeenCalledTimes(1);
    expect(fixtures.startLoginMutate).not.toHaveBeenCalled();
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
// stopped, the switch had not moved, and nothing said the enable this button
// promises had not happened.
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

    fireEvent.click(signInButton());

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

    // The precondition TanStack actually requires of us.
    expect(
      screen.queryByRole("button", { name: /sign in to enable/i }),
    ).not.toBeNull();

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

    fireEvent.click(signInButton());

    expect(fixtures.setEnabledMutate).toHaveBeenCalledTimes(1);
    expect(fixtures.startLoginMutate).not.toHaveBeenCalled();
  });

  it("still shows the unavailable hint when the account is NOT signed in", () => {
    // The gate is skipped only for an authenticated account. Without this
    // control the fix above would read as "the hint never renders", which
    // would be a different bug wearing the same green.
    fixtures.providers = [
      { ...fixtures.signInProvider, loginCapability: null },
    ];
    render(<OnboardingDetectedAgents />);

    expect(screen.getByText("Not signed in")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /sign in to enable/i }),
    ).toBeNull();
  });
});
