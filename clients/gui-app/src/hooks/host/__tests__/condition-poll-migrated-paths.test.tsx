import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  focusManager,
  QueryClientProvider,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  NOTIFICATION_INDICATOR_ERROR_POLL_LANE,
  ONBOARDING_DRAFT_PROVIDERS_UNSETTLED_POLL_LANE,
  SPEECH_MODEL_DOWNLOADING_POLL_LANE,
} from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import { useAgentSelectionGuideGlobalOnboardingDraftQuery } from "@/hooks/agent/use-agent-selection-guide-global-onboarding-draft-query";
import { useHostQuery } from "@/hooks/host/use-host-query";

const hostClientMock = vi.hoisted(() => ({
  current: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => hostClientMock.current,
  };
});

function queryForMethod(queryClient: QueryClient, method: string): Query {
  const query = queryClient
    .getQueryCache()
    .getAll()
    .find((entry) => entry.queryKey.includes(method));
  if (query === undefined) {
    throw new Error(`Expected query for ${method}`);
  }
  return query;
}

function appliedDelay(query: Query): number | false | undefined {
  const interval = refetchIntervalFor(query);
  if (!isRefetchInterval(interval)) {
    return typeof interval === "number" || interval === false
      ? interval
      : undefined;
  }
  return interval(query);
}

function refetchIntervalFor(query: Query): unknown {
  const { options } = query;
  return "refetchInterval" in options ? options.refetchInterval : undefined;
}

function isRefetchInterval(
  value: unknown,
): value is (query: Query) => number | false | undefined {
  return typeof value === "function";
}

function createPathFixture(handlers: {
  readonly "agent.selectionGuide.getGlobalOnboardingDraft"?: () => unknown;
  readonly "speech.getModelStatus"?: () => unknown;
  readonly "host.notifications.indicatorState"?: () => unknown;
}) {
  const queryClient = createAppQueryClient();
  let requestSeq = 0;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestSeq += 1;
        return `req-${String(requestSeq)}`;
      },
      handlers: handlers as never,
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  hostClientMock.current = client;
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { client, queryClient, Wrapper };
}

describe("migrated condition paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    hostClientMock.current = null;
    cleanup();
    vi.useRealTimers();
  });

  it("onboarding draft polls the unsettled providers lane on the real timer", async () => {
    vi.setSystemTime(0);
    const fetchTimes: number[] = [];
    const fixture = createPathFixture({
      "agent.selectionGuide.getGlobalOnboardingDraft": () => {
        fetchTimes.push(Date.now());
        return {
          content: null,
          generatedDefaultContent: "default",
          providersSettled: false,
        };
      },
    });

    renderHook(() => useAgentSelectionGuideGlobalOnboardingDraftQuery(), {
      wrapper: fixture.Wrapper,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const query = queryForMethod(
      fixture.queryClient,
      "agent.selectionGuide.getGlobalOnboardingDraft",
    );
    const branded = getConditionPollEpisodeCoordinator(
      fixture.queryClient,
    ).refetchIntervalFor("agent.selectionGuide.getGlobalOnboardingDraft");
    expect(query.options.meta).toMatchObject({
      hostRpcMethod: "agent.selectionGuide.getGlobalOnboardingDraft",
    });
    expect(query.options.retry).toBe(false);
    expect(refetchIntervalFor(query)).toBe(branded);
    expect(appliedDelay(query)).toBe(
      ONBOARDING_DRAFT_PROVIDERS_UNSETTLED_POLL_LANE.initialDelayMs,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    const deltas = fetchTimes
      .slice(1)
      .map((time, index) => time - fetchTimes[index]);
    expect(deltas).toEqual([750, 1_500, 3_000]);
  });

  it("speech model status polls while downloading and stops when ready", async () => {
    let downloading = true;
    const fixture = createPathFixture({
      "speech.getModelStatus": () => ({
        modelId: "default",
        installed: !downloading,
        downloadState: downloading ? "downloading" : "ready",
        downloadProgress: downloading ? 0.4 : null,
        sizeBytes: null,
        errorMessage: null,
        engineAvailable: true,
      }),
    });

    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "speech.getModelStatus",
          params: { modelId: null },
          options: null,
        }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const query = queryForMethod(fixture.queryClient, "speech.getModelStatus");
    expect(appliedDelay(query)).toBe(
      SPEECH_MODEL_DOWNLOADING_POLL_LANE.initialDelayMs,
    );

    downloading = false;
    await act(async () => {
      await query.fetch();
    });
    expect(appliedDelay(query)).toBe(false);
  });

  it("notification indicator error recovery uses the 30s error lane", async () => {
    const fixture = createPathFixture({
      "host.notifications.indicatorState": () => {
        throw new Error("indicator unavailable");
      },
    });

    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "host.notifications.indicatorState",
          params: { epicIds: ["epic-a"], chatIds: [] },
          options: null,
        }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const query = queryForMethod(
      fixture.queryClient,
      "host.notifications.indicatorState",
    );
    expect(query.options.meta).toMatchObject({
      hostRpcMethod: "host.notifications.indicatorState",
    });
    expect(query.options.retry).toBe(false);
    expect(appliedDelay(query)).toBe(
      NOTIFICATION_INDICATOR_ERROR_POLL_LANE.initialDelayMs,
    );
  });
});
