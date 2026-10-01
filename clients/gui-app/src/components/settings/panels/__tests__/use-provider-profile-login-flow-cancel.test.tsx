import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { AwaitLoginVariables } from "@/hooks/providers/use-providers-await-login-mutation";
import { PROVIDER_LOGIN_PACK_POLL_MS } from "@/components/providers/provider-login-start";
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

// This suite is the fix's central claim: whoever stops asking (a Cancel
// press, or the flow's own hook unmounting) releases a login child the host
// is still holding open, and a newer attempt's own answer is never mistaken
// for a stale one's. It drives the REAL hook against real `useMutation`
// instances (per `host-overview-notices.test.tsx`'s fixture pattern) rather
// than a hand-cast `UseMutationResult` - the type is a large TanStack shape
// this file has no business re-typing - with `mutationFn`s this file fully
// controls, so every race below is driven by the test, not by chance timing.

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

const PROVIDER_ID = "codex";

/** A still-pending answer this test resolves on its own schedule, instead of
 *  the flow racing ahead of the assertions that inspect it mid-flight. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

const PACK_PREPARING_ANSWER: StartLoginResponse = startLoginAnswer({
  pending: "pack_preparing",
  pack: { percent: 10, reason: null, retryAtMs: null },
});

function loginCapability(
  selfOpensBrowser: Record<string, never> | null,
): NonNullable<ProviderCliState["loginCapability"]> {
  return {
    oauthArgs: ["login"],
    token: null,
    codePaste: null,
    terminalLogin: null,
    remoteSafe: null,
    selfOpensBrowser,
  };
}
/** Nobody but the GUI would have opened this login's page. */
const GUI_OPENS_BROWSER = loginCapability(null);
/** The provider's own child opens its browser - its page may already be open
 *  and the user can still finish there, so an unmounted-and-started login for
 *  this capability is left alone. */
const SELF_OPENS_BROWSER = loginCapability({});

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

/**
 * Exercises `useProviderProfileLoginFlow` directly. `startLoginImpl` is the
 * one seam every test in this file drives (each call captured, resolved on
 * its own schedule via a queue the harness never reads from); every other
 * mutation is a real `useMutation` too, wired to a fake this suite either
 * never expects to fire (`awaitLogin` never resolves - none of these cases
 * reach past `waiting`) or records for its own assertion (`cancelLogin`).
 */
