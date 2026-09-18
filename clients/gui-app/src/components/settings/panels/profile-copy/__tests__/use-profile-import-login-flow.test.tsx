import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { RpcErrorCode } from "@traycer/protocol/framework/versioned-rpc-types";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useProfileImportLoginFlow } from "@/components/settings/panels/profile-copy/use-profile-import-login-flow";
import { useProfileCopyDraftStatusQuery } from "@/hooks/providers/profile-copy/use-profile-copy-queries";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import type {
  ProfileCopyAttempt,
  ProfileCopyOutcome,
  ProfileCopyReason,
} from "@/lib/profile-copy/profile-copy-model";
import {
  ATTEMPT_ID,
  ATTEMPT_TWO_ID,
  DEST_HOST_ID,
  DEST_HOST_TWO_ID,
  hostDirectoryEntry,
  LOGIN_ATTEMPT_ID,
  profileCopyAttempt,
  recordedOutcome,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";

const spineRef = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null || spineRef.current === null) return null;
    return spineRef.current.createRequesterForHostId(hostId);
  },
}));

function resetFlow(): void {
  useProfileCopyFlowStore.setState({
    view: null,
    session: 0,
    activeLogin: null,
    directBlocks: {},
  });
}

function rpcError(code: RpcErrorCode, method: string): HostRpcError {
  return new HostRpcError({
    code,
    message: "profile copy test error",
    requestId: "req-login",
    method,
    fatalDetails: null,
  });
}

function DraftStatusProbe(props: {
  readonly attempt: ProfileCopyAttempt;
}): null {
  useProfileCopyDraftStatusQuery(props.attempt, true);
  return null;
}

function startedJobRefusalResponse(input: {
  readonly revision: number;
  readonly state: "blocked" | "quarantined";
  readonly reason: ProfileCopyReason;
}): {
  readonly outcome: ProfileCopyOutcome;
  readonly loginAttemptId: string;
  readonly challenge: null;
} {
  return {
    outcome: recordedOutcome({
      state: input.state,
      reason: input.reason,
      revision: input.revision,
    }),
    loginAttemptId: LOGIN_ATTEMPT_ID,
    challenge: null,
  };
}

function loginResponse(input: {
  readonly revision: number;
  readonly state: "signing-in" | "blocked" | "sign-in-required" | "cancelled";
  readonly reason: "adapter-not-admitted" | null;
  readonly loginAttemptId: string | null;
}): {
  readonly outcome: ProfileCopyOutcome;
  readonly loginAttemptId: string | null;
  readonly challenge: {
    readonly kind: "device-code";
    readonly url: string;
    readonly userCode: string;
  } | null;
} {
  return {
    outcome: recordedOutcome({
      state: input.state,
      reason: input.reason,
      revision: input.revision,
    }),
    loginAttemptId: input.loginAttemptId,
    challenge:
      input.loginAttemptId === null
        ? null
        : {
            kind: "device-code",
            url: "https://example.invalid/device",
            userCode: "WXYZ-1234",
          },
  };
}

