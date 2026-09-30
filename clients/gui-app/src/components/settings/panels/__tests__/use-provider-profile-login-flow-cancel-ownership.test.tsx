import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
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

/**
 * Coverage for the GUI half of
 * epics/368a3163-5475-4713-ad06-634f47cc913a/artifacts/v1-4-1-cherry-pick-list/login-cancel-ownership.
 *
 * `useProviderProfileLoginFlow` takes `supportsLoginOwnership` and mints a
 * per-attempt holder id sent on every start and cancel call, so the host can
 * tell this attempt's claim apart from another surface's.
 *
 * Per the spec: against a host that negotiates both new minors, Cancel
 * releases the attempt's claim AT ONCE in every state, because the host now
 * owns the ordering — it no longer has to wait for `startLogin`'s answer to
 * learn what to cancel. That is the download-gap case below.
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

const PROVIDER_ID = "codex";

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
  // unhandled rejection before the flow's own `.then` consumes it.
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

const PACK_PREPARING_ANSWER: StartLoginResponse = startLoginAnswer({
  pending: "pack_preparing",
  pack: { percent: 10, reason: null, retryAtMs: null },
});

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
 *  than re-declared: it already includes `supportsLoginOwnership`. */
type FlowInput = Parameters<typeof useProviderProfileLoginFlow>[0];

function LoginFlowHarness(props: {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly existingProfileId: string | null;
  readonly loginCapability: ProviderCliState["loginCapability"];
  readonly supportsLoginOwnership: boolean;
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
    AwaitLoginRequest,
    { readonly hostId: string | null }
  >({
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

  const input: FlowInput = {
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
    supportsLoginOwnership: props.supportsLoginOwnership,
  };
  const flow = useProviderProfileLoginFlow(input);

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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useProviderProfileLoginFlow — holder id minted for an ownership-capable host", () => {
  it("sends the same non-null holder id on start and on the cancel it triggers", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        supportsLoginOwnership
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
      recorder.calls[0].resolve(
        startLoginAnswer({ pending: "starting", profileId: "p-new" }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));
      await Promise.resolve();
    });

    // The host disambiguates this attempt's claim from another surface's by
    // this holder id, sent on both the start request and the cancel call.
    const sentHolderId = (recorder.requests[0] as { holderId?: unknown })
      .holderId;
    expect(typeof sentHolderId).toBe("string");
    expect(cancelLoginImpl).toHaveBeenCalledWith(
      expect.objectContaining({ holderId: sentHolderId }),
    );
  });
});

describe("useProviderProfileLoginFlow — download-gap cancellation against an ownership-capable host", () => {
  it("releases the claim at once instead of waiting for the in-flight call's answer", async () => {
    vi.useFakeTimers();
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        supportsLoginOwnership
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
    expect(screen.getByTestId("flow-state").textContent).toBe("starting");

    // Cancel while the second poll call is still in flight and nothing has
    // spawned on the host yet. The released policy (still in effect without
    // ownership — see the companion test below) waits for that call's answer
    // before sending anything to the host. With ownership, the host itself
    // owns the ordering, so the cancel must go out NOW, marking this
    // attempt's holder cancelled before its start is even known.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));
      await Promise.resolve();
    });

    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
  });
});

describe("useProviderProfileLoginFlow — released policy stays exactly as shipped without ownership", () => {
  it("still waits for the in-flight call's answer during the download gap when the host does not negotiate the new minors", async () => {
    vi.useFakeTimers();
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        supportsLoginOwnership={false}
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

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.getByTestId("flow-state").textContent).toBe("cancelled");
    // This is the RELEASED behavior and must stay green: no host call yet.
    expect(cancelLoginImpl).not.toHaveBeenCalled();

    await act(async () => {
      recorder.calls[1].resolve(
        startLoginAnswer({ pending: "starting", profileId: "p-new" }),
      );
      await Promise.resolve();
    });
    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
  });
});

describe("useProviderProfileLoginFlow — pre-first-start cancel under ownership", () => {
  it("reports cancellation locally and never calls the host, even for a named-profile reauth", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="reauth"
        existingProfileId="p-existing"
        loginCapability={null}
        supportsLoginOwnership
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    // The panel can close before its own first `start()` ever runs - it owns
    // no login yet, even though `existingProfileId` is already known.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));
      await Promise.resolve();
    });

    expect(screen.getByTestId("flow-state").textContent).toBe("cancelled");
    expect(cancelLoginImpl).not.toHaveBeenCalled();
    expect(recorder.calls).toHaveLength(0);
  });
});

