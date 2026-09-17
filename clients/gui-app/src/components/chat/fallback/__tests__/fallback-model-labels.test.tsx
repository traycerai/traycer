import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  useFallbackModelCatalogues,
  useFallbackModelLabels,
} from "@/components/chat/fallback/fallback-identity";

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

/**
 * The fields `useFallbackModelCatalogues`'s `unsettled` memo actually reads.
 * Extra catalogue-row keys exist on the wire; this double only has to be
 * honest about the ones the settled flag consults.
 */
interface HarnessSettledRow {
  readonly id: string;
  readonly available: boolean;
  // `enabled` is a SEPARATE wire field from `available`, and the hook consults
  // both - a harness the user switched off can still report itself available.
  // Absent from this double it would read `undefined`, and the rows would be
  // filtered out for a reason no test asked for.
  readonly enabled: boolean;
  readonly availabilityPending: boolean;
  readonly error: string | null;
  readonly lastSettledAvailable: boolean | null;
}

const harnessesData = vi.hoisted(() => ({
  value: undefined as
    | { readonly harnesses: ReadonlyArray<HarnessSettledRow> }
    | undefined,
}));

const harnessesQueryState = vi.hoisted(() => ({
  isPending: false,
  isError: false,
}));

const modelsByHarness = vi.hoisted(() => ({
  value: new Map<string, ReadonlyArray<{ slug: string; label: string }>>(),
}));

const hostQueriesCalls = vi.hoisted(() => ({
  requests: [] as ReadonlyArray<{
    readonly params: { readonly harnessId: string };
  }>,
}));

/**
 * Whether the model reads report as ANSWERED. Default `true`, because most
 * cases here are about the availability half and want the model half out of
 * the way - but it has to be controllable, or the double can only ever prove
 * that a settled catalogue settles, never that a pending one waits.
 */
const modelsSettled = vi.hoisted(() => ({ value: true }));

/**
 * Whether the host can be dialled at all. Default `true`.
 *
 * This is the condition both query hooks disable themselves on, so it is the
 * one that decides whether an unanswered read is going to be answered later or
 * is simply not running. It is NOT interchangeable with an errored read: the
 * harness query is a condition-poll method whose error lanes re-issue in 800ms,
 * so a failure there is a late answer, while this is no answer.
 */
