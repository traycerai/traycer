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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderId,
  ProviderMutationCliStateV21,
} from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { AwaitLoginVariables } from "@/hooks/providers/use-providers-await-login-mutation";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
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
import {
  PROJECTED_KIMI_AWAIT_LOGIN,
  RAW_KIMI_AWAIT_LOGIN,
} from "./__fixtures__/kimi-projected-auth";

// A provider whose login can only ever read `configured` (Kimi's credential
// file) has its successful sign-in answered by the HOST with top-level
// `state.auth.status: "authenticated"` (traycer-internal #6345,
// `traycerai/traycer#2363`). The classifiers are not exported, so this drives
// the REAL hook against real `useMutation` instances whose `awaitLogin`
// answers with what a host would, exactly as the sibling `-refusal` suite does.
// The GUI adds no lift of its own: it reads the status it is handed.

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
type ProfileRow = ProviderMutationCliStateV21["profiles"][number];

const NOT_FINISHED = "Sign-in did not finish.";
const NOT_STARTED = "Sign-in did not start.";

function startedAnswer(
  overrides: Partial<StartLoginResponse>,
): StartLoginResponse {
  return {
    url: "https://auth.kimi.ai/device",
    started: true,
    profileId: "p-1",
    userCode: null,
    failure: null,
    pending: null,
    pack: null,
    ...overrides,
  };
}

