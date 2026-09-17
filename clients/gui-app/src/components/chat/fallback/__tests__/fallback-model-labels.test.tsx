import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import { useFallbackModelLabels } from "@/components/chat/fallback/fallback-identity";

/**
 * `useFallbackModelLabels`'s own resolution rules, isolated from any
 * component that consumes it - see `fallback-identity.ts` for the full
 * design note. Every routing surface (the grace card, the waiting card, the
 * return banner, the retry row, the transcript announcer) calls this same
 * hook and reads `identity.model` off its answer, so a defect here reaches
 * every one of them identically; that is also why it is worth pinning on its
 * own rather than only through one card's rendered text.
 *
 * The two RPC-level hooks it composes (`useGuiHarnessesQueryForClient`,
 * `useHostQueries`) are mocked directly, which is what lets this file avoid a
 * `QueryClientProvider` / real `HostClient` entirely - the real fetch/cache
 * machinery is exercised by whichever component tests need a live transport;
 * this file is only about the MAPPING logic layered on top of it.
 */

const harnessesData = vi.hoisted(() => ({
  value: undefined as
    | { readonly harnesses: ReadonlyArray<{ id: string; available: boolean }> }
    | undefined,
}));

const modelsByHarness = vi.hoisted(() => ({
  value: new Map<string, ReadonlyArray<{ slug: string; label: string }>>(),
}));

const hostQueriesCalls = vi.hoisted(() => ({
  requests: [] as ReadonlyArray<{
    readonly params: { readonly harnessId: string };
  }>,
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: (
    _client: unknown,
    activity: { readonly enabled: boolean },
  ) => ({
    // Honors `enabled` the way a real disabled TanStack query would: no read,
    // no data - which is the one thing this double has to get right for the
    // "disabled surface" case below to mean anything.
    data: activity.enabled ? harnessesData.value : undefined,
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    readonly requests: ReadonlyArray<{
      readonly params: { readonly harnessId: string };
    }>;
  }) => {
    hostQueriesCalls.requests = args.requests;
    return args.requests.map((request) => ({
      data: {
        models: modelsByHarness.value.get(request.params.harnessId) ?? [],
      },
      isPending: false,
      isError: false,
    }));
  },
}));

function modelOption(
  harnessId: string,
  slug: string,
  label: string,
): GuiAgentModelOption {
  return {
    harnessId: harnessId as GuiAgentModelOption["harnessId"],
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

describe("useFallbackModelLabels", () => {
  beforeEach(() => {
    harnessesData.value = {
      harnesses: [
        { id: "claude", available: true },
        { id: "codex", available: false },
      ],
    };
    modelsByHarness.value = new Map([
      [
        "claude",
        [modelOption("claude", "claude-fable-5-1[1m]", "Claude Fable")],
      ],
    ]);
    hostQueriesCalls.requests = [];
  });

  it("resolves a slug present in the catalogue to its label, matching case-insensitively", () => {
    const { result } = renderHook(() =>
      useFallbackModelLabels(null, ["claude"], true),
    );
    // Falsification: drop the `.toLowerCase()` on either side of the map
    // lookup in `fallback-identity.ts` - this goes red on the mixed-case slug.
    expect(result.current("claude", "CLAUDE-FABLE-5-1[1M]")).toBe(
      "Claude Fable",
    );
    expect(result.current("claude", "claude-fable-5-1[1m]")).toBe(
      "Claude Fable",
    );
  });

  it("renders the slug unchanged when the catalogue has no matching entry", () => {
    const { result } = renderHook(() =>
      useFallbackModelLabels(null, ["claude"], true),
    );
    // A model the provider has since dropped, or one never in this catalogue
    // read - the only honest degradation the module's own doc describes.
    expect(result.current("claude", "claude-opus-5")).toBe("claude-opus-5");
  });

  it("issues no model query for a harness the catalogue reports unavailable, and degrades to the slug", () => {
    const { result } = renderHook(() =>
      useFallbackModelLabels(null, ["claude", "codex"], true),
    );
    // Falsification: drop the `available` filter from `harnessIds`'s memo -
    // this goes red, since a query would then be issued for "codex" too.
    expect(hostQueriesCalls.requests.map((r) => r.params.harnessId)).toEqual([
      "claude",
    ]);
    // "codex" is unavailable, so its slug renders as typed - never blank,
    // never an invented name.
    expect(result.current("codex", "gpt-5")).toBe("gpt-5");
  });

  it("issues no query and degrades to the slug for every tuple while the resolver is disabled", () => {
    const { result } = renderHook(() =>
      useFallbackModelLabels(null, ["claude"], false),
    );
    expect(hostQueriesCalls.requests).toHaveLength(0);
    expect(result.current("claude", "claude-fable-5-1[1m]")).toBe(
      "claude-fable-5-1[1m]",
    );
  });

  it("ignores a harness id not present in harnessIdsInPlay - null entries filtered, no query for the unlisted id", () => {
    const { result } = renderHook(() =>
      useFallbackModelLabels(null, [null, "claude", null], true),
    );
    expect(hostQueriesCalls.requests.map((r) => r.params.harnessId)).toEqual([
      "claude",
    ]);
    expect(result.current("claude", "claude-fable-5-1[1m]")).toBe(
      "Claude Fable",
    );
  });
});
