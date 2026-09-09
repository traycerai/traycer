import { useMemo } from "react";
import type {
  TierCandidate,
  TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import type {
  AgentReasoningEffortOption,
  GuiHarnessId,
} from "@traycer/protocol/host/index";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useGuiHarnessesQuery } from "@/hooks/harnesses/use-gui-harness-catalog";

/**
 * The effort levels a harness's own models advertise, or an empty list when
 * nothing can say.
 *
 * Empty is not "this harness has no efforts" - it is "no answer", which the
 * control must render differently from a known-empty set. See
 * {@link useFallbackEffortOptions}.
 */
export type FallbackEffortOptions = (
  harnessId: TierCandidate["harnessId"],
) => readonly AgentReasoningEffortOption[];

const NO_EFFORTS: readonly AgentReasoningEffortOption[] = [];
const NO_HARNESS_IDS: readonly GuiHarnessId[] = [];
const NO_REQUESTS: ReadonlyArray<{
  readonly method: "agent.gui.listModels";
  readonly params: {
    readonly harnessId: GuiHarnessId;
    readonly workingDirectory: string | null;
  };
}> = [];

/**
 * Which effort levels the "Equivalent models" editor may offer, per harness.
 *
 * ## Why a catalog read rather than the preview
 *
 * The row's Effort control used to be an unrestricted text input whose only
 * hint was the placeholder "any effort". A user had to already know a
 * provider-specific spelling; a typo was accepted, saved as policy, and then
 * silently dropped at resolution - so the value on screen did not mean the
 * effort the fallback would run at, on the one surface whose job is to say what
 * a row will do.
 *
 * The per-row preview cannot supply the answer. It reports what a family
 * RESOLVES to, and in preview mode (no failed tuple) the engine's walk stops at
 * the resolved slug without assembling a run tuple, so it never reaches the
 * effort normalisation and returns no effort information and no warnings at
 * all. The live source the GUI already has is `agent.gui.listModels`, whose
 * per-model `supportedReasoningEfforts` is what every other effort picker in
 * this app renders from.
 *
 * ## The union, not one model's list
 *
 * A candidate names a model FAMILY, not a model, and the effort applies to
 * whichever model that family resolves to at hop time - which depends on the
 * catalog then, not now. So the offer is the union across the harness's models:
 * narrowing it to the currently-resolved model would hide a level that is valid
 * for the model this row will actually reach.
 *
 * ## Cost
 *
 * One `agent.gui.listModels` per DISTINCT harness named in the draft - one or
 * two in practice, never the rail - on the SURFACE's host, which inside
 * Settings is the scoped one. The slots are the same ones the app-load
 * prefetcher fills and every model picker reads, with the same cache-only
 * contract (`staleTime`/`gcTime: Infinity`), so on the default host this adds
 * no request at all and on any host it never re-pulls a harness already held.
 *
 * Gated on AVAILABILITY, like every other targeted model fetch: a stored group
 * can name a harness the user has since disabled or never installed, and an
 * availability-blind read would hit that provider's `listModels` and retry the
 * failure on every mount of this page.
 */
export function useFallbackEffortOptions(
  groups: readonly TierGroup[],
): FallbackEffortOptions {
  const client = useHostClient();
  const harnessesQuery = useGuiHarnessesQuery({
    enabled: true,
    subscribed: true,
  });

  const available = harnessesQuery.data?.harnesses;
  /**
   * The wanted harnesses as a stable STRING, so the array below - and with it
   * the query observers - survives a keystroke.
   *
   * `groups` is a new reference on every draft move, including every character
   * typed into a model-family field. Memoising the array on `groups` alone
   * would rebuild it each time with identical contents, and hand `useQueries` a
   * fresh options array per keystroke.
   *
   * A space separates them because a harness id is an enum slug and cannot
   * contain one, so the join and the split below are exact inverses.
   */
  const wantedKey = useMemo(() => {
    const wanted = new Set<string>();
    for (const group of groups) {
      for (const candidate of group.candidates) wanted.add(candidate.harnessId);
    }
    return [...wanted].sort().join(" ");
  }, [groups]);

  const harnessIds = useMemo<readonly GuiHarnessId[]>(() => {
    if (available === undefined) return NO_HARNESS_IDS;
    const availableIds = new Set(
      available.flatMap((harness) => (harness.available ? [harness.id] : [])),
    );
    return wantedKey === ""
      ? NO_HARNESS_IDS
      : wantedKey.split(" ").flatMap((harnessId) => {
          // `safeParse` rather than trusting the id: a candidate's harness is
          // typed as the wire's `HarnessId`, and only a `GuiHarnessId` has a
          // GUI model catalog to ask about.
          //
          // Those two unions list the same members today - `guiHarnessIdSchema`
          // is `harnessIdSchema.extract([...])` over all twenty
          // (`protocol/src/host/agent/shared.ts:52-72`) - so this refuses
          // nothing at present, and no test pins it: reaching the branch would
          // need a cast, which tests the cast. It is here because they are
          // SEPARATELY declared, so a terminal-only vendor added to the wire
          // union would land in a stored policy and reach this hook, and the
          // failure of trusting the id then is a `listModels` for a harness with
          // no GUI catalog, retried on every mount of this page.
          const parsed = guiHarnessIdSchema.safeParse(harnessId);
          return parsed.success && availableIds.has(parsed.data)
            ? [parsed.data]
            : [];
        });
  }, [available, wantedKey]);

  const requests = useMemo(() => {
    if (harnessIds.length === 0) return NO_REQUESTS;
    return harnessIds.map((harnessId) => ({
      method: "agent.gui.listModels" as const,
      // `null`, not a workspace: this page configures a host-wide policy and
      // has no working directory to resolve a project-scoped catalog against.
      params: { harnessId, workingDirectory: null },
    }));
  }, [harnessIds]);

  const modelQueries = useHostQueries<HostRpcRegistry, "agent.gui.listModels">({
    client,
    cacheKeyIdentity: undefined,
    requests,
    options: {
      enabled: true,
      subscribed: true,
      staleTime: Infinity,
      gcTime: Infinity,
    },
  });

  const byHarnessId = useMemo(() => {
    const map = new Map<GuiHarnessId, readonly AgentReasoningEffortOption[]>();
    harnessIds.forEach((harnessId, index) => {
      // `requests` is memoised straight off `harnessIds`, so the two arrays are
      // the same length in every render this runs in - the entry is missing
      // only in the sense that its query has not answered yet.
      const models = modelQueries[index].data?.models;
      if (models === undefined) return;
      // Deduped by id, first-seen order kept: the catalog lists the levels in
      // the order the provider advertises them, which is the order a user has
      // seen everywhere else in the app.
      const seen = new Map<string, AgentReasoningEffortOption>();
      for (const model of models) {
        for (const effort of model.supportedReasoningEfforts) {
          if (!seen.has(effort.id)) seen.set(effort.id, effort);
        }
      }
      map.set(harnessId, [...seen.values()]);
    });
    return map;
  }, [harnessIds, modelQueries]);

  return useMemo(
    () => (harnessId: TierCandidate["harnessId"]) => {
      const parsed = guiHarnessIdSchema.safeParse(harnessId);
      if (!parsed.success) return NO_EFFORTS;
      return byHarnessId.get(parsed.data) ?? NO_EFFORTS;
    },
    [byHarnessId],
  );
}
