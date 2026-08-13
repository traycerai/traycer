import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";

interface ListState {
  readonly data: readonly HostDirectoryEntry[] | undefined;
  readonly fetchStatus: string;
}

const list = vi.hoisted<{ value: ListState }>(() => ({
  value: { data: [], fetchStatus: "idle" },
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => list.value,
}));

function entry(overrides: Partial<HostDirectoryEntry>): HostDirectoryEntry {
  return {
    hostId: "host-a",
    label: "This Mac",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:55300/rpc",
    version: "1.0.0",
    transportDialability: "dialable",
    ...overrides,
  };
}

function statusFor(hostId: string): string {
  return renderHook(() => useHostReachability(hostId)).result.current.status;
}

describe("useHostReachability", () => {
  beforeEach(() => {
    list.value = { data: [], fetchStatus: "idle" };
  });

  it("treats a busy host as reachable", () => {
    // The whole point of int #48. `busy` means the shell proved the process is
    // alive and only a probe went unanswered; the entry keeps its real
    // websocketUrl, the tab can still dial it, and the lock/clone CTA follow
    // from "unreachable" alone. On 2026-08-11 reading this as unreachable
    // locked every chat on a healthy machine read-only for two hours.
    //
    // `busy` reaches this hook as `dialable` — the directory service projects
    // it there (`toLocalEntry`), and that projection is pinned in
    // `host-directory-service.test.ts`. This end of the composition asserts
    // what the hook does with the value it actually receives.
    list.value = {
      data: [entry({ transportDialability: "dialable" })],
      fetchStatus: "idle",
    };
    expect(statusFor("host-a")).toBe("reachable");
  });

  it("still reports an available host as reachable", () => {
    list.value = { data: [entry({})], fetchStatus: "idle" };
    expect(statusFor("host-a")).toBe("reachable");
  });

  it("PRESERVED (2026-07-14): an empty directory is host-starting, never a per-tab death", () => {
    // The local host simply has not published yet. Reporting per-tab death
    // from this window rendered every chat as "Bound host is offline" + Clone
    // CTA, and terminals as permanently closed.
    list.value = { data: [], fetchStatus: "idle" };
    expect(statusFor("host-a")).toBe("host-starting");
  });

  it("PRESERVED (2026-08-08): a populated directory marking a host unavailable stays unreachable", () => {
    // A genuinely dead host must keep locking. The two-slot live check showed
    // what happens otherwise: an unavailable owner's rows carried no lock, the
    // sidebar routed them to a LIVE tab, and the tile dialed a dead host
    // forever - an eternal spinner instead of the locked published copy.
    list.value = {
      data: [
        entry({ hostId: "other", kind: "remote" }),
        entry({
          hostId: "host-a",
          kind: "remote",
          transportDialability: "not-dialable",
          websocketUrl: "wss://relay.example/attach",
        }),
      ],
      fetchStatus: "idle",
    };
    expect(statusFor("host-a")).toBe("unreachable");
  });

  it("keeps reporting unreachable for a host the populated directory does not list", () => {
    list.value = {
      data: [entry({ hostId: "other" })],
      fetchStatus: "idle",
    };
    expect(statusFor("host-a")).toBe("unreachable");
  });

  it("reports host-starting for this machine's not-yet-dialable local row", () => {
    // `HostDirectoryService.snapshot()` substitutes the registry's twin of THIS
    // machine as a local entry with no websocketUrl and a hardcoded
    // `unavailable` whenever the local snapshot is absent - boot, restart, or a
    // host busy enough to lose a probe. The twin arrives from the cloud before
    // the snapshot arrives from the shell, so the directory is non-empty and
    // the 2026-07-14 arm above does not apply: the same unknowable state,
    // previously answered "dead". Nothing can dial it (no websocketUrl), so
    // this cannot resurrect the 2026-08-08 corpse-dialing failure.
    list.value = {
      data: [
        entry({
          hostId: "host-a",
          kind: "local",
          websocketUrl: null,
          transportDialability: "not-dialable",
        }),
      ],
      fetchStatus: "idle",
    };
    expect(statusFor("host-a")).toBe("host-starting");
  });

  it("does not extend that grace to a remote host with no websocketUrl", () => {
    // Only the local-kind twin is "our own host, not published yet". A remote
    // row without a URL is a host we genuinely cannot reach.
    list.value = {
      data: [
        entry({
          hostId: "host-a",
          kind: "remote",
          websocketUrl: null,
          transportDialability: "not-dialable",
        }),
      ],
      fetchStatus: "idle",
    };
    expect(statusFor("host-a")).toBe("unreachable");
  });

  it("reports checking while the directory query is in flight", () => {
    list.value = { data: undefined, fetchStatus: "fetching" };
    expect(statusFor("host-a")).toBe("checking");
  });

  it("falls through to reachable when no directory source exists at all", () => {
    list.value = { data: undefined, fetchStatus: "idle" };
    expect(statusFor("host-a")).toBe("reachable");
  });
});
