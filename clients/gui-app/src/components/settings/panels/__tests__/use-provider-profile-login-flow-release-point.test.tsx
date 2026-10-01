import type { ReactNode } from "react";
import {
  act,
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
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type { AwaitLoginVariables } from "@/hooks/providers/use-providers-await-login-mutation";
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

/**
 * One release point for a login attempt's claim on the host.
 *
 * Whenever an attempt lets go of its claim - the user's Cancel, every
 * `fail()`, and the ambient reauth's quiet return to `start` - the flow does
 * two things for THAT attempt, and only that attempt:
 *
 *  1. releases its holder on the host (`providers.cancelLogin` carrying the
 *     holder id the attempt's `startLogin` was sent with), at most once per
 *     holder; and
 *  2. aborts the attempt's `AbortSignal`, which it also passed to
 *     `providers.awaitLogin`, so the pending long-poll is detached from the
 *     request coordinator's `join` slot instead of staying in flight for a
 *     newer attempt's identical question to attach to.
 *
 * Before this, an attempt that ended without success (`fail()`, or the
 * ambient quiet return) never released its holder, so a Retry minted a new
 * holder and Cancel released only that one; and a Cancel left the pending
 * `awaitLogin` in flight.
 *
 * The harness copies `use-provider-profile-login-flow-cancel-ownership`'s
 * mutation doubles, except that `awaitLogin`'s variables are the contract's
 * `{ request, signal }` rather than the bare wire request.
 */

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

type AwaitLoginImpl = (
  variables: AwaitLoginVariables,
) => Promise<AwaitLoginResponse>;
type CancelLoginImpl = (request: CancelLoginRequest) => void;

const PROVIDER_ID = "codex";
const EXISTING_PROFILE_ID = "p-existing";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejection this test drives deliberately must not also surface as an
  // unhandled rejection before the flow's own handler consumes it.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function startLoginAnswer(
  overrides: Partial<StartLoginResponse>,
): StartLoginResponse {
  return {
    url: null,
    started: false,
    profileId: null,
    userCode: null,
    failure: null,
    pending: null,
    pack: null,
    ...overrides,
  };
}

/** A login the host started: the flow moves to `waiting` and awaits it. */
function startedAnswer(profileId: string | null): StartLoginResponse {
  return startLoginAnswer({
    started: true,
    profileId,
    url: "https://example.test",
  });
}

/** `awaitLogin` resolving with nothing authenticated: the sign-in did not
 *  complete, which is a failure for a named profile and a quiet return to
 *  `start` for the ambient reauth. */
const NOT_AUTHENTICATED_ANSWER: AwaitLoginResponse = {
  state: null,
  existingProfileId: null,
  codeRejected: false,
  refusal: null,
};

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

/** `useProviderProfileLoginFlow`'s public input type, named directly rather
 *  than re-declared. */
type FlowInput = Parameters<typeof useProviderProfileLoginFlow>[0];