describe("useProviderProfileLoginFlow — failed-start cancel under ownership", () => {
  it("does not send a second, wrong cancel when the call already on its way then fails", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        supportsLoginOwnership
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });

    // Ownership releases the claim at the press, in every state but `start`
    // - the call is still in flight, with no `liveLoginRef` known yet.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));
      await Promise.resolve();
    });
    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);

    // The in-flight call now rejects. A failed start names no login to
    // cancel - this must not turn into a second, wrong (ambient-scope) cancel
    // on top of the one ownership already sent at the press. (This edge is
    // ALSO guarded by `cancelledRef`'s own idempotency once a cancel has
    // already dispatched - see the legacy-path test below for the case that
    // actually discriminates the fixed line from the pre-fix one: an ambient
    // attempt that never dispatched a cancel at all before its call failed.)
    await act(async () => {
      recorder.calls[0].reject(new Error("network"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
  });

  it("never sends an ambient-scope cancel for a legacy ambient REAUTH attempt that was marked cancel-requested (no live login yet) and then failed", async () => {
    // Without ownership, cancelling an ambient reauth attempt (the in-chat
    // banner's OAuth reconnect: `mode: "reauth"`, `existingProfileId: null`)
    // while starting with no known live login does NOT dispatch a cancel at
    // the press (see the "legacy named-immediate vs ambient-wait" suite) -
    // it only flips `cancelRequested`. So `cancelledRef` is still false when
    // the call fails, and this is the path where the fixed line
    // (`reportCancellation()` instead of `finishCancellation(null)`) is the
    // only thing standing between this and a wrong ambient-scope
    // `providers.cancelLogin` call - `cancelProfile`'s own
    // `mode !== "reauth" && profileId === null` guard only protects CREATE
    // mode, precisely because ambient reauth's `null` IS a real, cancellable
    // scope shared with every other surface reauth-ing the same account.
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="reauth"
        existingProfileId={null}
        loginCapability={null}
        supportsLoginOwnership={false}
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
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));
      await Promise.resolve();
    });
    // No dispatch yet - this is the "waits for the answer" released policy.
    expect(cancelLoginImpl).not.toHaveBeenCalled();

    await act(async () => {
      recorder.calls[0].reject(new Error("network"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(cancelLoginImpl).not.toHaveBeenCalled();
    expect(screen.getByTestId("flow-state").textContent).toBe("cancelled");
  });
});

describe("useProviderProfileLoginFlow — legacy named-immediate vs ambient-wait while starting", () => {
  it("cancels a named-profile reauth at once while its call is still in flight, without ownership", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="reauth"
        existingProfileId="p-existing"
        loginCapability={null}
        supportsLoginOwnership={false}
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
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));
      await Promise.resolve();
    });

    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "p-existing" }),
    );
  });

  it("waits for the in-flight call's answer for an ambient/create attempt with no known live login yet, without ownership", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        supportsLoginOwnership={false}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    // No `pending: "starting"` answer yet - `liveLoginRef` is still null and
    // there is no download in progress either, so a cancel now must NOT call
    // the host: it only marks the in-flight call `cancelRequested`, to be
    // honored once that call's own answer lands.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));
      await Promise.resolve();
    });
    expect(cancelLoginImpl).not.toHaveBeenCalled();

    await act(async () => {
      recorder.calls[0].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-new",
          url: "https://example.test",
        }),
      );
      await Promise.resolve();
    });
    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "p-new" }),
    );
  });
});

