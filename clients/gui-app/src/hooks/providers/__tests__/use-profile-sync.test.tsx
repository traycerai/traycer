/**
 * Dispatches each of the four profile-sync mutation hooks through the REAL
 * `useHostMutation`, a real `HostClient` and a `MockHostMessenger`. A hook that
 * omits `mapVariables` throws `args.mapVariables is not a function` at
 * `mutate()` time, which no render-only test sees: the request must reach the
 * messenger, unchanged, on the captured source host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  ProfileSyncBatch,
  ProfileSyncRule,
} from "@traycer/protocol/host/profile-sync-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import {
  hostDirectoryEntry,
  OPERATION_ID as COPY_OPERATION_ID,
  RETRY_REQUEST_ID,
  profileCopyAttempt,
  profileCopyOutcome,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";

const harness = vi.hoisted(
  (): { spine: HostClient<HostRpcRegistry> | null } => ({ spine: null }),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null || harness.spine === null) return null;
    return harness.spine.createRequesterForHostId(hostId);
  },
}));

import { useProfileCopyRetryMutation } from "@/hooks/providers/profile-copy/use-profile-copy-operation-mutations";
import {
  useProfileSyncList,
  useProfileSyncResolve,
  useProfileSyncSaveRule,
  useProfileSyncStart,
  useProfileSyncStopRule,
} from "@/hooks/providers/use-profile-sync";

const SOURCE = "source-host";
const DEST = "dest-host";
const BATCH_ID = "44444444-4444-4444-8444-444444444444";
const RULE_ID = "55555555-5555-4555-8555-555555555555";
const OPERATION_ID = "66666666-6666-4666-8666-666666666666";
const REVISION = "a".repeat(64);

const BATCH: ProfileSyncBatch = {
  batchId: BATCH_ID,
  sourceHostId: SOURCE,
  createdAt: 1,
  automatic: false,
  items: [],
};
const RULE: ProfileSyncRule = {
  ruleId: RULE_ID,
  sourceHostId: SOURCE,
  destinationHostId: DEST,
  scope: { kind: "all" },
  paused: false,
  revision: 1,
  lastCheckedAt: null,
  batchId: null,
  status: "waiting",
};

function setup(): {
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = createAppQueryClient();
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-sync-hook",
    handlers: {
      "providers.profileCopy.sync.start": () => BATCH,
      "providers.profileCopy.sync.saveRule": () => RULE,
      "providers.profileCopy.sync.stopRule": () => ({ batches: [], rules: [] }),
      "providers.profileCopy.sync.resolve": () => BATCH,
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => hostDirectoryEntry(hostId, hostId),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-sync",
    }),
  );
  harness.spine = spine;
  return {
    messenger,
    wrapper: (props) => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    ),
  };
}

function callsOf(
  messenger: MockHostMessenger<HostRpcRegistry>,
  method: string,
) {
  return messenger.calls.filter((call) => call.method === method);
}

describe("profile sync mutation hooks dispatch", () => {
  beforeEach(() => {
    harness.spine = null;
  });
  afterEach(() => {
    cleanup();
    harness.spine = null;
  });

  it("start sends the selection, revision and batch id to the source host", async () => {
    const { messenger, wrapper } = setup();
    const { result } = renderHook(() => useProfileSyncStart(SOURCE), {
      wrapper,
    });
    const request = {
      selection: {
        sourceHostId: SOURCE,
        scope: { kind: "all" as const },
        destinationHostIds: [DEST],
      },
      revision: REVISION,
      batchId: BATCH_ID,
    };
    act(() => result.current.mutate(request));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const calls = callsOf(messenger, "providers.profileCopy.sync.start");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual(request);
    expect(calls[0]?.authority.endpoint.hostId).toBe(SOURCE);
    expect(result.current.data?.batchId).toBe(BATCH_ID);
  });

  it("saveRule sends the rule fields and its expected revision", async () => {
    const { messenger, wrapper } = setup();
    const { result } = renderHook(() => useProfileSyncSaveRule(SOURCE), {
      wrapper,
    });
    const request = {
      ruleId: RULE_ID,
      sourceHostId: SOURCE,
      destinationHostId: DEST,
      scope: { kind: "all" as const },
      paused: false,
      expectedRevision: 0,
    };
    act(() => result.current.mutate(request));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const calls = callsOf(messenger, "providers.profileCopy.sync.saveRule");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual(request);
    expect(calls[0]?.authority.endpoint.hostId).toBe(SOURCE);
  });

  it("stopRule sends the rule id and expected revision", async () => {
    const { messenger, wrapper } = setup();
    const { result } = renderHook(() => useProfileSyncStopRule(SOURCE), {
      wrapper,
    });
    const request = {
      sourceHostId: SOURCE,
      ruleId: RULE_ID,
      expectedRevision: 1,
    };
    act(() => result.current.mutate(request));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const calls = callsOf(messenger, "providers.profileCopy.sync.stopRule");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual(request);
    expect(calls[0]?.authority.endpoint.hostId).toBe(SOURCE);
  });

  it("resolve sends the batch, operation and action", async () => {
    const { messenger, wrapper } = setup();
    const { result } = renderHook(() => useProfileSyncResolve(SOURCE), {
      wrapper,
    });
    const request = {
      sourceHostId: SOURCE,
      batchId: BATCH_ID,
      operationId: OPERATION_ID,
      action: "check" as const,
      expectedDestination: null,
    };
    act(() => result.current.mutate(request));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const calls = callsOf(messenger, "providers.profileCopy.sync.resolve");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual(request);
    expect(calls[0]?.authority.endpoint.hostId).toBe(SOURCE);
  });
});

describe("a successful transfer retry refreshes the sync history", () => {
  beforeEach(() => {
    harness.spine = null;
  });
  afterEach(() => {
    cleanup();
    harness.spine = null;
  });

  it("refetches the retried source's sync.list at once and leaves another source's cache alone", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-retry-hook",
      handlers: {
        "providers.profileCopy.sync.list": () => ({ batches: [], rules: [] }),
        "providers.profileCopy.retry": () => ({
          result: "current" as const,
          outcome: profileCopyOutcome({}),
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) => hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-sync",
      }),
    );
    harness.spine = spine;
    const OTHER_SOURCE = "other-source-host";
    const { result } = renderHook(
      () => ({
        sourceList: useProfileSyncList(SOURCE),
        otherList: useProfileSyncList(OTHER_SOURCE),
        retry: useProfileCopyRetryMutation(SOURCE, COPY_OPERATION_ID),
      }),
      {
        wrapper: (props) => (
          <QueryClientProvider client={queryClient}>
            {props.children}
          </QueryClientProvider>
        ),
      },
    );
    const listCalls = (hostId: string): number =>
      messenger.calls.filter(
        (call) =>
          call.method === "providers.profileCopy.sync.list" &&
          call.authority.endpoint.hostId === hostId,
      ).length;
    await waitFor(() => {
      expect(result.current.sourceList.isSuccess).toBe(true);
      expect(result.current.otherList.isSuccess).toBe(true);
    });
    expect(listCalls(SOURCE)).toBe(1);
    expect(listCalls(OTHER_SOURCE)).toBe(1);
    act(() => {
      result.current.retry.mutate({
        attempt: profileCopyAttempt({ sourceHostId: SOURCE }),
        expectedRevision: 1,
        retryRequestId: RETRY_REQUEST_ID,
      });
    });
    await waitFor(() => expect(result.current.retry.isSuccess).toBe(true));
    await waitFor(() => expect(listCalls(SOURCE)).toBe(2));
    expect(listCalls(OTHER_SOURCE)).toBe(1);
  });
});
