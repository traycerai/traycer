import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOwnerListPrReferences } from "@/hooks/pr/use-owner-pr-references";

/**
 * `useOwnerListPrReferences` is a thin composition over the host directory,
 * stream client, method-support probe and the shared PR-list subscription -
 * every one of those is mocked here so the test exercises only the
 * composition itself, not any of their internals (each has its own suite).
 */
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostDirectoryEntryForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => null,
}));
vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));

const methodSupport = vi.hoisted<{
  current: "unknown" | "supported" | "unsupported";
}>(() => ({ current: "unknown" }));
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useStreamMethodSupportFor: () => methodSupport.current,
}));

const subscriptionResult = vi.hoisted(() => ({
  current: {
    data: null as { items: never[] } | null,
    error: null as { message: string } | null,
    isPending: true,
    sendRefresh: vi.fn(),
  },
}));
vi.mock("@/hooks/pr/use-pr-list-subscription", () => ({
  usePrListSubscriptionForClient: () => subscriptionResult.current,
}));

function renderOwnerPr() {
  return renderHook(() =>
    useOwnerListPrReferences({
      hostId: "host-1",
      epicId: "epic-1",
      ownerId: "owner-1",
      ownerKind: "chat",
      enabled: true,
    }),
  );
}

describe("useOwnerListPrReferences", () => {
  it("does not stay pending once the host has confirmed pr.subscribeListForEpic is unsupported", () => {
    // Regression: the hook disables the underlying subscription once support
    // is known-absent (`enabled: methodSupport !== "unsupported"`), but a
    // disabled TanStack query still reports `isPending: true` - it has never
    // received data and never will. Left unaccounted for, an unsupported
    // host's hover card would spin on "Loading workspace..." forever.
    methodSupport.current = "unsupported";
    subscriptionResult.current = {
      data: null,
      error: null,
      isPending: true,
      sendRefresh: vi.fn(),
    };

    const { result } = renderOwnerPr();

    expect(result.current.isPending).toBe(false);
  });

  it("still reports pending while support is unresolved and the subscription hasn't settled (non-regression)", () => {
    methodSupport.current = "unknown";
    subscriptionResult.current = {
      data: null,
      error: null,
      isPending: true,
      sendRefresh: vi.fn(),
    };

    const { result } = renderOwnerPr();

    expect(result.current.isPending).toBe(true);
  });

  it("reports pending on a confirmed-supported host whose subscription hasn't settled (non-regression)", () => {
    methodSupport.current = "supported";
    subscriptionResult.current = {
      data: null,
      error: null,
      isPending: true,
      sendRefresh: vi.fn(),
    };

    const { result } = renderOwnerPr();

    expect(result.current.isPending).toBe(true);
  });
});
