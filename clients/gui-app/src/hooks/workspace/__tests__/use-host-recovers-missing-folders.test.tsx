import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import type { NegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";

const negotiated = vi.hoisted((): { version: NegotiatedMethodVersion } => ({
  version: null,
}));

// The negotiated version is the one per-host fact the hook cannot synthesize;
// the read itself runs for real against the mock messenger.
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => negotiated.version,
}));

import { useHostRecoversMissingFolders } from "../use-host-recovers-missing-folders";

interface Fixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly reads: () => number;
  /** Queries in flight. A disabled read never starts one, so 0 right after
   * the mount is the whole answer, with nothing to wait for. */
  readonly fetching: () => number;
  readonly refetch: () => Promise<void>;
}

function createFixture(recoverMissing: boolean): Fixture {
  return createFixtureAnswering(() => ({
    agentCreate: "allow",
    recoverMissing,
  }));
}

function createFixtureAnswering(
  answer: () => {
    readonly agentCreate: "allow";
    readonly recoverMissing: boolean;
  },
): Fixture {
  const queryClient = createAppQueryClient();
  let reads = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${String(reads)}`,
      handlers: {
        "config.worktrees.get": () => {
          reads += 1;
          return answer();
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    client: spine.createRequester(mockLocalHostEntry),
    Wrapper,
    reads: () => reads,
    fetching: () => queryClient.isFetching(),
    refetch: async () => {
      await queryClient.refetchQueries();
    },
  };
}

function mount(
  fixture: Fixture,
  enabled: boolean,
): { readonly current: boolean } {
  return renderHook(
    () => useHostRecoversMissingFolders(fixture.client, enabled),
    { wrapper: fixture.Wrapper },
  ).result;
}

beforeEach(() => {
  negotiated.version = null;
});

afterEach(() => {
  cleanup();
});

describe("useHostRecoversMissingFolders", () => {
  it("is true once a 1.1 host answers recoverMissing true", async () => {
    negotiated.version = { major: 1, minor: 1 };
    const result = mount(createFixture(true), true);
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  // A failed refetch keeps the last answer's data in the cache; the block must
  // come back rather than stay lifted on a read that has since failed.
  it("is false again once a refetch fails after a true answer", async () => {
    negotiated.version = { major: 1, minor: 1 };
    let failing = false;
    const fixture = createFixtureAnswering(() => {
      if (failing) throw new Error("config unreadable");
      return { agentCreate: "allow", recoverMissing: true };
    });
    const result = mount(fixture, true);
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
    failing = true;
    await fixture.refetch();
    await waitFor(() => {
      expect(fixture.fetching()).toBe(0);
    });
    expect(result.current).toBe(false);
  });

  it("is false when a 1.1 host answers recoverMissing false", async () => {
    negotiated.version = { major: 1, minor: 1 };
    const fixture = createFixture(false);
    const result = mount(fixture, true);
    await waitFor(() => {
      expect(fixture.reads()).toBe(1);
    });
    await waitFor(() => {
      expect(fixture.fetching()).toBe(0);
    });
    expect(result.current).toBe(false);
  });

  it("is false and asks nothing of a host that negotiated only 1.0", () => {
    negotiated.version = { major: 1, minor: 0 };
    const fixture = createFixture(true);
    const result = mount(fixture, true);
    expect(result.current).toBe(false);
    expect(fixture.fetching()).toBe(0);
  });

  it("is false and asks nothing while the version is unknown", () => {
    negotiated.version = null;
    const fixture = createFixture(true);
    const result = mount(fixture, true);
    expect(result.current).toBe(false);
    expect(fixture.fetching()).toBe(0);
  });

  it("asks nothing when disabled", () => {
    negotiated.version = { major: 1, minor: 1 };
    const fixture = createFixture(true);
    const result = mount(fixture, false);
    expect(result.current).toBe(false);
    expect(fixture.fetching()).toBe(0);
  });
});
