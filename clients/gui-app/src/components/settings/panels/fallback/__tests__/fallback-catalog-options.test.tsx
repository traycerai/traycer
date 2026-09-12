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
 * gate cases assert on.
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

import {
  useFallbackCatalogOptions,
  catalogModelForFamily,
} from "@/components/settings/panels/fallback/fallback-catalog-options";

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

describe("useFallbackCatalogOptions - effortsFor", () => {
  it("a family (not a catalog slug) unions and dedupes effort levels across the harness's models, in first-seen order", () => {
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
      useFallbackCatalogOptions([tierGroup(["claude"])]),
    );
    // A blank family matches no catalog slug (`catalogModelForFamily` returns
    // `null` for a trimmed-empty string), which is what routes `effortsFor`
    // to the union branch rather than one model's own list.
    //
    // Falsification: change the `if (!seen.has(effort.id))` guard in
    // `fallback-catalog-options.ts` to always `seen.set(...)` (or iterate
    // `Array.from(new Set(...))` on the raw option OBJECTS instead of their
    // ids) - this would then either duplicate "high" or drop the second
    // model's "medium" behind an unrelated-object dedupe failure.
    expect(
      result.current.effortsFor("claude", "").map((option) => option.id),
    ).toEqual(["high", "low", "medium"]);
    expect(
      result.current
        .effortsFor("claude", "")
        .find((option) => option.id === "high")?.label,
    ).toBe("High");
  });

  it("a family that IS exactly one catalog slug returns ONLY that model's own efforts, not the union", () => {
    fixture.harnesses = [harness("claude", true)];
    fixture.modelsByHarness.set("claude", [
      model("claude", "opus", [effort("high", "High")]),
      model("claude", "sonnet", [effort("medium", "Medium")]),
    ]);
    const { result } = renderHook(() =>
      useFallbackCatalogOptions([tierGroup(["claude"])]),
    );
    // Falsification: drop the `catalogModelForFamily` branch in `effortsFor`
    // and always return the harness-wide union - "medium" would then leak
    // into a request that named "opus" specifically, offering a level the
    // chosen model does not support.
    expect(
      result.current.effortsFor("claude", "opus").map((option) => option.id),
    ).toEqual(["high"]);
  });

  it("availability gate: an unavailable harness produces no request and empty options", () => {
    fixture.harnesses = [harness("claude", false)];
    fixture.modelsByHarness.set("claude", [
      model("claude", "opus", [effort("high", "High")]),
    ]);
    const { result } = renderHook(() =>
      useFallbackCatalogOptions([tierGroup(["claude"])]),
    );
    // Falsification: drop the `availableIds.has(parsed.data)` check in
    // `useFallbackCatalogOptions`'s `harnessIds` memo
    // (`fallback-catalog-options.ts`) - this would then send a request for a
    // harness the user has disabled, retrying its failure on every mount.
    expect(fixture.capturedRequests).toHaveLength(0);
    expect(result.current.effortsFor("claude", "opus")).toEqual([]);
    expect(result.current.modelsFor("claude")).toEqual([]);
  });

  it("negative control: the SAME harness reported available DOES produce a request", () => {
    fixture.harnesses = [harness("claude", true)];
    fixture.modelsByHarness.set("claude", [
      model("claude", "opus", [effort("high", "High")]),
    ]);
    renderHook(() => useFallbackCatalogOptions([tierGroup(["claude"])]));
    expect(fixture.capturedRequests).toHaveLength(1);
    expect(fixture.capturedRequests[0].params).toEqual({
      harnessId: "claude",
      workingDirectory: null,
    });
  });

  it("no answer yet: an available harness whose catalog query has not resolved still sends a request but returns empty options", () => {
    fixture.harnesses = [harness("claude", true)];
    // Deliberately no `modelsByHarness` entry - the mocked query behaves
    // exactly as an in-flight or cold `listModels` read does: `data:
    // undefined`.
    const { result } = renderHook(() =>
      useFallbackCatalogOptions([tierGroup(["claude"])]),
    );
    // Falsification: have `byHarnessId`'s memo fall back to an empty models
    // array instead of skipping the entry on `models === undefined` - that
    // would make a cold catalog slot indistinguishable from "this harness
    // genuinely has no models", which is exactly the ambiguity
    // `FallbackCatalogOptions`'s own doc comment says the empty-list return
    // must not create.
    expect(fixture.capturedRequests).toHaveLength(1);
    expect(result.current.modelsFor("claude")).toEqual([]);
    expect(result.current.effortsFor("claude", "opus")).toEqual([]);
  });

  // NOT pinned here: the `guiHarnessIdSchema.safeParse` refusal in
  // `useFallbackCatalogOptions`.
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

describe("useFallbackCatalogOptions - modelsFor", () => {
  it("returns the harness's catalog in the provider's own order, unmodified", () => {
    fixture.harnesses = [harness("claude", true)];
    // Deliberately NOT alphabetical / slug-sorted: if `modelsFor` re-sorted
    // or re-derived this list, this order would not survive the round trip.
    fixture.modelsByHarness.set("claude", [
      model("claude", "sonnet", []),
      model("claude", "opus", []),
      model("claude", "haiku", []),
    ]);
    const { result } = renderHook(() =>
      useFallbackCatalogOptions([tierGroup(["claude"])]),
    );
    // Falsification: sort or reorder `models` anywhere on the way from the
    // mocked `listModels` response to `modelsFor`'s return - this would
    // then read `["haiku", "opus", "sonnet"]` or similar instead of the
    // catalog's own order.
    expect(result.current.modelsFor("claude").map((m) => m.slug)).toEqual([
      "sonnet",
      "opus",
      "haiku",
    ]);
  });

  it("an unavailable harness returns an empty array", () => {
    fixture.harnesses = [harness("claude", false)];
    fixture.modelsByHarness.set("claude", [model("claude", "opus", [])]);
    const { result } = renderHook(() =>
      useFallbackCatalogOptions([tierGroup(["claude"])]),
    );
    expect(result.current.modelsFor("claude")).toEqual([]);
  });

  it("a harness absent from the catalog entirely returns an empty array", () => {
    // No harnesses reported at all - not merely `available: false`, but
    // literally missing from the availability response.
    fixture.harnesses = [];
    const { result } = renderHook(() =>
      useFallbackCatalogOptions([tierGroup(["claude"])]),
    );
    // Falsification: have `harnessIds` fall through to treating an unlisted
    // id as available (e.g. defaulting a missing lookup to `true`) - this
    // would then send a request and/or surface a model list for a harness
    // the availability read never named.
    expect(result.current.modelsFor("claude")).toEqual([]);
    expect(fixture.capturedRequests).toHaveLength(0);
  });
});

describe("catalogModelForFamily", () => {
  const models = [model("claude", "opus", []), model("claude", "sonnet", [])];

  it("matches a slug case-insensitively and trims whitespace", () => {
    // Falsification: drop the `.trim().toLowerCase()` normalisation - a
    // caller passing "GPT-5" or " opus " would then find nothing, though the
    // engine's own family match (`candidateFamilyMatchesSlug`) lower-cases
    // both sides and would treat them as the same model.
    expect(catalogModelForFamily(models, " OPUS ")?.slug).toBe("opus");
  });

  it("returns null for a blank family and for one that matches no model", () => {
    expect(catalogModelForFamily(models, "")).toBeNull();
    expect(catalogModelForFamily(models, "   ")).toBeNull();
    expect(catalogModelForFamily(models, "gpt-5")).toBeNull();
  });
});
