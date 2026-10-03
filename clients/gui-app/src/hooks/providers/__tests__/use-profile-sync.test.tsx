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
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProfileCopyAttempt } from "@traycer/protocol/host/profile-copy-schemas";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  profileSyncBatchSchema,
  profileSyncListSchema,
  profileSyncRuleSchema,
} from "@traycer/protocol/host/profile-sync-schemas";
import type {
  ProfileSyncBatch,
  ProfileSyncSaveRule,
  ProfileSyncItem,
  ProfileSyncList,
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
  type ProfileSyncResolveVariables,
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

const RESOLVED_PROFILE = "88888888-8888-4888-8888-888888888888";

function resolvedItem(operationId: string): ProfileSyncItem {
  return {
    providerId: "claude",
    sourceProfileId: RESOLVED_PROFILE,
    name: "Work",
    destinationHostId: DEST,
    operationId,
    preview: null,
    outcome: null,
    state: "synced",
    sourceSettings: { name: "Work", color: "#ef4444", enabled: true },
    sourceIdentityStamp: "c".repeat(64),
    identityChanged: false,
    destinationSettings: null,
    baseline: null,
  };
}

let retryAnswer:
  | ((
      request: RequestOfMethod<HostRpcRegistry, "providers.profileCopy.retry">,
    ) => ResponseOfMethod<HostRpcRegistry, "providers.profileCopy.retry">)
  | null = null;

let resolveAnswer:
  | ((
      request: RequestOfMethod<
        HostRpcRegistry,
        "providers.profileCopy.sync.resolve"
      >,
    ) => ProfileSyncBatch)
  | null = null;

// Overrides for the rule answers; reset by the describe that uses them.
let saveAnswer: ((request: ProfileSyncSaveRule) => ProfileSyncRule) | null =
  null;
let stopAnswer:
  | ((
      request: RequestOfMethod<
        HostRpcRegistry,
        "providers.profileCopy.sync.stopRule"
      >,
    ) => ProfileSyncList)
  | null = null;

// What sync.list answers; a test moves it to model a foreign or later list.
let listAnswer: ProfileSyncList = { batches: [], rules: [] };

function setup(): {
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = createAppQueryClient();
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-sync-hook",
    handlers: {
      "providers.profileCopy.sync.list": () => listAnswer,
      "providers.profileCopy.sync.start": () => BATCH,
      // Positive answers echo the request's identity, as a host would.
      "providers.profileCopy.sync.saveRule": (params) =>
        saveAnswer?.(params) ?? {
          ...RULE,
          ruleId: params.ruleId,
          sourceHostId: params.sourceHostId,
          destinationHostId: params.destinationHostId,
          scope: params.scope,
          paused: params.paused,
          revision: params.expectedRevision + 1,
        },
      "providers.profileCopy.retry": (params) =>
        retryAnswer?.(params) ?? {
          result: "current" as const,
          outcome: profileCopyOutcome({ attempt: params.attempt }),
        },
      "providers.profileCopy.sync.stopRule": (params) =>
        stopAnswer?.(params) ?? { batches: [], rules: [] },
      // The authoritative answer names the operation that was asked about.
      "providers.profileCopy.sync.resolve": (params) =>
        resolveAnswer?.(params) ?? {
          ...BATCH,
          batchId: params.batchId,
          items: [resolvedItem(params.operationId)],
        },
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

function uuid(): string {
  return "77777777-7777-4777-8777-777777777777";
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
    const request: ProfileSyncResolveVariables = {
      sourceHostId: SOURCE,
      batchId: BATCH_ID,
      operationId: OPERATION_ID,
      action: "check",
      expectedDestination: null,
      // The transfer the caller means; local only, never sent.
      providerId: "claude",
      sourceProfileId: RESOLVED_PROFILE,
      destinationHostId: DEST,
    };
    act(() => result.current.mutate(request));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const calls = callsOf(messenger, "providers.profileCopy.sync.resolve");
    expect(calls).toHaveLength(1);
    // Only the wire fields reach the host.
    expect(calls[0]?.params).toEqual({
      sourceHostId: SOURCE,
      batchId: BATCH_ID,
      operationId: OPERATION_ID,
      action: "check",
      expectedDestination: null,
    });
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

describe("useProfileSyncList source validation", () => {
  const FOREIGN = "other-host";
  const local = (): ProfileSyncList => ({ batches: [BATCH], rules: [RULE] });

  beforeEach(() => {
    harness.spine = null;
    listAnswer = { batches: [], rules: [] };
  });
  afterEach(() => {
    cleanup();
    harness.spine = null;
  });

  it.each([
    ["a local list", local()],
    ["an empty list", { batches: [], rules: [] }],
  ])("accepts %s", async (_label, answer) => {
    listAnswer = answer;
    const { wrapper } = setup();
    const { result } = renderHook(() => useProfileSyncList(SOURCE), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(answer);
  });

  it.each([
    [
      "a batch from another source",
      { batches: [{ ...BATCH, sourceHostId: FOREIGN }], rules: [] },
    ],
    [
      "a rule from another source",
      { batches: [], rules: [{ ...RULE, sourceHostId: FOREIGN }] },
    ],
    [
      "a mixed list with one foreign rule",
      {
        batches: [BATCH],
        rules: [
          RULE,
          {
            ...RULE,
            ruleId: uuid(),
            sourceHostId: FOREIGN,
            destinationHostId: "dest-host-2",
          },
        ],
      },
    ],
  ] as const)(
    "errors on %s and keeps the last valid cached list instead of poisoning it",
    async (_label, foreign) => {
      listAnswer = local();
      const { wrapper } = setup();
      const { result } = renderHook(() => useProfileSyncList(SOURCE), {
        wrapper,
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(local());
      listAnswer = { batches: [...foreign.batches], rules: [...foreign.rules] };
      // The foreign list is wire-valid: only the source check can refuse it.
      expect(profileSyncListSchema.safeParse(listAnswer).success).toBe(true);
      await act(async () => {
        await result.current.refetch();
      });
      await waitFor(() => expect(result.current.isError).toBe(true));
      // The cached Rules and editor source stay the last valid local list.
      expect(result.current.data).toEqual(local());
      // A later valid answer recovers.
      listAnswer = { batches: [], rules: [] };
      await act(async () => {
        await result.current.refetch();
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual({ batches: [], rules: [] });
    },
  );
});

describe("rule answers are correlated with their request", () => {
  const FOREIGN = "other-host";
  const saveRequest = {
    sourceHostId: SOURCE,
    ruleId: RULE_ID,
    destinationHostId: DEST,
    scope: { kind: "all" as const },
    paused: false,
    expectedRevision: 0,
  };
  const stopRequest = {
    sourceHostId: SOURCE,
    ruleId: RULE_ID,
    expectedRevision: 1,
  };

  beforeEach(() => {
    harness.spine = null;
    saveAnswer = null;
    stopAnswer = null;
  });
  afterEach(() => {
    cleanup();
    harness.spine = null;
    saveAnswer = null;
    stopAnswer = null;
  });

  it.each([
    ["another source's rule", { ...RULE, sourceHostId: FOREIGN }],
    [
      "another rule id",
      { ...RULE, ruleId: "99999999-9999-4999-8999-999999999999" },
    ],
    ["another destination", { ...RULE, destinationHostId: "dest-host-2" }],
  ])("rejects a saveRule answer naming %s", async (_label, answer) => {
    // Wire-valid: only the correlation can refuse it.
    expect(profileSyncRuleSchema.safeParse(answer).success).toBe(true);
    saveAnswer = () => answer;
    const { wrapper } = setup();
    const { result } = renderHook(() => useProfileSyncSaveRule(SOURCE), {
      wrapper,
    });
    const onSuccess = vi.fn();
    act(() => result.current.mutate(saveRequest, { onSuccess }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("accepts a saveRule answer that echoes the request", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useProfileSyncSaveRule(SOURCE), {
      wrapper,
    });
    const onSuccess = vi.fn();
    act(() => result.current.mutate(saveRequest, { onSuccess }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "still containing the stopped rule",
      { batches: [], rules: [RULE] } satisfies ProfileSyncList,
    ],
    [
      "naming another source's rule",
      {
        batches: [],
        rules: [
          {
            ...RULE,
            ruleId: "99999999-9999-4999-8999-999999999999",
            sourceHostId: FOREIGN,
          },
        ],
      } satisfies ProfileSyncList,
    ],
  ])("rejects a stopRule answer %s", async (_label, answer) => {
    expect(profileSyncListSchema.safeParse(answer).success).toBe(true);
    stopAnswer = () => answer;
    const { wrapper } = setup();
    const { result } = renderHook(() => useProfileSyncStopRule(SOURCE), {
      wrapper,
    });
    const onSuccess = vi.fn();
    act(() => result.current.mutate(stopRequest, { onSuccess }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("saveRule answers bind scope, paused flag and an advancing revision", () => {
  const request = {
    sourceHostId: SOURCE,
    ruleId: RULE_ID,
    destinationHostId: DEST,
    scope: {
      kind: "selected" as const,
      providers: ["codex" as const, "claude" as const],
    },
    paused: false,
    expectedRevision: 3,
  };
  const echo = (): ProfileSyncRule => ({
    ...RULE,
    scope: { kind: "selected", providers: ["claude", "codex"] },
    paused: false,
    revision: 4,
  });

  beforeEach(() => {
    harness.spine = null;
    saveAnswer = null;
  });
  afterEach(() => {
    cleanup();
    harness.spine = null;
    saveAnswer = null;
  });

  it("accepts a canonically reordered provider list at the next revision", async () => {
    saveAnswer = echo;
    expect(profileSyncRuleSchema.safeParse(echo()).success).toBe(true);
    const { wrapper } = setup();
    const { result } = renderHook(() => useProfileSyncSaveRule(SOURCE), {
      wrapper,
    });
    const onSuccess = vi.fn();
    act(() => result.current.mutate(request, { onSuccess }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a changed scope",
      (): ProfileSyncRule => ({
        ...echo(),
        scope: { kind: "selected", providers: ["claude"] },
      }),
    ],
    [
      "a different scope kind",
      (): ProfileSyncRule => ({ ...echo(), scope: { kind: "all" } }),
    ],
    [
      "a changed paused flag",
      (): ProfileSyncRule => ({ ...echo(), paused: true }),
    ],
    [
      "a revision that did not advance",
      (): ProfileSyncRule => ({ ...echo(), revision: 3 }),
    ],
    [
      "a revision that went backwards",
      (): ProfileSyncRule => ({ ...echo(), revision: 2 }),
    ],
  ])("rejects an answer with %s", async (_label, answer) => {
    // Wire-valid: only the correlation can refuse it.
    expect(profileSyncRuleSchema.safeParse(answer()).success).toBe(true);
    saveAnswer = answer;
    const { wrapper } = setup();
    const { result } = renderHook(() => useProfileSyncSaveRule(SOURCE), {
      wrapper,
    });
    const onSuccess = vi.fn();
    act(() => result.current.mutate(request, { onSuccess }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("retry answers are correlated with their request", () => {
  beforeEach(() => {
    harness.spine = null;
    retryAnswer = null;
  });
  afterEach(() => {
    cleanup();
    harness.spine = null;
    retryAnswer = null;
  });

  const attempt = (): ProfileCopyAttempt =>
    profileCopyAttempt({ sourceHostId: SOURCE });
  const answerWith = (
    overrides: Partial<ProfileCopyAttempt>,
  ): ResponseOfMethod<HostRpcRegistry, "providers.profileCopy.retry"> => ({
    result: "current",
    outcome: profileCopyOutcome({
      attempt: { ...attempt(), ...overrides },
    }),
  });

  it.each([
    [
      "another operation",
      { operationId: "00000000-0000-4000-8000-0000000000cc" },
    ],
    ["another source", { sourceHostId: "other-source-host" }],
    ["another provider", { providerId: "codex" as const }],
    [
      "another source profile",
      { sourceProfileId: "00000000-0000-4000-8000-0000000000dd" },
    ],
    ["another destination", { destinationHostId: "dest-host-2" }],
  ])("rejects an answer for %s", async (_label, overrides) => {
    retryAnswer = () => answerWith(overrides);
    const { wrapper } = setup();
    const { result } = renderHook(
      () => useProfileCopyRetryMutation(SOURCE, COPY_OPERATION_ID),
      { wrapper },
    );
    const onSuccess = vi.fn();
    act(() =>
      result.current.mutate(
        {
          attempt: attempt(),
          expectedRevision: 1,
          retryRequestId: RETRY_REQUEST_ID,
        },
        { onSuccess },
      ),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("accepts a replacement attempt of the same transfer", async () => {
    retryAnswer = () =>
      answerWith({ attemptId: "55555555-5555-4555-8555-555555555556" });
    const { wrapper } = setup();
    const { result } = renderHook(
      () => useProfileCopyRetryMutation(SOURCE, COPY_OPERATION_ID),
      { wrapper },
    );
    const onSuccess = vi.fn();
    act(() =>
      result.current.mutate(
        {
          attempt: attempt(),
          expectedRevision: 1,
          retryRequestId: RETRY_REQUEST_ID,
        },
        { onSuccess },
      ),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("resolve answers are correlated with the intended transfer", () => {
  const request: ProfileSyncResolveVariables = {
    sourceHostId: SOURCE,
    batchId: BATCH_ID,
    operationId: OPERATION_ID,
    action: "check",
    expectedDestination: null,
    providerId: "claude",
    sourceProfileId: RESOLVED_PROFILE,
    destinationHostId: DEST,
  };
  const answerWith = (
    overrides: Partial<ProfileSyncItem>,
  ): ProfileSyncBatch => ({
    ...BATCH,
    items: [{ ...resolvedItem(OPERATION_ID), ...overrides }],
  });

  beforeEach(() => {
    harness.spine = null;
    resolveAnswer = null;
  });
  afterEach(() => {
    cleanup();
    harness.spine = null;
    resolveAnswer = null;
  });

  it.each([
    ["another provider", { providerId: "codex" as const }],
    [
      "another source profile",
      { sourceProfileId: "99999999-9999-4999-8999-999999999990" },
    ],
    ["another destination", { destinationHostId: "dest-host-2" }],
  ])(
    "rejects an answer for the same operation under %s",
    async (_label, overrides) => {
      const answer = answerWith(overrides);
      // Wire-valid: only the correlation can refuse it.
      expect(profileSyncBatchSchema.safeParse(answer).success).toBe(true);
      resolveAnswer = () => answer;
      const { wrapper } = setup();
      const { result } = renderHook(() => useProfileSyncResolve(SOURCE), {
        wrapper,
      });
      const onSuccess = vi.fn();
      act(() => result.current.mutate(request, { onSuccess }));
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(onSuccess).not.toHaveBeenCalled();
    },
  );

  it("accepts the exact transfer", async () => {
    resolveAnswer = () => answerWith({});
    const { wrapper } = setup();
    const { result } = renderHook(() => useProfileSyncResolve(SOURCE), {
      wrapper,
    });
    const onSuccess = vi.fn();
    act(() => result.current.mutate(request, { onSuccess }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
