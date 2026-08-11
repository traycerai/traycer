import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";

interface DirectoryListener {
  (): void;
}

const directoryRef = vi.hoisted(() => ({
  value: null as {
    list(): Promise<readonly HostDirectoryEntry[]>;
    onChange(listener: DirectoryListener): { dispose(): void };
  } | null,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () =>
    directoryRef.value === null ? null : { directory: directoryRef.value },
}));

import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";

/**
 * Fake directory whose `onChange` listeners the test fires by hand, standing
 * in for `HostDirectoryService`'s emit (local-host change or registry poll).
 */
function makeDirectory(entries: readonly HostDirectoryEntry[]) {
  const listeners = new Set<DirectoryListener>();
  let current = entries;
  const list = vi.fn(() => Promise.resolve(current));
  return {
    directory: {
      list,
      onChange: (listener: DirectoryListener) => {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
    },
    list,
    emit: (next: readonly HostDirectoryEntry[]) => {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper(props: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

afterEach(() => {
  cleanup();
  directoryRef.value = null;
});

describe("useHostDirectoryList", () => {
  it("keeps the previous entries visible across a directory emit instead of blanking to undefined", async () => {
    // REGRESSION: the directory revision used to be part of the query key, so
    // every emit minted a FRESH cache entry - `data: undefined` + fetching -
    // for every consumer at once. `useHostReachability` maps that to
    // "checking", which swapped each terminal tile for a loading skeleton and
    // unmounted its xterm subtree; the 15s registry poll made it a permanent
    // ~15s flicker across the host picker, workspace selector and tiles.
    const fake = makeDirectory([mockRemoteHostEntry]);
    directoryRef.value = fake.directory;
    const queryClient = makeQueryClient();

    const observed: Array<readonly HostDirectoryEntry[] | undefined> = [];
    const rendered = renderHook(
      () => {
        const query = useHostDirectoryList();
        observed.push(query.data);
        return query;
      },
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => {
      expect(rendered.result.current.data).toHaveLength(1);
    });
    const rendersBeforeEmit = observed.length;

    fake.emit([mockRemoteHostEntry, { ...mockRemoteHostEntry, hostId: "b" }]);

    await waitFor(() => {
      expect(rendered.result.current.data).toHaveLength(2);
    });

    // Every render from the emit onwards must still carry entries - no
    // undefined window, which is what the consumers rendered a loading state
    // (and the tiles an unmount) for.
    expect(observed.slice(rendersBeforeEmit)).not.toContain(undefined);
  });

  it("refetches through the SAME cache entry on a directory emit rather than accumulating keys", async () => {
    const fake = makeDirectory([mockRemoteHostEntry]);
    directoryRef.value = fake.directory;
    const queryClient = makeQueryClient();

    const rendered = renderHook(() => useHostDirectoryList(), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => {
      expect(rendered.result.current.data).toHaveLength(1);
    });
    expect(fake.list).toHaveBeenCalledTimes(1);

    fake.emit([{ ...mockRemoteHostEntry, label: "Renamed" }]);
    await waitFor(() => {
      // The emit must still REACH the consumer - a stable key that never
      // refetches would pass the no-undefined assertion above by serving a
      // stale list forever (the 2026-07-14 boot-empty-list incident).
      expect(rendered.result.current.data?.[0]?.label).toBe("Renamed");
    });
    expect(fake.list).toHaveBeenCalledTimes(2);

    fake.emit([{ ...mockRemoteHostEntry, label: "Renamed twice" }]);
    await waitFor(() => {
      expect(rendered.result.current.data?.[0]?.label).toBe("Renamed twice");
    });

    const hostPickerEntries = queryClient
      .getQueryCache()
      .getAll()
      .filter((entry) => entry.queryKey[0] === "host-picker");
    expect(hostPickerEntries).toHaveLength(1);
  });
});
