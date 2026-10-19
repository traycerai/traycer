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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostRequestControlFlowError,
  type HostRequestControlFlowReason,
} from "@traycer-clients/shared/host-client/host-request-coordinator";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type { AwaitLoginVariables } from "@/hooks/providers/use-providers-await-login-mutation";
import { appLogger } from "@/lib/logger";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
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

// An `awaitLogin` that rejects without a host verdict ends the attempt on the
// "did not finish" copy, and used to leave no record of why. The flow now
// logs one closed-vocabulary warning: the coordinator's control-flow reason,
// or `rpc-error`. This suite drives the REAL hook against real `useMutation`
// instances, minting every rejection through the REAL boundary
// (`withHostQueryErrorBoundary`), not by constructing its error types.

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
const AWAIT_ENDED = "[provider-login] await ended without a verdict";
const FLOW_FAILED = "[provider-login] flow failed";

const REASONS: readonly HostRequestControlFlowReason[] = [
  "waiter-cancelled",
  "authority-superseded",
  "coordinator-disposed",
];

/** A gate the test opens on its own schedule, so a rejection lands only
 *  after the assertions that precede it have run. */
interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function startedAnswer(): StartLoginResponse {
  return {
    url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=agy",
    started: true,
    profileId: "p-1",
    userCode: null,
    failure: null,
    pending: null,
    pack: null,
  };
}

/** An `awaitLogin` rejection minted by the real boundary from a coordinator
 *  control-flow error, exactly as the GUI's host-RPC layer produces it. */
function controlFlowRejection(
  reason: HostRequestControlFlowReason,
): Promise<AwaitLoginResponse> {
  return withHostQueryErrorBoundary<AwaitLoginResponse>(
    "providers.awaitLogin",
    () => Promise.reject(new HostRequestControlFlowError(reason)),
  );
}

/** The same boundary applied to an ordinary failure (a transport error). */
function transportRejection(): Promise<AwaitLoginResponse> {
  return withHostQueryErrorBoundary<AwaitLoginResponse>(
    "providers.awaitLogin",
    () => Promise.reject(new Error("transport down")),
  );
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
  readonly awaitLoginImpl: (
    variables: AwaitLoginVariables,
  ) => Promise<AwaitLoginResponse>;
}): ReactNode {
  const startLogin: StartLoginMutation = useMutation<
    StartLoginResponse,
    HostRpcError,
    StartLoginRequest,
    { readonly hostId: string | null }
  >({
    mutationFn: () => Promise.resolve(startedAnswer()),
    onMutate: () => ({ hostId: null }),
  });
  const awaitLogin: AwaitLoginMutation = useMutation<
    AwaitLoginResponse,
    HostRpcError,
    AwaitLoginVariables,
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
    hostBlock: null,
    startLogin,
    awaitLogin,
    cancelLogin,
    submitLoginCode,
    touchLogin,
    ensurePack,
    failureMessages: { notStarted: NOT_STARTED, notFinished: NOT_FINISHED },
    onFailed: () => undefined,
  });

  return (
    <div>
      <div data-testid="flow-state">{flow.state.kind}</div>
      <div data-testid="flow-message">
        {flow.state.kind === "failed" ? flow.state.message : ""}
      </div>
      <button
        type="button"
        onClick={() =>
          flow.start({ label: "Test profile", shareSkillsAndPlugins: false })
        }
      >
        start
      </button>
      <button type="button" onClick={() => flow.cancel()}>
        cancel
      </button>
    </div>
  );
}

function renderFlow(options: {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly existingProfileId: string | null;
  readonly awaitLoginImpl: (
    variables: AwaitLoginVariables,
  ) => Promise<AwaitLoginResponse>;
}): void {
  render(<LoginFlowHarness {...options} />, { wrapper: queryClientWrapper() });
  fireEvent.click(screen.getByRole("button", { name: "start" }));
}

function flowState(): string | null {
  return screen.getByTestId("flow-state").textContent;
}

