import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderLoginRefusal } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { appLogger } from "@/lib/logger";
import {
  useProviderProfileLoginFlow,
  type AwaitLoginMutation,
  type CancelLoginMutation,
  type EnsurePackMutation,
  type ProviderProfileLoginFlowMode,
  type StartLoginMutation,
  type SubmitLoginCodeMutation,
  type TouchLoginMutation,
} from "@/components/settings/panels/use-provider-profile-login-flow";

// The flow's answer to a provider that accepted the browser consent and then
// refused the account (`providers.awaitLogin@2.2` `refusal`). The sibling
// `-cancel` suite never lets `awaitLogin` settle; this one drives the REAL hook
// against real `useMutation` instances whose `awaitLogin` answers with exactly
// what a host would.

type StartLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.startLogin"
>;
type StartLoginResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.startLogin"
>;
type CancelLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.cancelLogin"
>;
type CancelLoginResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.cancelLogin"
>;
type AwaitLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;
type AwaitLoginResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;
type SubmitLoginCodeRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.submitLoginCode"
>;
type SubmitLoginCodeResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.submitLoginCode"
>;
type TouchLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.touchLogin"
>;
type TouchLoginResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.touchLogin"
>;
type EnsurePackRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.ensurePack"
>;
type EnsurePackResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.ensurePack"
>;

const PROVIDER_ID = "antigravity";
const NOT_FINISHED = "Sign-in did not finish.";
const NOT_STARTED = "Sign-in did not start.";

const REFUSAL: ProviderLoginRefusal = {
  reason:
    "Your current account is not eligible for Antigravity. Verify your account to continue.",
  actionUrl: "https://accounts.google.com/signin/continue?sarp=1&scc=1",
};

function startedAnswer(
  overrides: Partial<StartLoginResponse>,
): StartLoginResponse {
  return {
    url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=agy",
    started: true,
    profileId: "p-1",
    userCode: null,
    failure: null,
    pending: null,
    pack: null,
    ...overrides,
  };
}

function awaitAnswer(
  overrides: Partial<AwaitLoginResponse>,
): AwaitLoginResponse {
  return {
    state: null,
    existingProfileId: null,
    codeRejected: false,
    refusal: null,
    ...overrides,
  };
}

function queryClientWrapper(): (props: {
  readonly children: ReactNode;
}) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function LoginFlowHarness(props: {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly existingProfileId: string | null;
  readonly startLoginImpl: (
    request: StartLoginRequest,
  ) => Promise<StartLoginResponse>;
  readonly awaitLoginImpl: (
    request: AwaitLoginRequest,
  ) => Promise<AwaitLoginResponse>;
  readonly onFailed: (message: string) => void;
}): ReactNode {
  const startLogin: StartLoginMutation = useMutation<
    StartLoginResponse,
    HostRpcError,
    StartLoginRequest,
    { readonly hostId: string | null }
  >({
    mutationFn: props.startLoginImpl,
    onMutate: () => ({ hostId: null }),
  });
  const awaitLogin: AwaitLoginMutation = useMutation<
    AwaitLoginResponse,
    HostRpcError,
    AwaitLoginRequest,
    { readonly hostId: string | null }
  >({
    mutationFn: props.awaitLoginImpl,
    onMutate: () => ({ hostId: null }),
  });
  const cancelLogin: CancelLoginMutation = useMutation<
    CancelLoginResponse,
    HostRpcError,
    CancelLoginRequest,
    { readonly hostId: string | null }
  >({
    mutationFn: () => Promise.resolve({ cancelled: true }),
    onMutate: () => ({ hostId: null }),
  });
  const submitLoginCode: SubmitLoginCodeMutation = useMutation<
    SubmitLoginCodeResponse,
    HostRpcError,
    SubmitLoginCodeRequest
  >({
    mutationFn: () => Promise.resolve({ outcome: "accepted" }),
  });
  const touchLogin: TouchLoginMutation = useMutation<
    TouchLoginResponse,
    HostRpcError,
    TouchLoginRequest
  >({
    mutationFn: () => Promise.resolve({ extended: true }),
  });
  const ensurePack: EnsurePackMutation = useMutation<
    EnsurePackResponse,
    HostRpcError,
    EnsurePackRequest,
    { readonly hostId: string | null }
  >({
    mutationFn: () => Promise.resolve({ managedInstallState: null }),
    onMutate: () => ({ hostId: null }),
  });

  const flow = useProviderProfileLoginFlow({
    supportsLoginOwnership: false,
    mode: props.mode,
    providerId: PROVIDER_ID,
    existingProfileId: props.existingProfileId,
    loginCapability: null,
    startLogin,
    awaitLogin,
    cancelLogin,
    submitLoginCode,
    touchLogin,
    ensurePack,
    failureMessages: { notStarted: NOT_STARTED, notFinished: NOT_FINISHED },
    onFailed: props.onFailed,
  });

  return (
    <div>
      <div data-testid="flow-state">{flow.state.kind}</div>
      <div data-testid="flow-message">
        {flow.state.kind === "failed" ? flow.state.message : ""}
      </div>
      <div data-testid="flow-refusal">
        {flow.state.kind === "failed"
          ? JSON.stringify(flow.state.refusal)
          : "n/a"}
      </div>
      <button
        type="button"
        onClick={() =>
          flow.start({ label: "Test profile", shareSkillsAndPlugins: false })
        }
      >
        start
      </button>
    </div>
  );
}

