import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  DEFAULT_PUBLISH,
  FIRST_COHORT,
  IDENTITY,
  SECOND_COHORT,
  publishCloudChat,
  servingBehaviour,
  type PortBehaviour,
} from "@traycer-clients/shared/cloud-chat/__tests__/__fixtures__/published-cloud-chat";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudChatRead } from "@/hooks/chats/use-cloud-chat-queries";
import {
  browserChatPartCacheStorage,
  clearChatPartCache,
} from "@/lib/chats/cloud-chat-part-cache";

/**
 * `useCloudChatRead`'s HEAD-KEYED refresh, exercised through the real hook
 * over a real `HostClient`/`MockHostMessenger` pair - the sibling to
 * `cloud-chat-payload-list-healing.test.tsx`, which pins the same class of
 * fact (a heal is visible as a REQUEST COUNT, never inferred from what
 * rendered) for the payload-list half of this surface.
 *
 * The hook's own doc comment states the contract this file pins: the query
 * key carries `recordHeadSha256`, so a new publication is a new key and the
 * mounted observer re-resolves - fetching only the parts its content-addressed
 * cache (`activeChatPartCache()`) does not already hold - while an unchanged
 * digest across a rerender must not cost a second request either way.
 *
 * Note on provenance: the ticket that motivated this suite named a sibling
 * file `cloud-chat-dialog-reopen.test.tsx`. No such file exists anywhere in
 * this tree at the time of writing - the closest surfaces are
 * `use-cloud-chat-transcript.ts` and the tile's own
 * `published-chat-tile.test.tsx` - so this file is written as the missing
 * unit-level sibling for the read hook itself, modeled on the payload-list
 * healing fixture (for the `HostClient`/query-client harness) and on
 * `cloud-chat-transcript-state.test.ts` (for the published-chat fixtures).
 */

type Fixture = {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  /** Every `epic.resolveCloudChatHead` that reached the messenger. */
  readonly headRequests: { value: number };
  /** Every `epic.readCloudChatPart` that reached the messenger. */
  readonly partRequests: { value: number };
  /** Swapped between publications so a republish changes what the host serves. */
  readonly behaviour: { current: PortBehaviour };
};

function createFixture(initial: PortBehaviour): Fixture {
  const headRequests = { value: 0 };
  const partRequests = { value: 0 };
  const behaviour: { current: PortBehaviour } = { current: initial };
  const queryClient = createAppQueryClient();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () =>
        `req-head-keyed-${String(headRequests.value + partRequests.value)}`,
      handlers: {
        "epic.resolveCloudChatHead": () => {
          headRequests.value += 1;
          return Promise.resolve(behaviour.current.resolve());
        },
        "epic.readCloudChatPart": (params) => {
          partRequests.value += 1;
          return Promise.resolve(behaviour.current.part(params.sha256));
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
  return {
    client,
    queryClient,
    Wrapper,
    headRequests,
    partRequests,
    behaviour,
  };
}

describe("useCloudChatRead - head-keyed refresh", () => {
  beforeEach(() => {
    useAuthStore.setState({
      contextMetadata: { userId: "viewer-1", username: "viewer-1" },
    });
  });
  afterEach(async () => {
    cleanup();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    // The part cache is a module singleton keyed purely by content digest, so
    // a stale entry from one test would silently change another test's
    // request count. Cleared both sides of every test for that reason.
    await clearChatPartCache(browserChatPartCacheStorage());
  });

  it("re-resolves on a head EDGE, fetching only the tail shard a republish adds - the unchanged cohort's shard is served from the part cache", async () => {
    const v1 = await publishCloudChat({
      ...DEFAULT_PUBLISH,
      cohorts: [FIRST_COHORT],
    });
    const fixture = createFixture(servingBehaviour(v1));

    const rendered = renderHook(
      (props: { readonly recordHeadSha256: string | null }) =>
        useCloudChatRead({
          client: fixture.client,
          identity: IDENTITY,
          enabled: true,
          recordHeadSha256: props.recordHeadSha256,
        }),
      {
        wrapper: fixture.Wrapper,
        initialProps: { recordHeadSha256: v1.headSha256 },
      },
    );

    await waitFor(() => {
      expect(rendered.result.current.data?.outcome.kind).toBe("ok");
    });
    expect(fixture.headRequests.value).toBe(1);
    expect(fixture.partRequests.value).toBe(1);
    const firstOutcome = rendered.result.current.data?.outcome;
    if (firstOutcome === undefined || firstOutcome.kind !== "ok") {
      throw new Error("expected an ok outcome after the first read");
    }
    expect(firstOutcome.chat.messages).toHaveLength(FIRST_COHORT.length);

    // A republish that appends a second cohort - a new tail shard, and the
    // record row's head now names it.
    const v2 = await publishCloudChat({
      ...DEFAULT_PUBLISH,
      cohorts: [FIRST_COHORT, SECOND_COHORT],
    });
    fixture.behaviour.current = servingBehaviour(v2);
    rendered.rerender({ recordHeadSha256: v2.headSha256 });

    await waitFor(() => {
      expect(rendered.result.current.data?.chat?.headSha256).toBe(
        v2.headSha256,
      );
    });
    expect(fixture.headRequests.value).toBe(2);
    // Only ONE more part request across the whole read: the first cohort's
    // shard bytes are unchanged, so its digest is unchanged, and the reader's
    // cache serves it without asking the host again.
    expect(fixture.partRequests.value).toBe(2);
    const secondOutcome = rendered.result.current.data?.outcome;
    if (secondOutcome === undefined || secondOutcome.kind !== "ok") {
      throw new Error("expected an ok outcome after the second read");
    }
    expect(secondOutcome.chat.messages).toHaveLength(
      FIRST_COHORT.length + SECOND_COHORT.length,
    );

    // The same digest again is not an edge - a rerender must cost nothing.
    rendered.rerender({ recordHeadSha256: v2.headSha256 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.headRequests.value).toBe(2);
    expect(fixture.partRequests.value).toBe(2);
  });

  it("with `recordHeadSha256: null`, reads once and a repeated null rerender makes no further request", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const fixture = createFixture(servingBehaviour(published));

    const rendered = renderHook(
      (props: { readonly recordHeadSha256: string | null }) =>
        useCloudChatRead({
          client: fixture.client,
          identity: IDENTITY,
          enabled: true,
          recordHeadSha256: props.recordHeadSha256,
        }),
      {
        wrapper: fixture.Wrapper,
        initialProps: { recordHeadSha256: null },
      },
    );

    await waitFor(() => {
      expect(rendered.result.current.data?.outcome.kind).toBe("ok");
    });
    expect(fixture.headRequests.value).toBe(1);

    rendered.rerender({ recordHeadSha256: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.headRequests.value).toBe(1);
  });
});
