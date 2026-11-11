import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import { createRequestContext } from "@traycer/protocol/auth/request-context";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  TEAM_MEMBERSHIP_REQUIRED,
  TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
  TEAM_MEMBERSHIP_UNAVAILABLE,
  TEAM_MEMBERSHIP_UNAVAILABLE_MESSAGE,
} from "@traycer-clients/shared/host-transport/local-open-auth";
import type { ActivateResult } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { useMakeActiveHost } from "@/components/settings/host-scope/use-host-scope";
import { useSignOutConfirmStore } from "@/stores/auth/sign-out-confirm-store";

interface RecordedRequest {
  readonly entry: HostDirectoryEntry;
  readonly method: string;
  readonly params: unknown;
}

interface RecordedToastOptions {
  readonly action: {
    readonly label: string;
    readonly onClick: () => void;
  };
}

interface RecordedToast {
  readonly message: string;
  readonly options: RecordedToastOptions | undefined;
}

const mocks = vi.hoisted(() => {
  const state = {
    activeContext: null as RequestContext | null,
    requestCalls: [] as RecordedRequest[],
    createdEntries: [] as HostDirectoryEntry[],
    activationCalls: [] as string[],
    toastCalls: [] as RecordedToast[],
    requestResult: (_method: string, _params: unknown): Promise<unknown> =>
      Promise.resolve({}),
    activateResult: (_hostId: string): Promise<ActivateResult> =>
      Promise.resolve({ ok: true }),
  };
  return {
    state,
    selectionAuthority: {
      activate: (hostId: string) => {
        state.activationCalls.push(hostId);
        return state.activateResult(hostId);
      },
    },
    hostClient: {
      getRequestContext: () => state.activeContext,
      createRequester: (entry: HostDirectoryEntry) => {
        state.createdEntries.push(entry);
        return {
          request: (method: string, params: unknown) => {
            state.requestCalls.push({ entry, method, params });
            return state.requestResult(method, params);
          },
        };
      },
    },
    toast: {
      error: (message: string, options: RecordedToastOptions | undefined) => {
        state.toastCalls.push({ message, options });
      },
    },
  };
});

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    selectionAuthority: mocks.selectionAuthority,
  }),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.hostClient,
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));

vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  AnalyticsEvent: { HostSelected: "HostSelected" },
}));

vi.mock("sonner", () => ({
  toast: mocks.toast,
}));

const LOCAL_HOST_ID = "local-team-host";
const REMOTE_HOST_ID = "ready-remote-host";

const localEntry: HostDirectoryEntry = {
  hostId: LOCAL_HOST_ID,
  label: "Local team computer",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "test",
  transportDialability: "dialable",
};

const remoteEntry: HostDirectoryEntry = {
  hostId: REMOTE_HOST_ID,
  label: "Remote computer",
  kind: "remote",
  websocketUrl: "wss://relay.example.test/rpc",
  version: "test",
  transportDialability: "dialable",
};

function createContext(userId: string): RequestContext {
  return createRequestContext({
    identity: { userId, username: userId, providerHandle: null },
    bearerToken: `test-bearer-${userId}`,
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
    cloudAuthorized: true,
  });
}

function localOption(): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: LOCAL_HOST_ID,
    name: "Local team computer",
    isLocalMachine: false,
    isActive: false,
    connectable: true,
    registered: false,
    kind: null,
    entry: localEntry,
  });
}

function readyRemoteOption(): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: REMOTE_HOST_ID,
    name: "Remote computer",
    isLocalMachine: false,
    isActive: true,
    connectable: true,
    registered: true,
    kind: "personal",
    entry: remoteEntry,
  });
}

function admissionFailure(code: string): HostRpcError {
  const fatalDetails: FatalErrorDetails = {
    code,
    reason: "membership check result",
    incompatibleMethods: null,
    upgradeGuidance: null,
    ...(code === TEAM_MEMBERSHIP_UNAVAILABLE ? { retryable: true } : {}),
  };
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "local admission result",
    requestId: "local-admission-probe",
    method: "host.identity.get",
    fatalDetails,
  });
}

