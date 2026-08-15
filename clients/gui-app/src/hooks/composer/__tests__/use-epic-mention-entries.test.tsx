import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  EpicMentionEpicSuggestion,
  EpicMentionEpicsResponse,
  EpicMentionSpecsResponse,
} from "@traycer/protocol/host/index";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useEpicMentionEntries } from "../use-epic-mention-entries";

/**
 * `useEpicMentionEntries` now takes its host `client` explicitly (S11: it no
 * longer resolves `useHostBinding()` internally) - a composer bound to a
 * non-default host must list THAT host's epics/specs, never the app-wide
 * default's. `HostClient` has private fields, so it can't be duck-typed; each
 * fixture builds a real instance over a `MockHostMessenger`, mirroring the
 * pattern in `use-gui-harness-catalog.test.tsx` / the picker's intent-RPC
 * suite. Method handlers delegate to per-fixture `vi.fn()`s so tests keep the
 * familiar `mockResolvedValueOnce` shape while assertions can tell exactly
 * WHICH fixture's transport a request reached (not just what came back).
 */

function epicSuggestion(id: string): EpicMentionEpicSuggestion {
  return {
    kind: "epic",
    id: `epic:${id}`,
    token: `epic:${id}`,
    epicId: id,
    label: "Login flow",
    description: "1 spec",
    status: "active",
    updatedAt: 123,
  };
}

function specSuggestion(
  id: string,
): EpicMentionSpecsResponse["entries"][number] {
  return {
    kind: "epic-artifact",
    id: `spec:${id}`,
    token: `spec:${id}`,
    epicId: id,
    epicTitle: "Login flow",
    artifactId: `artifact-${id}`,
    artifactType: "spec",
    label: "Login spec",
    description: "1 spec",
    status: null,
    updatedAt: 123,
  };
}

interface MentionFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly mentionEpics: Mock<
    (params: unknown) => Promise<EpicMentionEpicsResponse>
  >;
  readonly mentionSpecs: Mock<
    (params: unknown) => Promise<EpicMentionSpecsResponse>
  >;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function buildMentionFixture(hostId: string): MentionFixture {
  const queryClient = createAppQueryClient();
  const mentionEpics = vi.fn<
    (params: unknown) => Promise<EpicMentionEpicsResponse>
  >(() => Promise.resolve({ entries: [] }));
  const mentionSpecs = vi.fn<
    (params: unknown) => Promise<EpicMentionSpecsResponse>
  >(() => Promise.resolve({ entries: [] }));
  let requestCounter = 0;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestCounter += 1;
        return `req-${hostId}-${String(requestCounter)}`;
      },
      handlers: {
        "epic.mentionEpics": (params) => mentionEpics(params),
        "epic.mentionSpecs": (params) => mentionSpecs(params),
      },
    }),
  });
  client.bind({
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    transportDialability: "dialable",
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { client, mentionEpics, mentionSpecs, Wrapper };
}

describe("useEpicMentionEntries", () => {
  afterEach(() => {
    cleanup();
  });

  it("requests host-backed epic mention suggestions through the passed client", async () => {
    const fixture = buildMentionFixture("host-1");
    fixture.mentionEpics.mockResolvedValueOnce({
      entries: [epicSuggestion("epic-1")],
    });

    const { result } = renderHook(
      () =>
        useEpicMentionEntries({
          requests: [
            {
              method: "epic.mentionEpics",
              params: { query: "login", limit: 8 },
            },
          ],
          client: fixture.client,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(fixture.mentionEpics).toHaveBeenCalledWith({
      query: "login",
      limit: 8,
    });
  });

  it("does not request suggestions without request descriptors", () => {
    const fixture = buildMentionFixture("host-1");

    renderHook(
      () =>
        useEpicMentionEntries({
          requests: [],
          client: fixture.client,
        }),
      { wrapper: fixture.Wrapper },
    );

    expect(fixture.mentionEpics).not.toHaveBeenCalled();
    expect(fixture.mentionSpecs).not.toHaveBeenCalled();
  });

  it("exposes a refetch that re-issues every epic.mention* query and returns a Promise", async () => {
    // Regression for the Artifacts refresh no-op: the top-bar button used to
    // call setStep(current), which the picker store early-returns from. The
    // button now awaits this refetch, so it must actually hit the host again.
    const fixture = buildMentionFixture("host-1");
    fixture.mentionEpics.mockResolvedValue({
      entries: [epicSuggestion("epic-1")],
    });
    fixture.mentionSpecs.mockResolvedValue({
      entries: [specSuggestion("epic-1")],
    });

    const { result } = renderHook(
      () =>
        useEpicMentionEntries({
          requests: [
            {
              method: "epic.mentionEpics",
              params: { query: "login", limit: 8 },
            },
            {
              method: "epic.mentionSpecs",
              params: { query: "login", limit: 8 },
            },
          ],
          client: fixture.client,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => expect(result.current.data.length).toBeGreaterThan(0));
    expect(fixture.mentionEpics).toHaveBeenCalledTimes(1);
    expect(fixture.mentionSpecs).toHaveBeenCalledTimes(1);

    const pending = result.current.refetch();
    expect(pending).toBeInstanceOf(Promise);
    await pending;

    // Both underlying queries must be re-issued.
    await waitFor(() => {
      expect(fixture.mentionEpics).toHaveBeenCalledTimes(2);
      expect(fixture.mentionSpecs).toHaveBeenCalledTimes(2);
    });
  });

  // Coverage for the new required `client` param (S11): the composer's host
  // is the ONE the request actually reaches - not a sibling host, and not the
  // app-wide default - and a `null` client (the composer's host not resolved
  // yet) issues nothing at all rather than silently falling back.
  it("issues requests through the passed client, never a different host's transport", async () => {
    const fixtureA = buildMentionFixture("host-a");
    const fixtureB = buildMentionFixture("host-b");
    fixtureA.mentionEpics.mockResolvedValue({
      entries: [epicSuggestion("epic-a")],
    });
    fixtureB.mentionEpics.mockResolvedValue({
      entries: [epicSuggestion("epic-b")],
    });

    const { result } = renderHook(
      () =>
        useEpicMentionEntries({
          requests: [
            {
              method: "epic.mentionEpics",
              params: { query: "login", limit: 8 },
            },
          ],
          client: fixtureB.client,
        }),
      { wrapper: fixtureB.Wrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data).toEqual([epicSuggestion("epic-b")]);
    expect(fixtureB.mentionEpics).toHaveBeenCalledTimes(1);
    // Host A's transport was never even reached - not a data-shape
    // coincidence, the request never left for it.
    expect(fixtureA.mentionEpics).not.toHaveBeenCalled();
  });

  it("client: null issues no request and returns empty data", async () => {
    const fixture = buildMentionFixture("host-a");

    const { result } = renderHook(
      () =>
        useEpicMentionEntries({
          requests: [
            {
              method: "epic.mentionEpics",
              params: { query: "login", limit: 8 },
            },
          ],
          client: null,
        }),
      { wrapper: fixture.Wrapper },
    );

    // Give any (incorrect) fallback fetch a chance to have fired.
    await Promise.resolve();
    expect(fixture.mentionEpics).not.toHaveBeenCalled();
    expect(result.current.data).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });
});