function LoginFlowHarness(props: {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly existingProfileId: string | null;
  readonly loginCapability: ProviderCliState["loginCapability"];
  readonly startLoginImpl: (
    request: StartLoginRequest,
  ) => Promise<StartLoginResponse>;
  readonly cancelLoginImpl: (request: CancelLoginRequest) => void;
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
    // Never resolves: no case in this file drives the flow past `waiting`,
    // so nothing here is ever meant to settle.
    mutationFn: () => new Promise<AwaitLoginResponse>(() => undefined),
    onMutate: () => ({ hostId: null }),
  });
  const cancelLogin: CancelLoginMutation = useMutation<
    CancelLoginResponse,
    HostRpcError,
    CancelLoginRequest,
    { readonly hostId: string | null }
  >({
    mutationFn: (request) => {
      props.cancelLoginImpl(request);
      return Promise.resolve({ cancelled: true });
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

  const flow = useProviderProfileLoginFlow({
    supportsLoginOwnership: false,
    mode: props.mode,
    providerId: PROVIDER_ID,
    existingProfileId: props.existingProfileId,
    loginCapability: props.loginCapability,
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
  });

  return (
    <div>
      <div data-testid="flow-state">{flow.state.kind}</div>
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

/** Records every `startLoginImpl` call as its own deferred answer, so a test
 *  resolves calls in whatever order it is exercising rather than the order
 *  they were dispatched in. */
function startLoginRecorder(): {
  readonly impl: (request: StartLoginRequest) => Promise<StartLoginResponse>;
  readonly calls: Deferred<StartLoginResponse>[];
} {
  const calls: Deferred<StartLoginResponse>[] = [];
  return {
    calls,
    impl: () => {
      const call = deferred<StartLoginResponse>();
      calls.push(call);
      return call.promise;
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useProviderProfileLoginFlow - releasing a login the host is still holding (create mode)", () => {
  it("cancelling while the pack is still downloading releases the login the in-flight call started, while still mounted", async () => {
    vi.useFakeTimers();
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    expect(recorder.calls).toHaveLength(1);

    // First answer: the pack is downloading. The flow asks again after its
    // 2-second poll gap.
    await act(async () => {
      recorder.calls[0].resolve(PACK_PREPARING_ANSWER);
      await vi.advanceTimersByTimeAsync(PROVIDER_LOGIN_PACK_POLL_MS);
    });
    expect(recorder.calls).toHaveLength(2);
    expect(screen.getByTestId("flow-state").textContent).toBe("starting");

    // Cancel while that second call is still in flight - the UI is showing
    // the download state, so the press ends the flow at once even though
    // nothing has answered yet.
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.getByTestId("flow-state").textContent).toBe("cancelled");
    expect(cancelLoginImpl).not.toHaveBeenCalled();

    // The call already on its way answers with a login the host actually
    // started, and a profile it minted - only this press releases it.
    await act(async () => {
      recorder.calls[1].resolve(
        startLoginAnswer({ pending: "starting", profileId: "p-new" }),
      );
      await Promise.resolve();
    });

    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      profileId: "p-new",
      holderId: null,
    });
  });

  it("cancelling while the pack is still downloading releases the login even after the dialog unmounts first", async () => {
    vi.useFakeTimers();
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    const view = render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    await act(async () => {
      recorder.calls[0].resolve(PACK_PREPARING_ANSWER);
      await vi.advanceTimersByTimeAsync(PROVIDER_LOGIN_PACK_POLL_MS);
    });
    expect(recorder.calls).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    view.unmount();

    // A started answer, this time - the release still has to run for it, not
    // only for a still-starting one.
    await act(async () => {
      recorder.calls[1].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-new",
          url: "https://example.test/oauth",
        }),
      );
      await Promise.resolve();
    });

    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      profileId: "p-new",
      holderId: null,
    });
  });

  it("releases a login that was still starting when the hook unmounted with no Cancel press", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    const view = render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    expect(recorder.calls).toHaveLength(1);

    view.unmount();

    await act(async () => {
      recorder.calls[0].resolve(
        startLoginAnswer({ pending: "starting", profileId: "p-new" }),
      );
      await Promise.resolve();
    });

    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      profileId: "p-new",
      holderId: null,
    });
  });

  it("releases a login that had already started by the time the hook unmounted, when only the GUI would have opened its page", async () => {
    // A started answer this time, not a still-starting one - but with no
    // capability (or `selfOpensBrowser: null`), this provider never opens its
    // own browser, so a login nobody asks for again is a login nobody ever
    // opens.
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    const view = render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={GUI_OPENS_BROWSER}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    view.unmount();

    await act(async () => {
      recorder.calls[0].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-new",
          url: "https://example.test/oauth",
        }),
      );
      await Promise.resolve();
    });

    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      profileId: "p-new",
      holderId: null,
    });
  });

  it("leaves a login alone when it had already started by the time the hook unmounted, when the provider opens its own browser", async () => {
    // The complement of the case above: proves the positive path would have
    // been observable (same setup, same unmount, same answer) had the
    // capability actually been one only the GUI opens - so this negative is
    // not vacuous.
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    const view = render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={SELF_OPENS_BROWSER}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    view.unmount();

    await act(async () => {
      recorder.calls[0].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-new",
          url: "https://example.test/oauth",
        }),
      );
      await Promise.resolve();
    });

    expect(cancelLoginImpl).not.toHaveBeenCalled();
  });

  it("never releases a superseded attempt's own stale answer, and still proceeds on the attempt that replaced it", async () => {
    vi.useFakeTimers();
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    // Attempt 1: presses start, gets a downloading answer, and asks again -
    // that second call is the one that will go stale.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    await act(async () => {
      recorder.calls[0].resolve(PACK_PREPARING_ANSWER);
      await vi.advanceTimersByTimeAsync(PROVIDER_LOGIN_PACK_POLL_MS);
    });
    expect(recorder.calls).toHaveLength(2);

    // Cancelling while that second call is in flight ends attempt 1 at once
    // (matching the first test above) and returns the flow to a state a
    // fresh press is allowed from.
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.getByTestId("flow-state").textContent).toBe("cancelled");

    // Attempt 2 begins before attempt 1's own stale call has answered.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    expect(recorder.calls).toHaveLength(3);
    expect(screen.getByTestId("flow-state").textContent).toBe("starting");

    // Attempt 1's stale call finally answers - a login it genuinely started,
    // for a profile it minted. It must not be attempt 2's to release.
    await act(async () => {
      recorder.calls[1].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-stale",
          url: "https://example.test/oauth-stale",
        }),
      );
      await Promise.resolve();
    });
    expect(cancelLoginImpl).not.toHaveBeenCalled();

    // Attempt 2's own call still settles normally - the guard against the
    // stale answer did not also break the attempt that replaced it.
    await act(async () => {
      recorder.calls[2].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-fresh",
          url: "https://example.test/oauth-fresh",
        }),
      );
      await Promise.resolve();
    });
    expect(screen.getByTestId("flow-state").textContent).toBe("waiting");
    expect(cancelLoginImpl).not.toHaveBeenCalled();
  });
});