function transportFailure(): HostTransportFailureError {
  return new HostTransportFailureError({
    code: "RPC_ERROR",
    message: "local endpoint did not answer",
    requestId: "local-admission-probe",
    method: "host.identity.get",
    fatalDetails: null,
  });
}

function switchAccountAction(): () => void {
  const recorded = mocks.state.toastCalls.at(0);
  if (recorded === undefined) {
    throw new Error("expected the membership toast to include an action");
  }
  const action = recorded.options?.action;
  if (action === undefined || action.label !== "Switch account") {
    throw new Error("expected a Switch account action");
  }
  return action.onClick;
}

beforeEach(() => {
  mocks.state.activeContext = createContext("user-a");
  mocks.state.requestCalls.length = 0;
  mocks.state.createdEntries.length = 0;
  mocks.state.activationCalls.length = 0;
  mocks.state.toastCalls.length = 0;
  mocks.state.requestResult = (_method: string, _params: unknown) =>
    Promise.resolve({});
  mocks.state.activateResult = (_hostId: string) =>
    Promise.resolve({ ok: true });
  useSignOutConfirmStore.getState().setOpen(false);
});

afterEach(() => {
  cleanup();
  useSignOutConfirmStore.getState().setOpen(false);
});

describe("useMakeActiveHost local team admission", () => {
  it("probes an unregistered local entry with unknown registry kind while a remote host is active", async () => {
    const { result } = renderHook(() =>
      useMakeActiveHost([localOption(), readyRemoteOption()]),
    );
    let activated = false;

    await act(async () => {
      activated = await result.current.makeActive(LOCAL_HOST_ID);
    });

    expect(activated).toBe(true);
    expect(mocks.state.createdEntries).toEqual([localEntry]);
    expect(mocks.state.requestCalls).toEqual([
      {
        entry: localEntry,
        method: "host.identity.get",
        params: {},
      },
    ]);
    expect(mocks.state.activationCalls).toEqual([LOCAL_HOST_ID]);
  });

  it("shows the fixed nonmember toast and only opens sign-out confirmation for the original account", async () => {
    mocks.state.requestResult = (_method: string, _params: unknown) =>
      Promise.reject<unknown>(admissionFailure(TEAM_MEMBERSHIP_REQUIRED));
    const { result } = renderHook(() => useMakeActiveHost([localOption()]));
    let activated = true;

    await act(async () => {
      activated = await result.current.makeActive(LOCAL_HOST_ID);
    });

    expect(activated).toBe(false);
    expect(mocks.state.activationCalls).toEqual([]);
    expect(mocks.state.toastCalls).toHaveLength(1);
    expect(mocks.state.toastCalls[0]?.message).toBe(
      TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
    );

    const action = switchAccountAction();
    action();
    expect(useSignOutConfirmStore.getState().open).toBe(true);

    useSignOutConfirmStore.getState().setOpen(false);
    mocks.state.activeContext = createContext("user-b");
    action();
    expect(useSignOutConfirmStore.getState().open).toBe(false);
  });

  it("shows the fixed unavailable toast for a typed membership lookup failure", async () => {
    mocks.state.requestResult = (_method: string, _params: unknown) =>
      Promise.reject<unknown>(admissionFailure(TEAM_MEMBERSHIP_UNAVAILABLE));
    const { result } = renderHook(() => useMakeActiveHost([localOption()]));
    let activated = true;

    await act(async () => {
      activated = await result.current.makeActive(LOCAL_HOST_ID);
    });

    expect(activated).toBe(false);
    expect(mocks.state.activationCalls).toEqual([]);
    expect(mocks.state.toastCalls.map(({ message }) => message)).toEqual([
      TEAM_MEMBERSHIP_UNAVAILABLE_MESSAGE,
    ]);
  });

  it("shows the fixed unavailable toast for a transient local transport failure", async () => {
    mocks.state.requestResult = (_method: string, _params: unknown) =>
      Promise.reject<unknown>(transportFailure());
    const { result } = renderHook(() => useMakeActiveHost([localOption()]));
    let activated = true;

    await act(async () => {
      activated = await result.current.makeActive(LOCAL_HOST_ID);
    });

    expect(activated).toBe(false);
    expect(mocks.state.activationCalls).toEqual([]);
    expect(mocks.state.toastCalls.map(({ message }) => message)).toEqual([
      TEAM_MEMBERSHIP_UNAVAILABLE_MESSAGE,
    ]);
  });

  it("waits for the local identity probe before activating the selected host", async () => {
    let resolveProbe: (value: unknown) => void = () => {
      throw new Error("probe was not initialized");
    };
    const probe = new Promise<unknown>((resolve) => {
      resolveProbe = resolve;
    });
    mocks.state.requestResult = (_method: string, _params: unknown) => probe;
    const { result } = renderHook(() => useMakeActiveHost([localOption()]));
    const activation: { value: Promise<boolean> | null } = { value: null };

    act(() => {
      activation.value = result.current.makeActive(LOCAL_HOST_ID);
    });

    expect(mocks.state.requestCalls).toHaveLength(1);
    expect(mocks.state.activationCalls).toEqual([]);
    const pendingActivation = activation.value;
    if (pendingActivation === null)
      throw new Error("expected activation to start");

    await act(async () => {
      resolveProbe({});
      await pendingActivation;
    });

    await expect(pendingActivation).resolves.toBe(true);
    expect(mocks.state.activationCalls).toEqual([LOCAL_HOST_ID]);
  });

  it("does not probe until the person explicitly selects a host", () => {
    renderHook(() => useMakeActiveHost([localOption(), readyRemoteOption()]));

    expect(mocks.state.requestCalls).toEqual([]);
    expect(mocks.state.activationCalls).toEqual([]);
  });

  it("keeps remote activation on its existing immediate authority path", async () => {
    const { result } = renderHook(() =>
      useMakeActiveHost([localOption(), readyRemoteOption()]),
    );
    const activation: { value: Promise<boolean> | null } = { value: null };

    act(() => {
      activation.value = result.current.makeActive(REMOTE_HOST_ID);
    });

    expect(mocks.state.activationCalls).toEqual([REMOTE_HOST_ID]);
    expect(mocks.state.requestCalls).toEqual([]);
    const pendingActivation = activation.value;
    if (pendingActivation === null)
      throw new Error("expected activation to start");

    await expect(pendingActivation).resolves.toBe(true);
  });

  it("drops a pending local refusal when the request context changes", async () => {
    let rejectProbe: (reason: unknown) => void = () => {
      throw new Error("probe was not initialized");
    };
    const probe = new Promise<unknown>((_resolve, reject) => {
      rejectProbe = reject;
    });
    mocks.state.requestResult = (_method: string, _params: unknown) => probe;
    const { result } = renderHook(() => useMakeActiveHost([localOption()]));
    const activation: { value: Promise<boolean> | null } = { value: null };

    act(() => {
      activation.value = result.current.makeActive(LOCAL_HOST_ID);
    });
    const pendingActivation = activation.value;
    if (pendingActivation === null)
      throw new Error("expected activation to start");
    mocks.state.activeContext = createContext("user-b");

    await act(async () => {
      rejectProbe(admissionFailure(TEAM_MEMBERSHIP_REQUIRED));
      await pendingActivation;
    });

    await expect(pendingActivation).resolves.toBe(false);
    expect(mocks.state.activationCalls).toEqual([]);
    expect(mocks.state.toastCalls).toEqual([]);
  });
});
