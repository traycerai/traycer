import { beforeEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { SnapshotsReadSnapshotDiffRequest } from "@traycer/protocol/host/snapshot-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useSnapshotDiffQuery } from "../use-snapshot-diff-query";

/**
 * D15. Snapshot blobs are content-addressed and physically local: only the host
 * that wrote them holds them. This hook used to read `useHostClient()`, so a
 * chat/diff tile bound to host A asked whichever machine the app was pointed at
 * for A's blobs - which answers `blob_missing` for content that exists, and
 * caches that miss under the wrong host's key.
 *
 * Real clients over mock messengers, not chained `as unknown as` assertions -
 * the repo's lint forbids those in tests as much as in production.
 */

let queryClient: QueryClient;

interface ClientFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly requests: SnapshotsReadSnapshotDiffRequest[];
}

function buildClient(args: {
  readonly entry: HostDirectoryEntry;
  readonly beforeContent: string;
}): ClientFixture {
  const requests: SnapshotsReadSnapshotDiffRequest[] = [];
  let requestCount = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === args.entry.hostId ? args.entry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () =>
        `req-${args.entry.hostId}-${String((requestCount += 1))}`,
      handlers: {
        "snapshots.readSnapshotDiff": (request) => {
          requests.push(request);
          return {
            beforeContent: args.beforeContent,
            afterContent: "after",
            reason: "snapshot" as const,
          };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return { client: spine.createRequester(args.entry), requests };
}

let tile: ClientFixture;
let appWide: ClientFixture;

beforeEach(() => {
  queryClient = createAppQueryClient();
  tile = buildClient({
    entry: mockLocalHostEntry,
    beforeContent: "the tile host's bytes",
  });
  appWide = buildClient({
    entry: mockRemoteHostEntry,
    beforeContent: "the app-wide host's bytes",
  });
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useSnapshotDiffQuery host scope", () => {
  it("reads the blobs on the PASSED client and keys the cache under ITS host", async () => {
    const { result } = renderHook(
      () =>
        useSnapshotDiffQuery({
          client: tile.client,
          beforeHash: "hash-before",
          afterHash: "hash-after",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The tile's host answered...
    expect(result.current.data?.beforeContent).toBe("the tile host's bytes");
    expect(tile.requests).toEqual([
      { beforeHash: "hash-before", afterHash: "hash-after" },
    ]);
    // ...and the app-wide one - live, and one argument away from being asked -
    // did not. Asserting the miss as well as the hit is what makes this arm
    // fail when the read goes ambient again, not merely when it breaks.
    expect(appWide.requests).toEqual([]);
    expect(appWide.client.getActiveHostId()).toBe(mockRemoteHostEntry.hostId);

    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(mockLocalHostEntry.hostId);
    expect(keys[0]).not.toContain(mockRemoteHostEntry.hostId);
  });

  it("stays disabled with no client rather than falling back to another host", async () => {
    const { result } = renderHook(
      () =>
        useSnapshotDiffQuery({
          client: null,
          beforeHash: "hash-before",
          afterHash: "hash-after",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));

    expect(tile.requests).toEqual([]);
    expect(appWide.requests).toEqual([]);
  });
});
