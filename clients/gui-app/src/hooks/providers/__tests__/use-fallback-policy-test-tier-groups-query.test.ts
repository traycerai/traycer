import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TierGroup,
  TierPreviewBlockedTuple,
} from "@traycer/protocol/host/fallback-policy";
import {
  useFallbackPolicyTestTierGroupsQuery,
  type FallbackPolicyTestTierGroupsRequest,
} from "@/hooks/providers/use-fallback-policy-preview-tier-groups-query";

/**
 * The Test a model panel's request shape (ticket 05, clause 2): the FULL
 * `blocked` tuple travels, the draft's `defaultTierGroupId` travels, and the
 * query is disabled while `request` is `null`.
 */

const queryMocks = vi.hoisted(
  (): {
    params: Array<Record<string, unknown>>;
    enabled: boolean[];
  } => ({ params: [], enabled: [] }),
);

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly params: Record<string, unknown>;
    readonly options: { readonly enabled: boolean };
  }) => {
    queryMocks.params.push(args.params);
    queryMocks.enabled.push(args.options.enabled);
    return { data: undefined, isFetching: false, isError: false };
  },
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-a",
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

afterEach(() => {
  queryMocks.params = [];
  queryMocks.enabled = [];
  vi.clearAllMocks();
});

const GROUPS: readonly TierGroup[] = [
  {
    id: "flagship",
    candidates: [
      { harnessId: "codex", modelFamily: "*sol*", reasoningEffort: "high" },
    ],
  },
];

const BLOCKED: TierPreviewBlockedTuple = {
  harnessId: "codex",
  model: "gpt-6-sol",
  profileId: "profile-1",
  permissionMode: "auto_accept_edits",
  agentMode: "regular",
  serviceTier: "fast",
  kind: "rate_limit",
};

describe("useFallbackPolicyTestTierGroupsQuery - request shape", () => {
  it("sends exactly groups, defaultTierGroupId and the full blocked tuple", () => {
    const request: FallbackPolicyTestTierGroupsRequest = {
      groups: GROUPS,
      defaultTierGroupId: "flagship",
      blocked: BLOCKED,
    };
    renderHook(() => useFallbackPolicyTestTierGroupsQuery(request));
    expect(queryMocks.params).toHaveLength(1);
    // `toStrictEqual`, not `toEqual`: it fails on a missing key, an extra
    // key, or an `undefined`-valued key, so it alone pins the full
    // seven-field `blocked` tuple - not a subset of it.
    expect(queryMocks.params[0]).toStrictEqual({
      groups: GROUPS,
      defaultTierGroupId: "flagship",
      blocked: BLOCKED,
    });
  });

  it("is enabled when a request is present and the host supports the method", () => {
    const request: FallbackPolicyTestTierGroupsRequest = {
      groups: GROUPS,
      defaultTierGroupId: null,
      blocked: BLOCKED,
    };
    renderHook(() => useFallbackPolicyTestTierGroupsQuery(request));
    expect(queryMocks.enabled).toEqual([true]);
  });

  it("is disabled when request is null, and never reads the editor's own disabled key", () => {
    renderHook(() => useFallbackPolicyTestTierGroupsQuery(null));
    expect(queryMocks.enabled).toEqual([false]);
    // Not `{ groups: [] }` alone - that key is enabled for the EDITOR's own
    // preview when it holds no tiers, and this disabled observer must not
    // read that answer as its own.
    expect(queryMocks.params[0]).toStrictEqual({
      groups: [],
      defaultTierGroupId: null,
    });
  });
});