function LoginFlowHarness(props: {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly existingProfileId: string | null;
  readonly startLoginImpl: (
    request: StartLoginRequest,
  ) => Promise<StartLoginResponse>;
  readonly cancelLoginImpl: (
    request: CancelLoginRequest,
  ) => void | Promise<CancelLoginResponse>;
  readonly awaitLoginImpl: AwaitLoginImpl;
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
    AwaitLoginVariables,
    { readonly hostId: string | null }
  >({
    mutationFn: (variables) => props.awaitLoginImpl(variables),
    onMutate: () => ({ hostId: null }),
  });
  const cancelLogin: CancelLoginMutation = useMutation<
    CancelLoginResponse,
    HostRpcError,
    CancelLoginRequest,
    { readonly hostId: string | null }
  >({
    mutationFn: (request) => {
      const result = props.cancelLoginImpl(request);
      return result === undefined
        ? Promise.resolve({ cancelled: true })
        : result;
    },
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

  const input: FlowInput = {
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
    failureMessages: {
      notStarted: "Sign-in did not start.",
      notFinished: "Sign-in did not finish.",
    },
    onFailed: () => undefined,
    supportsLoginOwnership: true,
  };
  const flow = useProviderProfileLoginFlow(input);

  return (
    <div>
      <div data-testid="flow-state">{flow.state.kind}</div>
      <div data-testid="flow-busy">{String(flow.busy)}</div>
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

function startLoginRecorder(): {
  readonly impl: (request: StartLoginRequest) => Promise<StartLoginResponse>;
  readonly calls: Deferred<StartLoginResponse>[];
  readonly requests: StartLoginRequest[];
} {
  const calls: Deferred<StartLoginResponse>[] = [];
  const requests: StartLoginRequest[] = [];
  return {
    calls,
    requests,
    impl: (request) => {
      requests.push(request);
      const call = deferred<StartLoginResponse>();
      calls.push(call);
      return call.promise;
    },
  };
}

/** The holder ids the flow sent on `providers.startLogin`, in press order. */
function holderIdsSent(requests: readonly StartLoginRequest[]): string[] {
  const holderIds: string[] = [];
  for (const request of requests) {
    if (typeof request.holderId === "string") holderIds.push(request.holderId);
  }
  return holderIds;
}

/** The holder ids carried by every `providers.cancelLogin` the flow sent. */
function holderIdsReleased(
  cancelLoginImpl: Mock<CancelLoginImpl>,
): Array<string | null | undefined> {
  return cancelLoginImpl.mock.calls.map(([request]) => request.holderId);
}

/**
 * Lets TanStack's own scheduling (its notify batches run on a macrotask) and
 * the mutation promise chains run to rest. Used where the test asserts "this
 * happened exactly N times" or "this did not happen", which `waitFor` alone
 * cannot say: it returns on the first moment the assertion holds.
 */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function pressStart(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await Promise.resolve();
  });
}

async function pressCancel(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    await Promise.resolve();
  });
}

async function answerStart(
  call: Deferred<StartLoginResponse>,
  answer: StartLoginResponse,
): Promise<void> {
  await act(async () => {
    call.resolve(answer);
    await Promise.resolve();
  });
}

function flowState(): string | null {
  return screen.getByTestId("flow-state").textContent;
}

/** The signal the flow handed to its `index`-th `awaitLogin` dispatch. */
function awaitSignalOf(
  awaitLoginImpl: Mock<AwaitLoginImpl>,
  index: number,
): AbortSignal | undefined {
  return awaitLoginImpl.mock.calls[index]?.[0].signal;
}

afterEach(() => {
  cleanup();
});

describe("useProviderProfileLoginFlow - a failed attempt releases its own holder", () => {
  it("sends exactly one cancelLogin, carrying the startLogin holder, when a profile reauth's await fails", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<CancelLoginImpl>();
    const awaitCall = deferred<AwaitLoginResponse>();
    const awaitLoginImpl = vi.fn<AwaitLoginImpl>(() => awaitCall.promise);
    render(
      <LoginFlowHarness
        mode="reauth"
        existingProfileId={EXISTING_PROFILE_ID}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
        awaitLoginImpl={awaitLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await pressStart();
    await answerStart(recorder.calls[0], startedAnswer(EXISTING_PROFILE_ID));
    expect(flowState()).toBe("waiting");
    expect(awaitLoginImpl).toHaveBeenCalledTimes(1);
    // Nothing has ended the attempt yet, so nothing has released its holder.
    expect(cancelLoginImpl).not.toHaveBeenCalled();

    await act(async () => {
      awaitCall.reject(new Error("await failed"));
      await Promise.resolve();
    });
    await waitFor(() => expect(flowState()).toBe("failed"));
    await settle();

    const [holderId] = holderIdsSent(recorder.requests);
    expect(typeof holderId).toBe("string");
    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: PROVIDER_ID, holderId }),
    );
  });

  it("releases every holder the flow minted across a failure, a Retry and a Cancel", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<CancelLoginImpl>();
    const firstAwait = deferred<AwaitLoginResponse>();
    // The first attempt's await fails; the Retry's await stays pending until
    // the user cancels it.
    const awaitLoginImpl = vi
      .fn<AwaitLoginImpl>()
      .mockImplementationOnce(() => firstAwait.promise)
      .mockImplementation(
        () => new Promise<AwaitLoginResponse>(() => undefined),
      );
    render(
      <LoginFlowHarness
        mode="reauth"
        existingProfileId={EXISTING_PROFILE_ID}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
        awaitLoginImpl={awaitLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await pressStart();
    await answerStart(recorder.calls[0], startedAnswer(EXISTING_PROFILE_ID));
    await act(async () => {
      firstAwait.reject(new Error("await failed"));
      await Promise.resolve();
    });
    await waitFor(() => expect(flowState()).toBe("failed"));
    // `start()` refuses a press while `awaitLogin.isPending`, and that flag
    // clears on TanStack Query's own schedule, so wait for the flow to report
    // itself idle rather than for a fixed number of ticks.
    await waitFor(() => {
      expect(screen.getByTestId("flow-busy").textContent).toBe("false");
    });

    // Retry: a new attempt under a new holder.
    await pressStart();
    await answerStart(recorder.calls[1], startedAnswer(EXISTING_PROFILE_ID));
    await waitFor(() => expect(flowState()).toBe("waiting"));
    expect(awaitLoginImpl).toHaveBeenCalledTimes(2);

    await pressCancel();
    await settle();

    const holderIds = holderIdsSent(recorder.requests);
    // Guard against a vacuous pass: two attempts, two distinct holders.
    expect(holderIds).toHaveLength(2);
    expect(new Set(holderIds).size).toBe(2);
    // Before the fix only the Retry's holder was released: the failed
    // attempt's claim stayed on the host with no UI left to release it.
    expect(holderIdsReleased(cancelLoginImpl)).toEqual(
      expect.arrayContaining(holderIds),
    );
    // At most once per holder.
    expect(cancelLoginImpl).toHaveBeenCalledTimes(2);
    // One controller per attempt, never shared across a Retry.
    const firstSignal = awaitSignalOf(awaitLoginImpl, 0);
    const secondSignal = awaitSignalOf(awaitLoginImpl, 1);
    expect(firstSignal).toBeDefined();
    expect(secondSignal).toBeDefined();
    expect(secondSignal).not.toBe(firstSignal);
  });

  it("releases the holder when an ambient reauth's await settles unauthenticated and the flow returns quietly to start", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<CancelLoginImpl>();
    const awaitCall = deferred<AwaitLoginResponse>();
    const awaitLoginImpl = vi.fn<AwaitLoginImpl>(() => awaitCall.promise);
    render(
      <LoginFlowHarness
        mode="reauth"
        existingProfileId={null}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
        awaitLoginImpl={awaitLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await pressStart();
    await answerStart(recorder.calls[0], startedAnswer(null));
    expect(flowState()).toBe("waiting");
    expect(cancelLoginImpl).not.toHaveBeenCalled();

    await act(async () => {
      awaitCall.resolve(NOT_AUTHENTICATED_ANSWER);
      await Promise.resolve();
    });
    // The ambient reauth has no failed state: an unauthenticated settle sends
    // it straight back to `start`, which is exactly the path that used to
    // release nothing.
    await waitFor(() => expect(flowState()).toBe("start"));
    await settle();

    const [holderId] = holderIdsSent(recorder.requests);
    expect(typeof holderId).toBe("string");
    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: PROVIDER_ID, holderId }),
    );
  });
});

