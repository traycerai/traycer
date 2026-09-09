import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentReasoningEffortOption,
  GuiAgentModelOption,
  GuiHarnessOption,
  ListGuiHarnessesResponse,
} from "@traycer/protocol/host/index";
import type {
  TierCandidate,
  TierGroup,
} from "@traycer/protocol/host/fallback-policy";

/** What the mocked `useHostQueries` was called with, for the gating pins. */
interface CapturedRequest {
  readonly method: string;
  readonly params: {
    readonly harnessId: string;
    readonly workingDirectory: string | null;
  };
}

/**
 * Every collaborator this hook reaches through is mocked at the module seam:
 * the host client itself (never consulted for identity here - `useHostQueries`
 * is mocked too, so nothing reads through it), the harness-availability query,
 * and the batched models query. `capturedRequests` is what the availability-
 * gate and non-GUI-harness cases assert on.
 */
const fixture = vi.hoisted(
  (): {
    harnesses: readonly GuiHarnessOption[] | undefined;
    modelsByHarness: Map<string, readonly GuiAgentModelOption[]>;
    capturedRequests: readonly CapturedRequest[];
  } => ({
    harnesses: undefined,
    modelsByHarness: new Map(),
    capturedRequests: [],
  }),
);

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({}),
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: (): { data: ListGuiHarnessesResponse | undefined } => ({
    data:
      fixture.harnesses === undefined
        ? undefined
        : { harnesses: [...fixture.harnesses] },
  }),
}));

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    readonly requests: readonly CapturedRequest[];
  }): ReadonlyArray<{
    data: { models: readonly GuiAgentModelOption[] } | undefined;
  }> => {
    fixture.capturedRequests = args.requests;
    return args.requests.map((request) => {
      const models = fixture.modelsByHarness.get(request.params.harnessId);
      return {
        data: models === undefined ? undefined : { models: [...models] },
      };
    });
  },
}));

import { useFallbackEffortOptions } from "@/components/settings/panels/fallback/fallback-effort-options";

function harness(
  id: GuiHarnessOption["id"],
  available: boolean,
): GuiHarnessOption {
  return {
    id,
    label: id,
    enabled: true,
    available,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: ["full_access"],
    availabilityPending: false,
    authStatus: undefined,
  };
}

function effort(id: string, label: string): AgentReasoningEffortOption {
  return { id, label, description: null };
}

function model(
  harnessId: GuiAgentModelOption["harnessId"],
  slug: string,
  supportedReasoningEfforts: readonly AgentReasoningEffortOption[],
): GuiAgentModelOption {
  return {
    harnessId,
    slug,
    label: slug,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [...supportedReasoningEfforts],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

function tierGroup(
  candidateHarnessIds: readonly TierCandidate["harnessId"][],
): TierGroup {
  return {
    id: "g1",
    candidates: candidateHarnessIds.map((harnessId) => ({
      harnessId,
      modelFamily: "opus",
      reasoningEffort: null,
    })),
  };
}

beforeEach(() => {
  fixture.harnesses = [];
  fixture.modelsByHarness = new Map();
  fixture.capturedRequests = [];
});

afterEach(() => {
  cleanup();
});

describe("useFallbackEffortOptions", () => {
  it("unions and dedupes effort levels across a harness's models, in first-seen order", () => {
    fixture.harnesses = [harness("claude", true)];
    fixture.modelsByHarness.set("claude", [
      model("claude", "opus", [effort("high", "High"), effort("low", "Low")]),
      // "high" repeats with a different label object but the same id - the
      // first-seen entry wins, so this model contributes only "medium".
      model("claude", "sonnet", [
        effort("high", "High (duplicate)"),
        effort("medium", "Medium"),
      ]),
    ]);
    const { result } = renderHook(() =>
      useFallbackEffortOptions([tierGroup(["claude"])]),
    );
    // Falsification: change the `if (!seen.has(effort.id))` guard in
    // `fallback-effort-options.ts` to always `seen.set(...)` (or iterate
    // `Array.from(new Set(...))` on the raw option OBJECTS instead of their
    // ids) - this would then either duplicate "high" or drop the second
    // model's "medium" behind an unrelated-object dedupe failure.
    expect(result.current("claude").map((option) => option.id)).toEqual([
      "high",
      "low",
      "medium",
    ]);
    expect(
      result.current("claude").find((option) => option.id === "high")?.label,
    ).toBe("High");
  });

  it("availability gate: an unavailable harness produces no request and no options", () => {
    fixture.harnesses = [harness("claude", false)];
    fixture.modelsByHarness.set("claude", [
      model("claude", "opus", [effort("high", "High")]),
    ]);
    const { result } = renderHook(() =>
      useFallbackEffortOptions([tierGroup(["claude"])]),
    );
    // Falsification: drop the `availableIds.has(parsed.data)` check in
    // `useFallbackEffortOptions`'s `harnessIds` memo
    // (`fallback-effort-options.ts`) - this would then send a request for a
    // harness the user has disabled, retrying its failure on every mount.
    expect(fixture.capturedRequests).toHaveLength(0);
    expect(result.current("claude")).toEqual([]);
  });

  it("negative control: the SAME harness reported available DOES produce a request", () => {
    fixture.harnesses = [harness("claude", true)];
    fixture.modelsByHarness.set("claude", [
      model("claude", "opus", [effort("high", "High")]),
    ]);
    renderHook(() => useFallbackEffortOptions([tierGroup(["claude"])]));
    expect(fixture.capturedRequests).toHaveLength(1);
    expect(fixture.capturedRequests[0].params).toEqual({
      harnessId: "claude",
      workingDirectory: null,
    });
  });

  // NOT pinned here: the `guiHarnessIdSchema.safeParse` refusal in
  // `useFallbackEffortOptions`.
  //
  // `guiHarnessIdSchema` is `harnessIdSchema.extract([...])` over ALL twenty
  // members (`protocol/src/host/agent/shared.ts:52-72`), so `GuiHarnessId` and
  // the `HarnessId` that `TierCandidate["harnessId"]` resolves to are the same
  // union today. There is therefore no value that type-checks as a candidate's
  // harness and still fails that parse, and the branch is unreachable through a
  // well-typed fixture - reaching it needs a cast, which is both banned here and
  // a test of the cast rather than of the code.
  //
  // It stays in the hook as a boundary check for the day the two unions diverge
  // (a terminal-only vendor added to the wire union), which is the only state in
  // which it has an observable consequence. Pin it then, from a fixture that no
  // longer needs a cast.
});