function awaitEndedCalls(warn: {
  readonly mock: { readonly calls: readonly unknown[][] };
}): readonly unknown[][] {
  return warn.mock.calls.filter((call) => call[0] === AWAIT_ENDED);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useProviderProfileLoginFlow - an await that ends without a verdict", () => {
  it.each(REASONS)(
    "create mode logs the %s reason and still ends on the did-not-finish failure",
    async (reason) => {
      const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
      renderFlow({
        mode: "create",
        existingProfileId: null,
        awaitLoginImpl: () => controlFlowRejection(reason),
      });

      await waitFor(() => expect(flowState()).toBe("failed"));
      expect(screen.getByTestId("flow-message").textContent).toBe(NOT_FINISHED);
      expect(warn).toHaveBeenCalledWith(AWAIT_ENDED, {
        provider: PROVIDER_ID,
        mode: "create",
        reason,
      });
      expect(awaitEndedCalls(warn)).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(FLOW_FAILED, {
        provider: PROVIDER_ID,
        mode: "create",
        blocker: "authentication",
        message: NOT_FINISHED,
      });
    },
  );

  it("create mode logs `rpc-error` for a rejection that is not coordinator control flow", async () => {
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    renderFlow({
      mode: "create",
      existingProfileId: null,
      awaitLoginImpl: () => transportRejection(),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(screen.getByTestId("flow-message").textContent).toBe(NOT_FINISHED);
    expect(warn).toHaveBeenCalledWith(AWAIT_ENDED, {
      provider: PROVIDER_ID,
      mode: "create",
      reason: "rpc-error",
    });
    expect(awaitEndedCalls(warn)).toHaveLength(1);
  });

  it("create mode logs `rpc-error` for a bare rejection that never went through the boundary", async () => {
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    renderFlow({
      mode: "create",
      existingProfileId: null,
      awaitLoginImpl: () => Promise.reject(new Error("transport down")),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(warn).toHaveBeenCalledWith(AWAIT_ENDED, {
      provider: PROVIDER_ID,
      mode: "create",
      reason: "rpc-error",
    });
  });

  it("a known-profile reauth logs its own mode", async () => {
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    renderFlow({
      mode: "reauth",
      existingProfileId: "p-existing",
      awaitLoginImpl: () => controlFlowRejection("authority-superseded"),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(warn).toHaveBeenCalledWith(AWAIT_ENDED, {
      provider: PROVIDER_ID,
      mode: "reauth",
      reason: "authority-superseded",
    });
    expect(awaitEndedCalls(warn)).toHaveLength(1);
  });

  it("logs exactly the provider, mode and reason fields, with no profile identifier", async () => {
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    renderFlow({
      mode: "reauth",
      existingProfileId: "p-existing",
      awaitLoginImpl: () => controlFlowRejection("waiter-cancelled"),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    const calls = awaitEndedCalls(warn);
    expect(calls).toHaveLength(1);
    const fields = calls[0][1];
    if (typeof fields !== "object" || fields === null) {
      throw new Error("expected a fields object");
    }
    expect(Object.keys(fields).sort()).toEqual(["mode", "provider", "reason"]);
    expect(JSON.stringify(calls)).not.toContain("p-existing");
    expect(JSON.stringify(calls)).not.toContain("p-1");
  });

  it("stays silent when the flow's own cancel abandoned the attempt before the rejection arrived", async () => {
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    const rejectionGate = gate();
    renderFlow({
      mode: "create",
      existingProfileId: null,
      // The rejection the cancel provokes: minted by the real boundary, as
      // the coordinator would, and delivered after the attempt was abandoned.
      awaitLoginImpl: () =>
        rejectionGate.promise.then(() =>
          controlFlowRejection("waiter-cancelled"),
        ),
    });
    await waitFor(() => expect(flowState()).toBe("waiting"));

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(flowState()).toBe("cancelled");

    rejectionGate.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(flowState()).toBe("cancelled");
    expect(awaitEndedCalls(warn)).toHaveLength(0);
  });
});