describe("useProviderProfileLoginFlow - the release also detaches the attempt's pending await", () => {
  it("aborts the signal it passed to awaitLogin when the user cancels while the await is pending", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<CancelLoginImpl>();
    // Never settles: the long-poll is still in flight when Cancel is pressed.
    const awaitLoginImpl = vi.fn<AwaitLoginImpl>(
      () => new Promise<AwaitLoginResponse>(() => undefined),
    );
    render(
      <LoginFlowHarness
        mode="reauth"
        existingProfileId={EXISTING_PROFILE_ID}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
        awaitLoginImpl={awaitLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await pressStart();
    await answerStart(recorder.calls[0], startedAnswer(EXISTING_PROFILE_ID));
    expect(flowState()).toBe("waiting");
    expect(awaitLoginImpl).toHaveBeenCalledTimes(1);

    // The signal belongs to the live attempt: present, and not yet aborted.
    const signal = awaitSignalOf(awaitLoginImpl, 0);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    await pressCancel();
    await settle();

    expect(flowState()).toBe("cancelled");
    expect(signal?.aborted).toBe(true);
  });

  it("aborts the signal it passed to awaitLogin when the attempt ends in failure", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<CancelLoginImpl>();
    const awaitCall = deferred<AwaitLoginResponse>();
    const awaitLoginImpl = vi.fn<AwaitLoginImpl>(() => awaitCall.promise);
    render(
      <LoginFlowHarness
        mode="reauth"
        existingProfileId={EXISTING_PROFILE_ID}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
        awaitLoginImpl={awaitLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await pressStart();
    await answerStart(recorder.calls[0], startedAnswer(EXISTING_PROFILE_ID));
    expect(awaitLoginImpl).toHaveBeenCalledTimes(1);
    const signal = awaitSignalOf(awaitLoginImpl, 0);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      awaitCall.reject(new Error("await failed"));
      await Promise.resolve();
    });
    await waitFor(() => expect(flowState()).toBe("failed"));
    await settle();

    // The attempt let go of its claim, so its await no longer has an owner.
    expect(signal?.aborted).toBe(true);
  });
});
