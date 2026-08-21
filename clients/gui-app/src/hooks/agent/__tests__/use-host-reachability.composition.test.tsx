/**
 * Composition coverage for `useHostReachability`: fed REAL entries from
 * `hostListItemToDirectoryEntry` — not synthetic `HostDirectoryEntry`
 * literals — through the REAL `useHostDirectoryList` + the mapper the
 * directory service actually uses. This is the layer the previous round's
 * unit tests (mapper alone, hook alone) never composed, which is exactly how
 * a `connectivity: "unknown"` host with an open E2E session shipped as
 * "unreachable" while both halves stayed green in isolation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  HostConnectivity,
  HostListItem,
} from "@traycer/protocol/host/host-status";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";

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

const readySessionHosts = vi.hoisted(() => ({ value: new Set<string>() }));

// The readiness cache is PUSH now (redesign P4.1): the hook under test
// subscribes via `subscribeRemoteSessionReadiness` instead of polling, so a
// test that only flips `readySessionHosts` and waits produces no event and
// the hook never re-renders. A test-local listener set stands in for the
// cache's own, and every place the old fake-timer tick used to drive a
// re-read now fires this instead.
const readinessListeners = vi.hoisted(() => ({
  value: new Set<() => void>(),
}));

vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return {
      ...actual,
      hasReadyRemoteSession: (hostId: string) =>
        readySessionHosts.value.has(hostId),
      subscribeRemoteSessionReadiness: (listener: () => void) => {
        readinessListeners.value.add(listener);
        return () => {
          readinessListeners.value.delete(listener);
        };
      },
    };
  },
);

function fireReadinessChanged(): void {
  for (const listener of [...readinessListeners.value]) {
    listener();
  }
}

import { useHostReachability } from "@/hooks/agent/use-host-reachability";

/**
 * The account axis the wire no longer carries: `hostListItemToDirectoryEntry`
 * stamps it onto every entry at projection time. These fixtures describe an
 * entitled account unless a case says otherwise.
 */
const PLAN_ALLOWS_REMOTE = true;
const PLAN_GATED = false;

const RELAY_BASE_URL = "wss://relay.example.test/attach";

function listItem(
  hostId: string,
  connectivity: HostConnectivity,
  lastSeenAt: string,
): HostListItem {
  return {
    hostId,
    displayName: `label-${hostId}`,
    platform: "Ubuntu",
    kind: "personal",
    publicKey: `pk-${hostId}`,
    createdAt: "2026-07-01T12:00:00.000Z",
    status: {
      connectivity,
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt,
    },
    updatePolicy: "manual",
  };
}

/**
 * A `lastSeenAt` far enough in the past that an `offline` verdict is past the
 * relay-fuse recovery-dial window - the default for these tests, so the
 * fuse-window pair below has to opt IN to recency explicitly.
 */
const STALE_LAST_SEEN = "2026-07-03T11:59:50.000Z";

/** Mirrors the directory service's own projection — a REAL mapped entry. */
function directoryEntry(
  hostId: string,
  connectivity: HostConnectivity,
  lastSeenAt: string,
): HostDirectoryEntry {
  return hostListItemToDirectoryEntry(
    listItem(hostId, connectivity, lastSeenAt),
    RELAY_BASE_URL,
    PLAN_ALLOWS_REMOTE,
  );
}

/** The same projection for an account whose plan has no remote hosts. */
function planGatedEntry(
  hostId: string,
  connectivity: HostConnectivity,
  lastSeenAt: string,
): HostDirectoryEntry {
  return hostListItemToDirectoryEntry(
    listItem(hostId, connectivity, lastSeenAt),
    RELAY_BASE_URL,
    PLAN_GATED,
  );
}