const hostCanExecute = vi.hoisted(() => ({ value: true }));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: hostCanExecute.value ? "host-1" : null,
    requestContextUserId: hostCanExecute.value ? "user-1" : null,
    isReady: hostCanExecute.value,
    hasRpcEndpoint: hostCanExecute.value,
    canExecute: hostCanExecute.value,
  }),
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
    isPending: activity.enabled ? harnessesQueryState.isPending : false,
    isError: activity.enabled ? harnessesQueryState.isError : false,
  }),
}));

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    readonly requests: ReadonlyArray<{
      readonly params: { readonly harnessId: string };
    }>;
    // The real hook forwards `combine` to `useQueries` and returns ITS value,
    // not the result array. A double that ignored it would hand the caller
    // raw query results where production hands back the combined projection -
    // the double quietly standing in for a different hook than the one that
    // ships, and passing while the mapping under test never runs.
    readonly combine?: (
      results: ReadonlyArray<{
        readonly data: {
          readonly models: ReadonlyArray<{ slug: string; label: string }>;
        };
      }>,
    ) => unknown;
  }) => {
    hostQueriesCalls.requests = args.requests;
    const results = args.requests.map((request) => ({
      data: {
        models: modelsByHarness.value.get(request.params.harnessId) ?? [],
      },
      isPending: !modelsSettled.value,
      isError: false,
      // Production's `combine` treats `isSuccess || isError || !enabled` as
      // settled. Without this the double would report every available
      // harness's catalogue as still in flight, and `settledFor` tests
      // below would be pinning the mock rather than the memo.
      isSuccess: modelsSettled.value,
    }));
    return args.combine === undefined ? results : args.combine(results);
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

function settledRow(
  id: string,
  available: boolean,
  overrides: {
    readonly enabled: boolean;
    readonly availabilityPending: boolean;
    readonly error: string | null;
    readonly lastSettledAvailable: boolean | null;
  },
): HarnessSettledRow {
  return {
    id,
    available,
    enabled: overrides.enabled,
    availabilityPending: overrides.availabilityPending,
    error: overrides.error,
    lastSettledAvailable: overrides.lastSettledAvailable,
  };
}

const SETTLED_TRUE = {
  enabled: true,
  availabilityPending: false,
  error: null,
  lastSettledAvailable: true,
} as const;

describe("useFallbackModelLabels", () => {
  beforeEach(() => {
    harnessesQueryState.isPending = false;
    harnessesQueryState.isError = false;
    modelsSettled.value = true;
    harnessesData.value = {
      harnesses: [
        settledRow("claude", true, SETTLED_TRUE),
        settledRow("codex", false, {
          enabled: true,
          availabilityPending: false,
          error: null,
          lastSettledAvailable: false,
        }),
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

  it("issues no model query for a harness that is available but DISABLED, and degrades to the slug", () => {
    harnessesData.value = {
      harnesses: [
        settledRow("claude", true, SETTLED_TRUE),
        // The shape the bare `available` check let through: the provider is
        // reachable, the user has switched the harness off. `available` and
        // `enabled` are separate wire fields, so this row is not hypothetical.
        settledRow("codex", true, {
          enabled: false,
          availabilityPending: false,
          error: null,
          lastSettledAvailable: false,
        }),
      ],
    };

    const { result } = renderHook(() =>
      useFallbackModelLabels(null, ["claude", "codex"], true),
    );

    // Falsification: relax `harnessIds`'s filter back to `harness.available`
    // alone and this goes red - "codex" is requested again, and an error on
    // that query would refetch on every later mount.
    expect(hostQueriesCalls.requests.map((r) => r.params.harnessId)).toEqual([
      "claude",
    ]);
    expect(result.current("codex", "gpt-5")).toBe("gpt-5");
    // The enabled sibling is unaffected: this is a per-row gate, not a bail.
    expect(result.current("claude", "claude-fable-5-1[1m]")).toBe(
      "Claude Fable",
    );
  });

  it("reports a disabled harness as SETTLED rather than waiting on a catalogue that will never be fetched", () => {
    harnessesData.value = {
      harnesses: [
        settledRow("codex", true, {
          enabled: false,
          availabilityPending: true,
          error: null,
          lastSettledAvailable: false,
        }),
      ],
    };

    const { result } = renderHook(() =>
      useFallbackModelCatalogues(null, ["codex"], true),
    );
    // No request is issued for it, so a caller that waited would wait forever
    // and the manual-switch announcement would never be spoken at all.
    expect(result.current.settledFor("codex")).toBe(true);
  });

  it("settles a disabled harness whose own availability probe is still unresolved", () => {
    // Same claim as the case above, on the one fixture that can prove it. That
    // row is `available: true`, so the availability branch excludes it on
    // `!row.available` before `row.enabled` is ever consulted - deleting the
    // `enabled` conjunct leaves it green. Here `available` is false, so
    // `enabled` is the only conjunct standing between this row and an
    // unreleasable wait.
    harnessesData.value = {
      harnesses: [
        settledRow("codex", false, {
          enabled: false,
          availabilityPending: true,
          error: null,
          lastSettledAvailable: false,
        }),
      ],
    };

    const { result } = renderHook(() =>
      useFallbackModelCatalogues(null, ["codex"], true),
    );
    // A disabled harness is not fanned out, so no catalogue is coming however
    // its probe resolves. Waiting on one is the indefinite-silence half of the
    // trade, and it is the half with no second chance.
    expect(result.current.settledFor("codex")).toBe(true);
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

/**
 * `settledFor` is keyed off the WANTED ids, not off the ids that already
 * survived the availability filter. Walking only those survivors reported
 * every still-loading id as settled - including, before `listHarnesses`
 * answered, every id in play.
 *
 * Falsification for the pending-query case: restore the memo that only
 * walked `harnessIds` (empty while `available === undefined`) and
 * `settledFor("claude")` goes back to `true`.
 */
describe("useFallbackModelCatalogues.settledFor", () => {
  beforeEach(() => {
    harnessesQueryState.isPending = false;
    harnessesQueryState.isError = false;
    harnessesData.value = undefined;
    modelsByHarness.value = new Map();
    hostQueriesCalls.requests = [];
    // Both of these are reset HERE and not only in the first describe. A
    // control left where the previous case put it is inherited by whatever is
    // appended next, which passes or fails for a reason its own body does not
    // state - and the last case in a file is exactly where the next one lands.
    modelsSettled.value = true;
    hostCanExecute.value = true;
  });

  it("is false for every requested id while listHarnesses is still pending, and true for an id nobody asked about", () => {
    harnessesQueryState.isPending = true;
    harnessesData.value = undefined;

    const { result } = renderHook(() =>
      useFallbackModelCatalogues(null, ["claude", "codex"], true),
    );

    expect(result.current.settledFor("claude")).toBe(false);
    expect(result.current.settledFor("codex")).toBe(false);
    // Unasked-for ids have no read in flight; treating them as unsettled
    // would block on a request that will never be made.
    expect(result.current.settledFor("grok")).toBe(true);
  });

  it("HOLDS every requested id when a cold listHarnesses read has errored - the initial-error lane re-issues", () => {
    harnessesQueryState.isError = true;
    harnessesData.value = undefined;

    const { result } = renderHook(() =>
      useFallbackModelCatalogues(null, ["claude"], true),
    );

    // This assertion used to read `true`, on the words "a failed read is never
    // coming". It is coming: `agent.gui.listHarnesses` declares
    // `initialErrorLane: HARNESS_INITIAL_ERROR_POLL_LANE`, which is a spread of
    // the 800ms `harnesses.pending` lane, and the queries are pinned
    // `retry: false` so a single dropped frame lands here on its own. Settling
    // would consume the manual-switch announcement with a raw slug 800ms before
    // the real name arrived, and that sentence cannot be corrected afterwards.
    expect(result.current.settledFor("claude")).toBe(false);
  });

  it("is false for a row still deciding availability, and true once that row has settled unavailable", () => {
    harnessesData.value = {
      harnesses: [
        settledRow("claude", false, {
          enabled: true,
          availabilityPending: true,
          error: null,
          lastSettledAvailable: null,
        }),
      ],
    };

    const { result: pending } = renderHook(() =>
      useFallbackModelCatalogues(null, ["claude"], true),
    );
    // Falsification: skip the availabilityPending arm. `harnessIds` drops
    // this row (`available: false`), so walking only survivors reports it
    // settled while its catalogue fetch has not even started.
    expect(pending.current.settledFor("claude")).toBe(false);

    harnessesData.value = {
      harnesses: [
        settledRow("claude", false, {
          enabled: true,
          availabilityPending: false,
          error: null,
          lastSettledAvailable: false,
        }),
      ],
    };
    const { result: settledUnavailable } = renderHook(() =>
      useFallbackModelCatalogues(null, ["claude"], true),
    );
    expect(settledUnavailable.current.settledFor("claude")).toBe(true);

    // A row that previously answered unavailable and is being RE-PROBED still
    // has an answer coming, so it must wait. This assertion used to read
    // `true`, on the theory that a prior negative verdict meant no catalogue
    // was coming - but a probe can succeed, and settling here consumed the
    // manual-switch announcement with a raw slug that no later resolution
    // could correct, because that path advances a sequence counter.
    harnessesData.value = {
      harnesses: [
        settledRow("claude", false, {
          enabled: true,
          availabilityPending: true,
          error: null,
          lastSettledAvailable: false,
        }),
      ],
    };
    const { result: reprobing } = renderHook(() =>
      useFallbackModelCatalogues(null, ["claude"], true),
    );
    expect(reprobing.current.settledFor("claude")).toBe(false);
  });

  it("HOLDS a pending row when a refetch errored and TanStack retained the last good rows", () => {
    // `listHarnesses` succeeded once, so `data` is populated, and a later
    // refetch failed. The error reducer spreads existing state rather than
    // clearing `data`, so `isError` and a full row set are true together -
    // which is precisely the `harnesses.stale-error` lane, re-issuing in 800ms
    // with this row's probe still outstanding.
    harnessesData.value = {
      harnesses: [
        settledRow("claude", false, {
          enabled: true,
          availabilityPending: true,
          error: null,
          lastSettledAvailable: null,
        }),
      ],
    };
    harnessesQueryState.isError = true;

    const { result } = renderHook(() =>
      useFallbackModelCatalogues(null, ["claude"], true),
    );

    // Falsification: gate either branch of the availability wait on
    // `harnessesQuery.isError` and this goes red. That is the version this
    // replaces, and it spent the unrecoverable direction of the trade - a
    // permanently wrong slug - on the single commonest failure there is.
    expect(result.current.settledFor("claude")).toBe(false);
  });

  it("still waits on a pending MODEL read while the harness read is erroring - they are separate reads", () => {
    // `claude` is available, so it reaches `requests` and the model read
    // governs it. Pinned from the other side: the availability half having an
    // opinion must not decide the catalogue half either way.
    harnessesData.value = {
      harnesses: [settledRow("claude", true, SETTLED_TRUE)],
    };
    harnessesQueryState.isError = true;
    modelsSettled.value = false;

    const { result } = renderHook(() =>
      useFallbackModelCatalogues(null, ["claude"], true),
    );

    expect(result.current.settledFor("claude")).toBe(false);
  });

  it("settles every requested id when the host cannot be dialled at all", () => {
    // The case the `isError` test was reaching for and missing. Both query
    // hooks disable on `!readiness.canExecute`, and a disabled query sits at
    // `isPending` with nothing scheduled, so there is no later frame to wait
    // for. THIS is a read that is not coming; an errored one is a late one.
    hostCanExecute.value = false;
    harnessesData.value = undefined;

    const { result } = renderHook(() =>
      useFallbackModelCatalogues(null, ["claude"], true),
    );

    expect(result.current.settledFor("claude")).toBe(true);
  });

  it("settles a row still mid-probe when the host cannot be dialled", () => {
    // Retained rows plus a frozen read: the probe that would clear
    // `availabilityPending` cannot run, so waiting on it is permanent silence
    // about a switch that did happen.
    hostCanExecute.value = false;
    harnessesData.value = {
      harnesses: [
        settledRow("claude", false, {
          enabled: true,
          availabilityPending: true,
          error: null,
          lastSettledAvailable: null,
        }),
      ],
    };

    const { result } = renderHook(() =>
      useFallbackModelCatalogues(null, ["claude"], true),
    );

    expect(result.current.settledFor("claude")).toBe(true);
  });

  it("settles a pending MODEL read when the host cannot be dialled", () => {
    // The model half of the same gate, and the one `enabled` alone did not
    // cover: `useHostQueries` disables on an unbound client and on un-settled
    // readiness as well as on this hook's flag, so a cold catalogue slot on a
    // host that cannot be reached reported `isPending` with nothing behind it.
    // Falsification: drop the `readsFrozen` arm from `combine`'s `settled` and
    // this goes red.
    hostCanExecute.value = false;
    harnessesData.value = {
      harnesses: [settledRow("claude", true, SETTLED_TRUE)],
    };
    modelsSettled.value = false;

    const { result } = renderHook(() =>
      useFallbackModelCatalogues(null, ["claude"], true),
    );

    expect(result.current.settledFor("claude")).toBe(true);
  });
});