function managedRow(
  profileId: string,
  status: ProfileRow["auth"]["status"],
): ProfileRow {
  return {
    profileId,
    kind: "managed",
    authType: "oauth",
    label: "Work",
    auth: { status, badgeText: null, label: null, detail: null },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

// The projected Kimi completion, re-addressed to a provider that has managed
// profiles: top-level auth stays `authenticated`, and the rows are the test's.
function projectedCompletionWith(
  providerId: "claude-code",
  profiles: readonly ProfileRow[],
): AwaitLoginResponse {
  const state = PROJECTED_KIMI_AWAIT_LOGIN.state;
  if (state === null) throw new Error("the fixture carries a state");
  return {
    ...PROJECTED_KIMI_AWAIT_LOGIN,
    state: { ...state, providerId, profiles: [...profiles] },
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
  readonly providerId: ProviderId;
  readonly mode: ProviderProfileLoginFlowMode;
  readonly existingProfileId: string | null;
  readonly startLoginImpl: (
    request: StartLoginRequest,
  ) => Promise<StartLoginResponse>;
  readonly awaitLoginImpl: (
    variables: AwaitLoginVariables,
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
    providerId: props.providerId,
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
    onFailed: props.onFailed,
  });

  return (
    <div>
      <div data-testid="flow-state">{flow.state.kind}</div>
      <div data-testid="flow-message">
        {flow.state.kind === "failed" ? flow.state.message : ""}
      </div>
      <div data-testid="flow-identity-profile">
        {flow.state.kind === "identity" ? flow.state.profile.profileId : ""}
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
  readonly providerId: ProviderId;
  readonly mode: ProviderProfileLoginFlowMode;
  readonly existingProfileId: string | null;
  readonly startLoginImpl: (
    request: StartLoginRequest,
  ) => Promise<StartLoginResponse>;
  readonly awaitLoginImpl: (
    variables: AwaitLoginVariables,
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

let track: MockInstance<Analytics["track"]>;

beforeEach(() => {
  track = vi.spyOn(Analytics.getInstance(), "track").mockReturnValue(true);
  vi.spyOn(appLogger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function succeededEvents(): readonly unknown[] {
  return track.mock.calls.filter(
    ([event]) => event === AnalyticsEvent.ProviderProfileLinkSucceeded,
  );
}

describe("useProviderProfileLoginFlow - Kimi ambient reconnect over a projected completion", () => {
  it("settles a projected `authenticated` completion as a signed-in reconnect", async () => {
    const awaitLoginImpl = vi.fn((_variables: AwaitLoginVariables) =>
      Promise.resolve(PROJECTED_KIMI_AWAIT_LOGIN),
    );
    const { onFailed } = renderFlow({
      providerId: "kimi",
      mode: "reauth",
      existingProfileId: null,
      startLoginImpl: () => Promise.resolve(startedAnswer({ profileId: null })),
      awaitLoginImpl,
    });

    // The ambient reconnect returns quietly to `start` either way, so the
    // success is read off the attempt's own analytics event.
    await waitFor(() => expect(succeededEvents()).toHaveLength(1));
    expect(track).toHaveBeenCalledWith(
      AnalyticsEvent.ProviderProfileLinkSucceeded,
      { provider: "kimi", mode: "reauth" },
    );
    expect(flowState()).toBe("start");
    expect(onFailed).not.toHaveBeenCalled();
    // One settled completion: the verdict was definitive, so no re-poll.
    expect(awaitLoginImpl).toHaveBeenCalledTimes(1);
    // A signed-in attempt is not released as an ended one.
    const variables = awaitLoginImpl.mock.calls.at(-1)?.[0];
    expect(variables?.signal?.aborted).toBe(false);
  });

  it("does not read the RAW `configured` completion as signed in: the GUI adds no lift of its own", async () => {
    const awaitLoginImpl = vi.fn((_variables: AwaitLoginVariables) =>
      Promise.resolve(RAW_KIMI_AWAIT_LOGIN),
    );
    const { onFailed } = renderFlow({
      providerId: "kimi",
      mode: "reauth",
      existingProfileId: null,
      startLoginImpl: () => Promise.resolve(startedAnswer({ profileId: null })),
      awaitLoginImpl,
    });

    await waitFor(() => expect(awaitLoginImpl).toHaveBeenCalledTimes(1));
    // Settled as an attempt that ended without a sign-in: the ambient flow
    // releases it, which aborts the long-poll's signal.
    await waitFor(() => {
      expect(awaitLoginImpl.mock.calls.at(-1)?.[0].signal?.aborted).toBe(true);
    });
    expect(succeededEvents()).toHaveLength(0);
    expect(flowState()).toBe("start");
    // Quiet by design for the ambient banner reconnect, not a failure.
    expect(onFailed).not.toHaveBeenCalled();
    // `configured` is not a pending verdict either: it is not re-polled.
    expect(awaitLoginImpl).toHaveBeenCalledTimes(1);
  });
});

// Kimi has no managed profiles, so the profile classifier is reached for it
// only by create mode (or a reauth of a profile id), and its projected
// completion carries `profiles: []`. The row rules are therefore pinned over
// `claude-code`, a provider that has managed profiles, fed the same projected
// top-level auth.
describe("useProviderProfileLoginFlow - the profile classifier over a projected completion", () => {
  it("reads a create-mode completion as signed in when the target row is authenticated", async () => {
    const { onFailed } = renderFlow({
      providerId: "claude-code",
      mode: "create",
      existingProfileId: null,
      startLoginImpl: () =>
        Promise.resolve(startedAnswer({ profileId: "p-1" })),
      awaitLoginImpl: () =>
        Promise.resolve(
          projectedCompletionWith("claude-code", [
            managedRow("p-1", "authenticated"),
          ]),
        ),
    });

    await waitFor(() => expect(flowState()).toBe("identity"));
    expect(screen.getByTestId("flow-identity-profile").textContent).toBe("p-1");
    expect(succeededEvents()).toHaveLength(1);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("reads a reauth of a profile id as signed in when that row is authenticated", async () => {
    renderFlow({
      providerId: "claude-code",
      mode: "reauth",
      existingProfileId: "p-existing",
      startLoginImpl: () =>
        Promise.resolve(startedAnswer({ profileId: "p-existing" })),
      awaitLoginImpl: () =>
        Promise.resolve(
          projectedCompletionWith("claude-code", [
            managedRow("p-existing", "authenticated"),
          ]),
        ),
    });

    await waitFor(() => expect(flowState()).toBe("identity"));
    expect(screen.getByTestId("flow-identity-profile").textContent).toBe(
      "p-existing",
    );
  });

  it("does not read a completion as signed in when the target row is missing, even with top-level authenticated", async () => {
    const completion = projectedCompletionWith("claude-code", [
      managedRow("p-other", "authenticated"),
    ]);
    expect(completion.state?.auth.status).toBe("authenticated");
    const { onFailed } = renderFlow({
      providerId: "claude-code",
      mode: "create",
      existingProfileId: null,
      startLoginImpl: () =>
        Promise.resolve(startedAnswer({ profileId: "p-1" })),
      awaitLoginImpl: () => Promise.resolve(completion),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(screen.getByTestId("flow-message").textContent).toBe(NOT_FINISHED);
    expect(onFailed).toHaveBeenCalledWith(NOT_FINISHED);
    expect(succeededEvents()).toHaveLength(0);
  });

  it("does not read a completion as signed in when the target row is present but only configured", async () => {
    const { onFailed } = renderFlow({
      providerId: "claude-code",
      mode: "create",
      existingProfileId: null,
      startLoginImpl: () =>
        Promise.resolve(startedAnswer({ profileId: "p-1" })),
      awaitLoginImpl: () =>
        Promise.resolve(
          projectedCompletionWith("claude-code", [
            managedRow("p-1", "configured"),
          ]),
        ),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(onFailed).toHaveBeenCalledWith(NOT_FINISHED);
    expect(succeededEvents()).toHaveLength(0);
  });

  it("does not read Kimi's own projected completion as a signed-in profile: it carries no rows", async () => {
    // Create mode is the profile path for Kimi too. The real projected
    // fixture has `profiles: []`, so the target row is missing and the
    // top-level `authenticated` alone is not a profile sign-in.
    const { onFailed } = renderFlow({
      providerId: "kimi",
      mode: "create",
      existingProfileId: null,
      startLoginImpl: () =>
        Promise.resolve(startedAnswer({ profileId: "p-1" })),
      awaitLoginImpl: () => Promise.resolve(PROJECTED_KIMI_AWAIT_LOGIN),
    });

    await waitFor(() => expect(flowState()).toBe("failed"));
    expect(onFailed).toHaveBeenCalledWith(NOT_FINISHED);
    expect(succeededEvents()).toHaveLength(0);
  });
});
