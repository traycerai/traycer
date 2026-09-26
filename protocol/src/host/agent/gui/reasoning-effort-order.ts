import type {
  AgentReasoningEffortOption,
  GuiAgentModelOption,
} from "./unary-schemas";
import {
  readableModelMatch,
  resolveModelBySlug,
} from "./model-slug-resolution";

/**
 * The canonical order of reasoning efforts, shared by the host and the GUI.
 *
 * It lives in the protocol rather than in either peer because two surfaces
 * must answer "which effort is the lowest this model advertises" identically:
 * the host, which runs Traycer's `auto`-mode judge at that effort when the
 * user has not picked one, and the GUI, which names that default in Settings
 * ▸ Permissions ▸ Judge and on the composer's Auto row. A rank table in each
 * would drift, and the drift would show as the composer promising one effort
 * while the host runs another.
 */

/**
 * Canonical picker order: Low → Medium → High → Extra High → Max, matching
 * Claude / Codex / Copilot. Unknown ids keep their relative order and sort
 * after the known ladder.
 *
 * Grok's live catalog lists Extra High first; every other harness already
 * advertises low-to-high. The Grok catalog mapper sorts through this helper
 * so a future reversed vendor list cannot regress the picker.
 */
export function sortReasoningEffortOptions<T extends { readonly id: string }>(
  options: ReadonlyArray<T>,
): T[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((left, right) => {
      const rankDelta =
        reasoningEffortRank(left.option.id) -
        reasoningEffortRank(right.option.id);
      return rankDelta !== 0 ? rankDelta : left.index - right.index;
    })
    .map(({ option }) => option);
}

const CANONICAL_REASONING_EFFORT_RANK: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  disable: 0,
  disabled: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  maximum: 6,
};

function reasoningEffortRank(id: string): number {
  const key = id.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (key === "extra high" || key === "x high") {
    return CANONICAL_REASONING_EFFORT_RANK.xhigh ?? 5;
  }
  return CANONICAL_REASONING_EFFORT_RANK[key] ?? Number.POSITIVE_INFINITY;
}

/**
 * The effort Traycer's `auto`-mode judge runs `modelSlug` at, as the option
 * the model's own catalog row advertises.
 *
 * The stored `requested` effort when the row still advertises it. Otherwise
 * the LOWEST the row advertises, by the rank above: a stage-1 verdict is a
 * short classification, and on Grok 4.7 the lowest effort measured 8 s per
 * call against 14 s at the model's own default, with the same verdicts.
 * `null` when the row advertises no efforts, or the catalog names no such
 * model - the host's adapter then applies nothing and the GUI names nothing.
 *
 * The row is found the way every other judge lookup finds it
 * ({@link resolveModelBySlug}): an entitlement-decorated catalog row whose
 * `metadata.resolvedModel` equals the stored slug is that model.
 */
export function effectiveJudgeReasoningEffort(
  models: ReadonlyArray<GuiAgentModelOption>,
  modelSlug: string,
  requested: string | null,
): AgentReasoningEffortOption | null {
  const row = readableModelMatch(resolveModelBySlug(models, modelSlug));
  if (row === null) return null;
  const advertised = sortReasoningEffortOptions(row.supportedReasoningEfforts);
  if (advertised.length === 0) return null;
  if (requested !== null) {
    const match = advertised.find((option) => option.id === requested);
    if (match !== undefined) return match;
  }
  return advertised[0] ?? null;
}