function renderFlow(options: {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly existingProfileId: string | null;
  readonly startLoginImpl: (
    request: StartLoginRequest,
  ) => Promise<StartLoginResponse>;
  readonly awaitLoginImpl: (
    request: AwaitLoginRequest,
  ) => Promise<AwaitLoginResponse>;
}): { readonly onFailed: Mock<(message: string) => void> } {
  const onFailed = vi.fn<(message: string) => void>();
  render(<LoginFlowHarness {...options} onFailed={onFailed} />, {
    wrapper: queryClientWrapper(),
  });
  fireEvent.click(screen.getByRole("button", { name: "start" }));
  return { onFailed };
}

function flowState(): string | null {
  return screen.getByTestId("flow-state").textContent;
}

function failedRefusal(): unknown {
  return JSON.parse(screen.getByTestId("flow-refusal").textContent);
}

afterEach(() => {
  cleanup();
});

describe("useProviderProfileLoginFlow - a provider that refuses the completed sign-in", () => {
  it("lands a create-mode flow on `failed` carrying the refusal, with its reason as the message", async () => {
    const { onFailed } = renderFlow({
      mode: "create",
      existingProfileId: null,
      startLoginImpl: () => Promise.resolve(startedAnswer({})),
      awaitLoginImpl: () => Promise.resolve(awaitAnswer({ refusal: REFUSAL })),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(screen.getByTestId("flow-message").textContent).toBe(REFUSAL.reason);
    expect(failedRefusal()).toEqual(REFUSAL);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith(REFUSAL.reason);
  });

  it("keeps a provider-authored refusal in the UI and callback, but never in the warning fields", async () => {
    const sensitiveRefusal: ProviderLoginRefusal = {
      reason: "blocked-person@example.test cannot use account acme-org-123",
      actionUrl: null,
    };
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    try {
      const { onFailed } = renderFlow({
        mode: "create",
        existingProfileId: null,
        startLoginImpl: () => Promise.resolve(startedAnswer({})),
        awaitLoginImpl: () =>
          Promise.resolve(awaitAnswer({ refusal: sensitiveRefusal })),
      });

      await waitFor(() => expect(flowState()).toBe("failed"));
      expect(screen.getByTestId("flow-message").textContent).toBe(
        sensitiveRefusal.reason,
      );
      expect(onFailed).toHaveBeenCalledWith(sensitiveRefusal.reason);
      expect(warn).toHaveBeenCalledWith("[provider-login] flow failed", {
        provider: PROVIDER_ID,
        mode: "create",
        blocker: "authentication",
        message: "Provider refused sign-in",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        sensitiveRefusal.reason,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does the same for a known-profile reauth", async () => {
    renderFlow({
      mode: "reauth",
      existingProfileId: "p-existing",
      startLoginImpl: () => Promise.resolve(startedAnswer({})),
      awaitLoginImpl: () => Promise.resolve(awaitAnswer({ refusal: REFUSAL })),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(screen.getByTestId("flow-message").textContent).toBe(REFUSAL.reason);
    expect(failedRefusal()).toEqual(REFUSAL);
  });

  it("does the same for the ambient reconnect, which otherwise returns quietly to `start` when nothing authenticated", async () => {
    renderFlow({
      mode: "reauth",
      existingProfileId: null,
      startLoginImpl: () => Promise.resolve(startedAnswer({ profileId: null })),
      awaitLoginImpl: () => Promise.resolve(awaitAnswer({ refusal: REFUSAL })),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(failedRefusal()).toEqual(REFUSAL);
  });

  it("keeps a refusal that offers no link, with a null actionUrl", async () => {
    const noLink: ProviderLoginRefusal = {
      reason: "This account cannot be used.",
      actionUrl: null,
    };
    renderFlow({
      mode: "create",
      existingProfileId: null,
      startLoginImpl: () => Promise.resolve(startedAnswer({})),
      awaitLoginImpl: () => Promise.resolve(awaitAnswer({ refusal: noLink })),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(failedRefusal()).toEqual(noLink);
  });

  it("treats the refusal as final even when the same answer also reports a rejected code, instead of restarting the sign-in", async () => {
    const startLoginImpl = vi.fn(() => Promise.resolve(startedAnswer({})));
    renderFlow({
      mode: "create",
      existingProfileId: null,
      startLoginImpl,
      awaitLoginImpl: () =>
        Promise.resolve(awaitAnswer({ codeRejected: true, refusal: REFUSAL })),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(failedRefusal()).toEqual(REFUSAL);
    // Falsification: classify `codeRejected` first and the flow restarts.
    expect(startLoginImpl).toHaveBeenCalledTimes(1);
  });
});

describe("useProviderProfileLoginFlow - failures the flow words itself carry no refusal", () => {
  it("a sign-in that ends without authenticating and without a refusal fails with the flow's own message", async () => {
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    try {
      const { onFailed } = renderFlow({
        mode: "create",
        existingProfileId: null,
        startLoginImpl: () => Promise.resolve(startedAnswer({})),
        awaitLoginImpl: () => Promise.resolve(awaitAnswer({ refusal: null })),
      });

      await waitFor(() => expect(flowState()).toBe("failed"));
      expect(screen.getByTestId("flow-message").textContent).toBe(NOT_FINISHED);
      expect(failedRefusal()).toBeNull();
      expect(onFailed).toHaveBeenCalledWith(NOT_FINISHED);
      expect(warn).toHaveBeenCalledWith("[provider-login] flow failed", {
        provider: PROVIDER_ID,
        mode: "create",
        blocker: "authentication",
        message: NOT_FINISHED,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("a rejected startLogin fails with the flow's own message", async () => {
    renderFlow({
      mode: "create",
      existingProfileId: null,
      startLoginImpl: () => Promise.reject(new Error("host refused")),
      awaitLoginImpl: () => Promise.resolve(awaitAnswer({})),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(screen.getByTestId("flow-message").textContent).toBe(NOT_STARTED);
    expect(failedRefusal()).toBeNull();
  });

  it("a start answer the host declined fails with a null refusal", async () => {
    renderFlow({
      mode: "create",
      existingProfileId: null,
      startLoginImpl: () =>
        Promise.resolve(
          startedAnswer({ started: false, url: null, profileId: null }),
        ),
      awaitLoginImpl: () => Promise.resolve(awaitAnswer({})),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(failedRefusal()).toBeNull();
  });

  it("a failed awaitLogin call fails create mode with a null refusal", async () => {
    renderFlow({
      mode: "create",
      existingProfileId: null,
      startLoginImpl: () => Promise.resolve(startedAnswer({})),
      awaitLoginImpl: () => Promise.reject(new Error("transport down")),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(screen.getByTestId("flow-message").textContent).toBe(NOT_FINISHED);
    expect(failedRefusal()).toBeNull();
  });
});
