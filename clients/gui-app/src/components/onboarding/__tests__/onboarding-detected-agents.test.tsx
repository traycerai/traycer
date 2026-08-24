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
type AwaitLoginMutate = (variables: AwaitLoginVariables) => void;

// `codex` gets the auto-undetected enablement source so it's the one row that
// renders `SignInToEnableButton` - every other provider's row has no cached
// `ProviderCliState` at all, so its trailing content is null and cannot
// collide with the role queries below.
const fixtures = vi.hoisted(() => {
  const signInProvider: ProviderCliState = {
    providerId: "codex",
    enabled: false,
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
    enablementMode: "auto",
    enablementSource: "auto-undetected",
  };
  return {
    signInProvider,
    providers: [] as ProviderCliState[],
    startLoginMutate: vi.fn<StartLoginMutate>(),
    startLoginPending: false,
    startLoginSuccess: false,
    startLoginData: undefined as StartLoginData | undefined,
    awaitLoginMutate: vi.fn<AwaitLoginMutate>(),
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
    mutate: vi.fn(),
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

function latestStartLoginCall(): readonly [
  StartLoginVariables,
  StartLoginOptions,
] {
  const call = fixtures.startLoginMutate.mock.calls.at(-1);
  if (call === undefined) throw new Error("Expected a startLogin call.");
  return call;
}

describe("OnboardingDetectedAgents", () => {
  afterEach(() => {
    cleanup();
    fixtures.providers = [];
    fixtures.startLoginMutate.mockReset();
    fixtures.startLoginPending = false;
    fixtures.startLoginSuccess = false;
    fixtures.startLoginData = undefined;
    fixtures.awaitLoginMutate.mockReset();
    fixtures.toastError.mockReset();
  });

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
});

// Regression coverage for the declined-sign-in path: the GUI rules
// (`clients/gui-app/AGENTS.md`, "Backend calls -> TanStack Query") forbid
// ad-hoc `toast.error` in components, so a `providers.startLogin` success with
// `started: false` must render as an inline row error DERIVED from the
// mutation result, not a toast and not `useState`.
describe("SignInToEnableButton declined sign-in", () => {
  afterEach(() => {
    cleanup();
    fixtures.providers = [];
    fixtures.startLoginMutate.mockReset();
    fixtures.startLoginPending = false;
    fixtures.startLoginSuccess = false;
    fixtures.startLoginData = undefined;
    fixtures.awaitLoginMutate.mockReset();
    fixtures.toastError.mockReset();
  });

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
    expect(fixtures.awaitLoginMutate).toHaveBeenCalledWith({
      providerId: "codex",
      profileId: null,
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
