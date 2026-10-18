import { StrictMode, useEffect, useRef, type ReactNode } from "react";
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
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type { AwaitLoginVariables } from "@/hooks/providers/use-providers-await-login-mutation";
import {
  providerHostBlockLabel,
  type ProviderHostBlock,
} from "@/components/providers/provider-signin-availability";
import { MACOS_13_SENTENCE } from "@/components/providers/__tests__/macos-requirement-test-support";
import {
  useProviderProfileLoginFlow,
  type ProviderProfileLoginFlowMode,
} from "@/components/settings/panels/use-provider-profile-login-flow";

// The REAL flow hook against real `useMutation` instances whose request seams
// are spies. The guard is what keeps the reauth panel's mount effect (and any
// other programmatic start) from asking a host that cannot run the provider.

type StartLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.startLogin"
>;
type StartLoginResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.startLogin"
>;
type AwaitLoginResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;
type CancelLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.cancelLogin"
>;
type EnsurePackRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.ensurePack"
>;
type Ctx = { readonly hostId: string | null };

const MACOS_BLOCK: ProviderHostBlock = {
  kind: "macos",
  requiredMacos: "14.0",
  runningMacos: "13.6",
};

const spies = vi.hoisted(() => ({
  startLogin: vi.fn<(request: unknown) => unknown>(),
  ensurePack: vi.fn<(request: unknown) => unknown>(),
}));

function Harness(props: {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly hostBlock: ProviderHostBlock | null;
  readonly autoStart: boolean;
  readonly onFailed: (message: string) => void;
}): ReactNode {
  const startLogin = useMutation<
    StartLoginResponse,
    HostRpcError,
    StartLoginRequest,
    Ctx
  >({
    mutationFn: (request) => {
      spies.startLogin(request);
      return new Promise<StartLoginResponse>(() => {});
    },
    onMutate: () => ({ hostId: null }),
  });
  const awaitLogin = useMutation<
    AwaitLoginResponse,
    HostRpcError,
    AwaitLoginVariables,
    Ctx
  >({
    mutationFn: () => new Promise<AwaitLoginResponse>(() => {}),
    onMutate: () => ({ hostId: null }),
  });
  const cancelLogin = useMutation<
    ResponseOfMethod<HostRpcRegistry, "providers.cancelLogin">,
    HostRpcError,
    CancelLoginRequest,
    Ctx
  >({
    mutationFn: () => Promise.resolve({ cancelled: true }),
    onMutate: () => ({ hostId: null }),
  });
  const submitLoginCode = useMutation<
    ResponseOfMethod<HostRpcRegistry, "providers.submitLoginCode">,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, "providers.submitLoginCode">
  >({
    mutationFn: () => Promise.resolve({ outcome: "accepted" }),
  });
  const touchLogin = useMutation<
    ResponseOfMethod<HostRpcRegistry, "providers.touchLogin">,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, "providers.touchLogin">
  >({
    mutationFn: () => Promise.resolve({ extended: true }),
  });
  const ensurePack = useMutation<
    ResponseOfMethod<HostRpcRegistry, "providers.ensurePack">,
    HostRpcError,
    EnsurePackRequest,
    Ctx
  >({
    mutationFn: (request) => {
      spies.ensurePack(request);
      return Promise.resolve({ managedInstallState: null });
    },
    onMutate: () => ({ hostId: null }),
  });

  const flow = useProviderProfileLoginFlow({
    supportsLoginOwnership: false,
    mode: props.mode,
    providerId: "antigravity",
    existingProfileId: props.mode === "reauth" ? "p-existing" : null,
    loginCapability: null,
    hostBlock: props.hostBlock,
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
    onFailed: props.onFailed,
  });

  // Mirrors the reauth panel's one-shot mount effect.
  const startedRef = useRef(false);
  const start = flow.start;
  useEffect(() => {
    if (!props.autoStart || startedRef.current) return;
    startedRef.current = true;
    start({ label: null, shareSkillsAndPlugins: false });
  }, [props.autoStart, start]);

  return (
    <div>
      <div data-testid="state">{flow.state.kind}</div>
      <div data-testid="message">
        {flow.state.kind === "failed" ? flow.state.message : ""}
      </div>
      <button
        type="button"
        onClick={() =>
          flow.start({ label: "Profile", shareSkillsAndPlugins: false })
        }
      >
        start
      </button>
    </div>
  );
}

function mount(props: Parameters<typeof Harness>[0], strict: boolean): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

afterEach(() => {
  cleanup();
  spies.startLogin.mockReset();
  spies.ensurePack.mockReset();
});

describe("useProviderProfileLoginFlow - macOS host block", () => {
  it("refuses a click before startLogin or ensurePack and lands on failed with the sentence", async () => {
    const onFailed = vi.fn<(message: string) => void>();
    mount(
      { mode: "create", hostBlock: MACOS_BLOCK, autoStart: false, onFailed },
      false,
    );
    expect(providerHostBlockLabel(MACOS_BLOCK, "Antigravity")).toBe(
      MACOS_13_SENTENCE,
    );

    fireEvent.click(screen.getByRole("button", { name: "start" }));

    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("failed"),
    );
    expect(screen.getByTestId("message").textContent).toBe(MACOS_13_SENTENCE);
    expect(onFailed).toHaveBeenCalledWith(MACOS_13_SENTENCE);
    expect(spies.startLogin).not.toHaveBeenCalled();
    expect(spies.ensurePack).not.toHaveBeenCalled();
  });

  it("guards an automatic start from a mount effect, the reauth panel's path", async () => {
    mount(
      {
        mode: "reauth",
        hostBlock: MACOS_BLOCK,
        autoStart: true,
        onFailed: () => {},
      },
      true,
    );

    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("failed"),
    );
    expect(screen.getByTestId("message").textContent).toBe(MACOS_13_SENTENCE);
    expect(spies.startLogin).not.toHaveBeenCalled();
    expect(spies.ensurePack).not.toHaveBeenCalled();
  });

  it("starts as before with no block", async () => {
    mount(
      { mode: "create", hostBlock: null, autoStart: false, onFailed: () => {} },
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await waitFor(() => expect(spies.startLogin).toHaveBeenCalledTimes(1));
  });

  it("enforces only the macos kind inside start; other kinds keep their control-level handling", async () => {
    mount(
      {
        mode: "create",
        hostBlock: { kind: "cli-missing" },
        autoStart: false,
        onFailed: () => {},
      },
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await waitFor(() => expect(spies.startLogin).toHaveBeenCalledTimes(1));
  });
});