/**
 * Reauth of the ambient login (`existingProfileId` null): the in-chat banner's
 * OAuth reconnect. `providers.cancelLogin` for it is keyed by the provider
 * alone, so a cancel sent for a login this press never started can end one
 * another surface started for the same account.
 */
describe("useProviderProfileLoginFlow - cancelling an ambient reauth while the pack downloads", () => {
  async function cancelDuringDownload(
    inFlightAnswer: StartLoginResponse,
  ): Promise<Mock<(request: CancelLoginRequest) => void>> {
    vi.useFakeTimers();
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="reauth"
        existingProfileId={null}
        loginCapability={GUI_OPENS_BROWSER}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    await act(async () => {
      recorder.calls[0].resolve(PACK_PREPARING_ANSWER);
      await vi.advanceTimersByTimeAsync(PROVIDER_LOGIN_PACK_POLL_MS);
    });
    expect(recorder.calls).toHaveLength(2);

    // Nothing runs on the host while the pack downloads, so the press ends
    // the flow without a host call.
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.getByTestId("flow-state").textContent).toBe("cancelled");
    expect(cancelLoginImpl).not.toHaveBeenCalled();

    await act(async () => {
      recorder.calls[1].resolve(inFlightAnswer);
      await Promise.resolve();
    });
    expect(screen.getByTestId("flow-state").textContent).toBe("cancelled");
    return cancelLoginImpl;
  }

  it("sends no cancel when the call already on its way answers that the pack is still preparing", async () => {
    const cancelLoginImpl = await cancelDuringDownload(PACK_PREPARING_ANSWER);
    expect(cancelLoginImpl).not.toHaveBeenCalled();
  });

  it("sends no cancel when the call already on its way answers that the host did not start a login", async () => {
    const cancelLoginImpl = await cancelDuringDownload(startLoginAnswer({}));
    expect(cancelLoginImpl).not.toHaveBeenCalled();
  });

  it("releases a login the call already on its way left still starting", async () => {
    const cancelLoginImpl = await cancelDuringDownload(
      startLoginAnswer({ pending: "starting" }),
    );
    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      profileId: null,
      holderId: null,
    });
  });

  it("releases a login the call already on its way started", async () => {
    const cancelLoginImpl = await cancelDuringDownload(
      startLoginAnswer({ started: true, url: "https://example.test/oauth" }),
    );
    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      profileId: null,
      holderId: null,
    });
  });
});