function makeDirectory(entries: readonly HostDirectoryEntry[]) {
  const listeners = new Set<DirectoryListener>();
  return {
    directory: {
      list: () => Promise.resolve(entries),
      onChange: (listener: DirectoryListener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
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
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => {
  cleanup();
  directoryRef.value = null;
  readySessionHosts.value = new Set();
  readinessListeners.value.clear();
});

describe("useHostReachability — composed against real hostListItemToDirectoryEntry output", () => {
  it("does NOT report unreachable for a degraded ('unknown') liveness read", async () => {
    const entry = directoryEntry("host-unknown", "unknown", STALE_LAST_SEEN);
    directoryRef.value = makeDirectory([entry]).directory;
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useHostReachability("host-unknown"), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.status).not.toBe("checking");
    });
    // The false-Offline-when-blind bug, one layer below the mapper: a blind
    // liveness read is not evidence of death, so the tile keeps rendering
    // live instead of falling back to a dead-tile banner.
    expect(result.current.status).toBe("reachable");
    expect(result.current.unavailability).toBeNull();
  });

  it("reports unreachable with unavailability: 'offline' for a genuinely offline host", async () => {
    const entry = directoryEntry("host-offline", "offline", STALE_LAST_SEEN);
    directoryRef.value = makeDirectory([entry]).directory;
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useHostReachability("host-offline"), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.status).toBe("unreachable");
    });
    expect(result.current.unavailability).toBe("offline");
  });

  it("reports unreachable with unavailability: 'plan-restricted' for a LIVE host on a free-tier plan", async () => {
    const entry = planGatedEntry(
      "host-plan-gated",
      "connectable",
      STALE_LAST_SEEN,
    );
    directoryRef.value = makeDirectory([entry]).directory;
    const queryClient = makeQueryClient();

    const { result } = renderHook(
      () => useHostReachability("host-plan-gated"),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.status).toBe("unreachable");
    });
    // NOT "offline": the plan gate is a billing fact, not an outage, and a
    // consumer that collapsed this into "offline" would send a free-tier user
    // to restart a machine that is working fine.
    expect(result.current.unavailability).toBe("plan-restricted");
  });

  it("reports unreachable with unavailability: 'offline' for a free-tier host the cloud says is OFFLINE", async () => {
    // The fix this split exists for. The wire used to say `local-only` for
    // every host on an unpaid plan, so this tile rendered upgrade copy written
    // for a machine that was alive - and the dead-tile banner, failover and
    // the clone CTA could never fire for a free-tier user at all.
    const entry = planGatedEntry(
      "host-plan-gated-dead",
      "offline",
      STALE_LAST_SEEN,
    );
    directoryRef.value = makeDirectory([entry]).directory;
    const queryClient = makeQueryClient();

    const { result } = renderHook(
      () => useHostReachability("host-plan-gated-dead"),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.status).toBe("unreachable");
    });
    expect(result.current.unavailability).toBe("offline");
  });

  it("a live E2E session outranks an 'offline' cloud verdict — reachable, not unreachable", async () => {
    const entry = directoryEntry(
      "host-offline-but-live",
      "offline",
      STALE_LAST_SEEN,
    );
    directoryRef.value = makeDirectory([entry]).directory;
    readySessionHosts.value = new Set(["host-offline-but-live"]);
    const queryClient = makeQueryClient();

    const { result } = renderHook(
      () => useHostReachability("host-offline-but-live"),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.status).not.toBe("checking");
    });
    // Firsthand proof of life beats a cloud verdict reached minutes ago
    // through a different leg — this is the tab-open gate the review named
    // directly ("honours a live session as firsthand proof").
    expect(result.current.status).toBe("reachable");
    expect(result.current.unavailability).toBeNull();
  });

  it("still reports unreachable/offline without a live session, for the same host", async () => {
    // The counterpart to the override above: absent live-session evidence,
    // `offline` still gates the tile. Guards against a broad mock making
    // every host look alive.
    const entry = directoryEntry(
      "host-offline-no-session",
      "offline",
      STALE_LAST_SEEN,
    );
    directoryRef.value = makeDirectory([entry]).directory;
    const queryClient = makeQueryClient();

    const { result } = renderHook(
      () => useHostReachability("host-offline-no-session"),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.status).toBe("unreachable");
    });
    expect(result.current.unavailability).toBe("offline");
  });

  // P1 paired tests (cold review): the same recent `lastSeenAt`, distinguished
  // ONLY by the recovery dial's outcome. Recency alone (the relay-fuse window)
  // must never upgrade `offline` for the dead surface - a host that cleanly
  // detached or crashed a minute ago carries the same recent timestamp as a
  // lease lapse the fuse is riding out.
  it("PAIRED (a): fuse-window offline + recovery dial succeeded (ready session) - reachable", async () => {
    const recentLastSeen = new Date(Date.now() - 60_000).toISOString();
    const entry = directoryEntry(
      "host-fuse-window-live",
      "offline",
      recentLastSeen,
    );
    directoryRef.value = makeDirectory([entry]).directory;
    readySessionHosts.value = new Set(["host-fuse-window-live"]);
    const queryClient = makeQueryClient();

    const { result } = renderHook(
      () => useHostReachability("host-fuse-window-live"),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.status).not.toBe("checking");
    });
    expect(result.current.status).toBe("reachable");
    expect(result.current.unavailability).toBeNull();
  });

  it("PAIRED (b): fuse-window offline, dial not succeeded (no session) - the dead surface still fires", async () => {
    // Before the P1 correction the fuse window rewrote this `offline` to
    // `indeterminate` from recency alone, suppressing the dead surface, the
    // Clone offer, and the terminal-closed behavior for up to four hours on a
    // genuinely dead host.
    const recentLastSeen = new Date(Date.now() - 60_000).toISOString();
    const entry = directoryEntry(
      "host-fuse-window-dead",
      "offline",
      recentLastSeen,
    );
    directoryRef.value = makeDirectory([entry]).directory;
    const queryClient = makeQueryClient();

    const { result } = renderHook(
      () => useHostReachability("host-fuse-window-dead"),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.status).toBe("unreachable");
    });
    expect(result.current.unavailability).toBe("offline");
  });

  it("flips to reachable when a fuse-recovery dial becomes ready with NO directory change", async () => {
    // The transition the memo used to miss: a recovery dial succeeding
    // changes NO directory value (the registry row stays `offline` for up to
    // the lease TTL), so a memo keyed only on directory-query state kept
    // returning "unreachable" - a dead surface over a working session. The
    // hook now subscribes to session readiness itself.
    const recentLastSeen = new Date(Date.now() - 60_000).toISOString();
    const entry = directoryEntry("host-late-ready", "offline", recentLastSeen);
    directoryRef.value = makeDirectory([entry]).directory;
    const queryClient = makeQueryClient();

    const { result } = renderHook(
      () => useHostReachability("host-late-ready"),
      {
        wrapper: wrapper(queryClient),
      },
    );

    await waitFor(() => {
      expect(result.current.status).toBe("unreachable");
    });

    // The dial completes: readiness flips, the directory does not. Driving
    // the push notification directly (not a fake-timer tick) is the point of
    // this test post-P4.1 - the hook must react to the cache's own signal.
    readySessionHosts.value.add("host-late-ready");
    fireReadinessChanged();

    await waitFor(() => {
      expect(result.current.status).toBe("reachable");
    });
    expect(result.current.unavailability).toBeNull();
  });

  it("drops back to unreachable when the ready session is lost with NO directory change", async () => {
    // The inverse direction: a session dying is also invisible to the
    // directory query, and a stale "reachable" would keep a live-looking
    // surface on a host whose only proof of life just disappeared.
    const entry = directoryEntry(
      "host-session-lost",
      "offline",
      STALE_LAST_SEEN,
    );
    directoryRef.value = makeDirectory([entry]).directory;
    readySessionHosts.value = new Set(["host-session-lost"]);
    const queryClient = makeQueryClient();

    const { result } = renderHook(
      () => useHostReachability("host-session-lost"),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.status).toBe("reachable");
    });

    readySessionHosts.value.delete("host-session-lost");
    fireReadinessChanged();

    await waitFor(() => {
      expect(result.current.status).toBe("unreachable");
    });
    expect(result.current.unavailability).toBe("offline");
  });

  it("reports reachable for a connectable host, with no unavailability reason", async () => {
    const entry = directoryEntry("host-online", "connectable", STALE_LAST_SEEN);
    directoryRef.value = makeDirectory([entry]).directory;
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useHostReachability("host-online"), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.status).toBe("reachable");
    });
    expect(result.current.unavailability).toBeNull();
  });
});