describe("useProfileImportLoginFlow", () => {
  beforeEach(() => {
    resetFlow();
    spineRef.current = null;
  });
  afterEach(() => {
    cleanup();
    resetFlow();
    spineRef.current = null;
    vi.useRealTimers();
  });

  it("sends login.start at the given revision", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.login.start": () =>
          loginResponse({
            revision: 2,
            state: "signing-in",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          }),
        "providers.profileCopy.login.await": () =>
          loginResponse({
            revision: 3,
            state: "sign-in-required",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-login",
      }),
    );
    spineRef.current = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const attempt = profileCopyAttempt({});
    const hook = renderHook(() => useProfileImportLoginFlow(attempt), {
      wrapper,
    });

    act(() => {
      hook.result.current.start(7);
    });

    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.login.start",
        ),
      ).toBe(true),
    );
    const startCall = messenger.calls.find(
      (call) => call.method === "providers.profileCopy.login.start",
    );
    expect(startCall?.authority.endpoint.hostId).toBe(DEST_HOST_ID);
    expect(startCall?.params).toMatchObject({
      attempt,
      expectedRevision: 7,
    });
  });

  it("records a sign-in direct block for a route-closed start with no loginAttemptId", async () => {
    const queryClient = createAppQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.login.start": () =>
          loginResponse({
            revision: 3,
            state: "blocked",
            reason: "adapter-not-admitted",
            loginAttemptId: null,
          }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-login",
      }),
    );
    spineRef.current = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hook = renderHook(
      () => useProfileImportLoginFlow(profileCopyAttempt({})),
      { wrapper },
    );

    act(() => {
      hook.result.current.start(1);
    });

    await waitFor(() =>
      expect(
        useProfileCopyFlowStore.getState().directBlocks[ATTEMPT_ID],
      ).toEqual({
        verb: "sign-in",
        revision: 3,
        reason: "adapter-not-admitted",
        repeats: 1,
      }),
    );
    expect(hook.result.current.notice).toBeNull();
    expect(hook.result.current.phase.kind).toBe("idle");
    expect(
      messenger.calls.filter(
        (call) => call.method === "providers.profileCopy.login.start",
      ),
    ).toHaveLength(1);
    expect(
      messenger.calls.some(
        (call) => call.method === "providers.profileCopy.login.await",
      ),
    ).toBe(false);
    expect(invalidate).toHaveBeenCalled();
  });

  it("reports elsewhere when signing-in returns a null loginAttemptId", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.login.start": () =>
          loginResponse({
            revision: 2,
            state: "signing-in",
            reason: null,
            loginAttemptId: null,
          }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-login",
      }),
    );
    spineRef.current = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hook = renderHook(
      () => useProfileImportLoginFlow(profileCopyAttempt({})),
      { wrapper },
    );
    act(() => {
      hook.result.current.start(1);
    });
    await waitFor(() =>
      expect(hook.result.current.notice).toEqual({
        kind: "elsewhere",
        revision: 2,
      }),
    );
  });

  it("settles await of sign-in-required as unfinished", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.login.start": () =>
          loginResponse({
            revision: 2,
            state: "signing-in",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          }),
        "providers.profileCopy.login.await": () =>
          loginResponse({
            revision: 3,
            state: "sign-in-required",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-login",
      }),
    );
    spineRef.current = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hook = renderHook(
      () => useProfileImportLoginFlow(profileCopyAttempt({})),
      { wrapper },
    );
    act(() => {
      hook.result.current.start(1);
    });
    await waitFor(() =>
      expect(hook.result.current.notice?.kind).toBe("unfinished"),
    );
    expect(hook.result.current.phase.kind).toBe("idle");
  });

  it("marks await errors as lost, invalidates draftStatus, and does not restart", async () => {
    const queryClient = createAppQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.login.start": () =>
          loginResponse({
            revision: 2,
            state: "signing-in",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          }),
        "providers.profileCopy.login.await": () => {
          throw rpcError("RPC_ERROR", "providers.profileCopy.login.await");
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-login",
      }),
    );
    spineRef.current = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hook = renderHook(
      () => useProfileImportLoginFlow(profileCopyAttempt({})),
      { wrapper },
    );
    act(() => {
      hook.result.current.start(1);
    });
    await waitFor(() => expect(hook.result.current.notice?.kind).toBe("lost"));
    expect(
      messenger.calls.filter(
        (call) => call.method === "providers.profileCopy.login.start",
      ),
    ).toHaveLength(1);
    expect(invalidate).toHaveBeenCalled();
  });

  it("touches every 60s with the latest revision", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const queryClient = createAppQueryClient();
    let touchRevision = 2;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.login.start": () =>
          loginResponse({
            revision: 2,
            state: "signing-in",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          }),
        "providers.profileCopy.login.await": () => new Promise(() => undefined),
        "providers.profileCopy.login.touch": () => {
          touchRevision += 1;
          return loginResponse({
            revision: touchRevision,
            state: "signing-in",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          });
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-login",
      }),
    );
    spineRef.current = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hook = renderHook(
      () => useProfileImportLoginFlow(profileCopyAttempt({})),
      { wrapper },
    );
    act(() => {
      hook.result.current.start(1);
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("waiting"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() =>
      expect(
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.login.touch",
        ),
      ).toHaveLength(1),
    );
    const firstTouch = messenger.calls.find(
      (call) => call.method === "providers.profileCopy.login.touch",
    );
    expect(firstTouch?.params).toMatchObject({
      expectedRevision: 2,
      loginAttemptId: LOGIN_ATTEMPT_ID,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() =>
      expect(
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.login.touch",
        ),
      ).toHaveLength(2),
    );
    const touches = messenger.calls.filter(
      (call) => call.method === "providers.profileCopy.login.touch",
    );
    expect(touches[1]?.params).toMatchObject({
      expectedRevision: 3,
      loginAttemptId: LOGIN_ATTEMPT_ID,
    });
  });

  it("submit and cancel carry loginAttemptId and the latest revision", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.login.start": () =>
          loginResponse({
            revision: 2,
            state: "signing-in",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          }),
        "providers.profileCopy.login.await": () => new Promise(() => undefined),
        "providers.profileCopy.login.submitCode": () =>
          loginResponse({
            revision: 4,
            state: "signing-in",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          }),
        "providers.profileCopy.login.cancel": () =>
          loginResponse({
            revision: 5,
            state: "cancelled",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-login",
      }),
    );
    spineRef.current = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hook = renderHook(
      () => useProfileImportLoginFlow(profileCopyAttempt({})),
      { wrapper },
    );
    act(() => {
      hook.result.current.start(1);
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("waiting"));

    act(() => {
      hook.result.current.codePaste.submit("PASTE-CODE");
    });
    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.login.submitCode",
        ),
      ).toBe(true),
    );
    expect(
      messenger.calls.find(
        (call) => call.method === "providers.profileCopy.login.submitCode",
      )?.params,
    ).toMatchObject({
      loginAttemptId: LOGIN_ATTEMPT_ID,
      expectedRevision: 2,
      code: "PASTE-CODE",
    });
    await waitFor(() => {
      const mutations = queryClient.getMutationCache().getAll();
      expect(
        mutations.every((mutation) => {
          const variables: unknown = mutation.state.variables;
          return (
            typeof variables !== "object" ||
            variables === null ||
            !("code" in variables)
          );
        }),
      ).toBe(true);
    });

    await waitFor(() =>
      expect(hook.result.current.codePaste.phase).toBe("verifying"),
    );
    act(() => {
      hook.result.current.cancel();
    });
    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.login.cancel",
        ),
      ).toBe(true),
    );
    expect(
      messenger.calls.find(
        (call) => call.method === "providers.profileCopy.login.cancel",
      )?.params,
    ).toMatchObject({
      loginAttemptId: LOGIN_ATTEMPT_ID,
      expectedRevision: 4,
    });
  });

  it("does not start a second attempt while another holds the lock", () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-login",
      }),
    );
    spineRef.current = spine;
    useProfileCopyFlowStore.getState().claimLogin({
      destinationHostId: DEST_HOST_TWO_ID,
      attemptId: ATTEMPT_TWO_ID,
    });
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hook = renderHook(
      () => useProfileImportLoginFlow(profileCopyAttempt({})),
      { wrapper },
    );
    act(() => {
      hook.result.current.start(1);
    });
    expect(messenger.calls).toHaveLength(0);
    expect(hook.result.current.blockedByOtherLogin).toBe(true);
  });

  it("releases the lock on unmount and sends no cancel", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.login.start": () =>
          loginResponse({
            revision: 2,
            state: "signing-in",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          }),
        "providers.profileCopy.login.await": () => new Promise(() => undefined),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-login",
      }),
    );
    spineRef.current = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hook = renderHook(
      () => useProfileImportLoginFlow(profileCopyAttempt({})),
      { wrapper },
    );
    act(() => {
      hook.result.current.start(1);
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("waiting"));
    expect(useProfileCopyFlowStore.getState().activeLogin?.attemptId).toBe(
      ATTEMPT_ID,
    );
    hook.unmount();
    expect(useProfileCopyFlowStore.getState().activeLogin).toBeNull();
    expect(
      messenger.calls.some(
        (call) => call.method === "providers.profileCopy.login.cancel",
      ),
    ).toBe(false);
  });

  it("shows start-failed and releases the lock when login.start errors", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.login.start": () => {
          throw rpcError("RPC_ERROR", "providers.profileCopy.login.start");
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-login",
      }),
    );
    spineRef.current = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hook = renderHook(
      () => useProfileImportLoginFlow(profileCopyAttempt({})),
      { wrapper },
    );
    act(() => {
      hook.result.current.start(1);
    });
    await waitFor(() =>
      expect(hook.result.current.notice?.kind).toBe("start-failed"),
    );
    expect(useProfileCopyFlowStore.getState().activeLogin).toBeNull();
    expect(
      useProfileCopyFlowStore.getState().claimLogin({
        destinationHostId: DEST_HOST_TWO_ID,
        attemptId: ATTEMPT_TWO_ID,
      }),
    ).toBe(true);
  });

  it("keeps the waiting step and retries cancel after login.cancel errors", async () => {
    const queryClient = createAppQueryClient();
    let cancelCalls = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.login.start": () =>
          loginResponse({
            revision: 2,
            state: "signing-in",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          }),
        "providers.profileCopy.login.await": () => new Promise(() => undefined),
        "providers.profileCopy.login.cancel": () => {
          cancelCalls += 1;
          if (cancelCalls === 1) {
            throw rpcError("RPC_ERROR", "providers.profileCopy.login.cancel");
          }
          return loginResponse({
            revision: 5,
            state: "cancelled",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          });
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-login",
      }),
    );
    spineRef.current = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hook = renderHook(
      () => useProfileImportLoginFlow(profileCopyAttempt({})),
      { wrapper },
    );
    act(() => {
      hook.result.current.start(1);
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("waiting"));
    act(() => {
      hook.result.current.cancel();
    });
    await waitFor(() =>
      expect(hook.result.current.notice?.kind).toBe("cancel-failed"),
    );
    expect(hook.result.current.phase.kind).toBe("waiting");
    act(() => {
      hook.result.current.cancel();
    });
    await waitFor(() =>
      expect(
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.login.cancel",
        ),
      ).toHaveLength(2),
    );
  });

  it("drops pasted code and challenges from the mutation cache after settle", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.login.start": () =>
          loginResponse({
            revision: 2,
            state: "signing-in",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          }),
        "providers.profileCopy.login.await": () => new Promise(() => undefined),
        "providers.profileCopy.login.submitCode": () => {
          throw rpcError("RPC_ERROR", "providers.profileCopy.login.submitCode");
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-login",
      }),
    );
    spineRef.current = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hook = renderHook(
      () => useProfileImportLoginFlow(profileCopyAttempt({})),
      { wrapper },
    );
    act(() => {
      hook.result.current.start(1);
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("waiting"));
    await waitFor(() => {
      const mutations = queryClient.getMutationCache().getAll();
      expect(
        mutations.every((mutation) => {
          const data: unknown = mutation.state.data;
          return (
            typeof data !== "object" || data === null || !("challenge" in data)
          );
        }),
      ).toBe(true);
    });
    act(() => {
      hook.result.current.codePaste.submit("PASTE-CODE");
    });
    await waitFor(() =>
      expect(hook.result.current.codePaste.submitError).not.toBeNull(),
    );
    await waitFor(() => {
      const mutations = queryClient.getMutationCache().getAll();
      expect(
        mutations.every((mutation) => {
          const variables: unknown = mutation.state.variables;
          return (
            typeof variables !== "object" ||
            variables === null ||
            !("code" in variables)
          );
        }),
      ).toBe(true);
    });
  });

  it("does not spin a zero-delay GC loop for a pending login.await after unmount", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.login.start": () =>
          loginResponse({
            revision: 2,
            state: "signing-in",
            reason: null,
            loginAttemptId: LOGIN_ATTEMPT_ID,
          }),
        "providers.profileCopy.login.await": () => new Promise(() => undefined),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-login",
      }),
    );
    spineRef.current = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hook = renderHook(
      () => useProfileImportLoginFlow(profileCopyAttempt({})),
      { wrapper },
    );
    act(() => {
      hook.result.current.start(1);
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("waiting"));
    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.login.await",
        ),
      ).toBe(true),
    );
    hook.unmount();
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 60);
      });
      const zeroDelayCalls = spy.mock.calls.filter((call) => {
        const delay: unknown = call[1];
        return delay === 0 || delay === undefined;
      }).length;
      expect(zeroDelayCalls).toBeLessThan(5);
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .some((mutation) => mutation.state.status === "pending"),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  const startedJobShapes: ReadonlyArray<{
    readonly state: "blocked" | "quarantined";
    readonly reason: ProfileCopyReason;
  }> = [
    { state: "blocked", reason: "login-start-unavailable" },
    { state: "blocked", reason: "device-auth-unavailable" },
    { state: "blocked", reason: "login-resource-busy" },
    { state: "quarantined", reason: "writer-unconfirmed" },
  ];

  for (const shape of startedJobShapes) {
    it(`treats a started login job with no challenge as start-refused (${shape.reason})`, async () => {
      const queryClient = createAppQueryClient();
      const attempt = profileCopyAttempt({});
      const seededBlock = {
        verb: "sign-in" as const,
        revision: 1,
        reason: "login-start-unavailable" as const,
      };
      useProfileCopyFlowStore
        .getState()
        .recordDirectBlock(ATTEMPT_ID, seededBlock);
      const seeded =
        useProfileCopyFlowStore.getState().directBlocks[ATTEMPT_ID];
      let draftReads = 0;
      const messenger = new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-1",
        handlers: {
          "providers.profileCopy.draftStatus": () => {
            draftReads += 1;
            return {
              result: "current" as const,
              outcome: recordedOutcome({
                state: "sign-in-required",
                revision: draftReads === 1 ? 1 : 5,
              }),
            };
          },
          "providers.profileCopy.login.start": () =>
            startedJobRefusalResponse({
              revision: 3,
              state: shape.state,
              reason: shape.reason,
            }),
          "providers.profileCopy.login.await": () =>
            loginResponse({
              revision: 4,
              state: "sign-in-required",
              reason: null,
              loginAttemptId: LOGIN_ATTEMPT_ID,
            }),
        },
      });
      const spine = new HostClient<HostRpcRegistry>({
        registry: hostRpcRegistry,
        schedulingPolicy: hostRpcSchedulingPolicy,
        invalidator: createHostQueryInvalidator(queryClient),
        findHostById: (hostId) =>
          hostId === DEST_HOST_ID
            ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
            : null,
        messenger,
      });
      spine.setRequestContext(
        createRequestContextFixture({
          origin: "renderer",
          bearerToken: "tok-login",
        }),
      );
      spineRef.current = spine;
      const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
        <QueryClientProvider client={queryClient}>
          <DraftStatusProbe attempt={attempt} />
          {props.children}
        </QueryClientProvider>
      );
      const hook = renderHook(() => useProfileImportLoginFlow(attempt), {
        wrapper,
      });
      await waitFor(() => expect(draftReads).toBeGreaterThan(0));
      act(() => {
        hook.result.current.start(1);
      });
      await waitFor(() => expect(hook.result.current.phase.kind).toBe("idle"));
      expect(hook.result.current.notice).toEqual({
        kind: "start-refused",
        reason: shape.reason,
      });
      expect(hook.result.current.startRefusal).toBe(shape.reason);
      expect(useProfileCopyFlowStore.getState().activeLogin).toBeNull();
      const noticeAtRefuse = hook.result.current.notice;
      await waitFor(() => expect(draftReads).toBeGreaterThan(1));
      expect(
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.login.await",
        ),
      ).toHaveLength(0);
      expect(hook.result.current.notice).toEqual(noticeAtRefuse);
      expect(
        useProfileCopyFlowStore.getState().directBlocks[ATTEMPT_ID],
      ).toEqual(seeded);
      expect(
        useProfileCopyFlowStore.getState().directBlocks[ATTEMPT_ID]?.repeats,
      ).toBe(1);
    });
  }
});