describe("useProviderProfileLoginFlow — reopened panel: two same-scope instances never cross-cancel", () => {
  it("mints distinct holder ids per instance, and A's cancel never touches B", async () => {
    const recorderA = startLoginRecorder();
    const recorderB = startLoginRecorder();
    const cancelLoginImplA = vi.fn<(request: CancelLoginRequest) => void>();
    const cancelLoginImplB = vi.fn<(request: CancelLoginRequest) => void>();

    // Panel A: the original reauth panel, still open.
    const viewA = render(
      <LoginFlowHarness
        mode="reauth"
        existingProfileId={null}
        loginCapability={null}
        supportsLoginOwnership
        startLoginImpl={recorderA.impl}
        cancelLoginImpl={cancelLoginImplA}
      />,
      { wrapper: queryClientWrapper() },
    );
    await act(async () => {
      fireEvent.click(
        within(viewA.container).getByRole("button", { name: "start" }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      recorderA.calls[0].resolve(
        startLoginAnswer({ pending: "starting", profileId: null }),
      );
      await Promise.resolve();
    });

    // Panel B: the SAME provider/scope, reopened as a second surface (a
    // second Settings window, or the same panel closed and reopened) - a
    // fresh flow instance with its own holder id, attaching to the same
    // host-side child.
    const viewB = render(
      <LoginFlowHarness
        mode="reauth"
        existingProfileId={null}
        loginCapability={null}
        supportsLoginOwnership
        startLoginImpl={recorderB.impl}
        cancelLoginImpl={cancelLoginImplB}
      />,
      { wrapper: queryClientWrapper() },
    );
    await act(async () => {
      fireEvent.click(
        within(viewB.container).getByRole("button", { name: "start" }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      recorderB.calls[0].resolve(
        startLoginAnswer({ pending: "starting", profileId: null }),
      );
      await Promise.resolve();
    });

    const holderIdA = (recorderA.requests[0] as { holderId?: unknown })
      .holderId;
    const holderIdB = (recorderB.requests[0] as { holderId?: unknown })
      .holderId;
    expect(typeof holderIdA).toBe("string");
    expect(typeof holderIdB).toBe("string");
    expect(holderIdA).not.toBe(holderIdB);

    // A cancels. Only A's own mutation fires, carrying A's own holder id -
    // B's cancel mutation is never invoked, and B's flow state is untouched.
    await act(async () => {
      fireEvent.click(
        within(viewA.container).getByRole("button", { name: "cancel" }),
      );
      await Promise.resolve();
    });

    expect(cancelLoginImplA).toHaveBeenCalledTimes(1);
    expect(cancelLoginImplA).toHaveBeenCalledWith(
      expect.objectContaining({ holderId: holderIdA }),
    );
    expect(cancelLoginImplB).not.toHaveBeenCalled();
    expect(within(viewA.container).getByTestId("flow-state").textContent).toBe(
      "cancelled",
    );
    expect(within(viewB.container).getByTestId("flow-state").textContent).toBe(
      "starting",
    );

    viewA.unmount();
    viewB.unmount();
  });
});

describe("useProviderProfileLoginFlow — a failed cancel RPC must not latch out the retry", () => {
  it("with ownership: sends a SECOND cancel, for the same holder and the now-known profile, once the in-flight start answer lands holding a login", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi
      .fn<(request: CancelLoginRequest) => void>()
      .mockImplementationOnce(() => {
        throw new Error("cancel rpc failed");
      });
    render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        supportsLoginOwnership
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });

    // Ownership cancels at once - the call is still in flight, so this is
    // the FIRST cancel, and it fails.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));
      await Promise.resolve();
    });
    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("flow-state").textContent).toBe("cancelled");

    const holderId = (
      cancelLoginImpl.mock.calls[0]?.[0] as { holderId?: unknown }
    ).holderId;
    expect(typeof holderId).toBe("string");

    // The in-flight call now answers - a login the host actually started,
    // for a profile it minted. `cancelRequestedRef` is still set from the
    // press, so this is meant to release it too - but the first cancel's
    // FAILURE must not have latched the flow out of trying again.
    await act(async () => {
      recorder.calls[0].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-new",
          url: "https://example.test",
        }),
      );
      await Promise.resolve();
    });

    // Before the fix `cancelledRef` stayed latched by the first (failed)
    // cancel, so `cancelProfile` returned early here and this second call
    // never happened - the holder stayed attached to the shared child on the
    // host with no UI left to retry from. The failed release reopens the
    // latch, so the answer's release goes out.
    expect(cancelLoginImpl).toHaveBeenCalledTimes(2);
    expect(cancelLoginImpl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ holderId, profileId: "p-new" }),
    );
  });

  it("legacy (no ownership): sends a second, null-holder cancel for the named profile once the failed first cancel's start answer lands", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi
      .fn<(request: CancelLoginRequest) => void>()
      .mockImplementationOnce(() => {
        throw new Error("cancel rpc failed");
      });
    render(
      <LoginFlowHarness
        mode="reauth"
        existingProfileId="p-1"
        loginCapability={null}
        supportsLoginOwnership={false}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    // A named-profile reauth cancels at once while starting, released
    // policy or not - and this first attempt fails.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));
      await Promise.resolve();
    });
    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ holderId: null, profileId: "p-1" }),
    );

    await act(async () => {
      recorder.calls[0].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-1",
          url: "https://example.test",
        }),
      );
      await Promise.resolve();
    });

    // Same latch, same reopening, on the legacy null-holder path.
    expect(cancelLoginImpl).toHaveBeenCalledTimes(2);
    expect(cancelLoginImpl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ holderId: null, profileId: "p-1" }),
    );
  });

  it("existing behavior lock: a SUCCESSFUL first cancel still suppresses the second (no double-cancel on a healthy RPC)", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        supportsLoginOwnership
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
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));
      await Promise.resolve();
    });
    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);

    await act(async () => {
      recorder.calls[0].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-new",
          url: "https://example.test",
        }),
      );
      await Promise.resolve();
    });

    // This is today's `cancelledRef` guarantee and must stay true after the
    // fix: a healthy cancel is not repeated.
    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
  });
});
