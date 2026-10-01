import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import {
  LAYOUT_REGION_LIST,
  regionStateWord,
  type AnyGrammarRow,
} from "@/components/layout-editor/regions/region-facts";
import {
  SURFACE_GROUPS,
  type SurfaceGroupId,
} from "@/components/layout-editor/regions/region-grammar";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import type { HighlightRange } from "@/lib/git/path-highlight";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * Find a setting (L-07): one result per setting the query names, matched at
 * the START of a word, so "ring" finds "Ring only" and never "Sharing".
 */

/** Where `query` starts a word of `text`, as an inclusive range, or `null`. */
export function wordStartMatch(
  text: string,
  query: string,
): HighlightRange | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return null;
  const haystack = text.toLowerCase();
  for (
    let index = haystack.indexOf(needle);
    index >= 0;
    index = haystack.indexOf(needle, index + 1)
  ) {
    if (index === 0 || !/[\p{L}\p{N}]/u.test(haystack.charAt(index - 1)))
      return [index, index + needle.length - 1];
  }
  return null;
}

/** What a result's second line shows: the matched text, or the row's state. */
export interface LayoutFindDetail {
  readonly text: string;
  readonly match: HighlightRange | null;
}

export interface LayoutFindResult {
  readonly key: string;
  /** An area result names the area itself and opens it with nothing selected. */
  readonly kind: "area" | "setting";
  readonly area: SurfaceGroupId;
  /** The row the result opens expanded and selected, `null` for an area row. */
  readonly region: RegionId | null;
  /** The `data-settings-anchor` of an area's own row (Placement, Side). */
  readonly anchor: string | null;
  readonly label: string;
  readonly labelMatch: HighlightRange | null;
  readonly detail: LayoutFindDetail | null;
}

/**
 * Every area whose name the query matches, then every setting it matches:
 * name matches first, then options, state words and keywords, each in the
 * registry's reading order.
 */
export function layoutFindResults(
  query: string,
  snapshot: LayoutSnapshot,
): ReadonlyArray<LayoutFindResult> {
  if (query.trim().length === 0) return [];
  const values = effectiveLayoutValues(snapshot.basePreset, snapshot.overrides);
  const ranked: Array<{
    readonly rank: number;
    readonly result: LayoutFindResult;
  }> = [];
  const add = (
    rank: number | null,
    result: Omit<LayoutFindResult, "labelMatch">,
  ): void => {
    if (rank !== null)
      ranked.push({
        rank,
        result: { ...result, labelMatch: wordStartMatch(result.label, query) },
      });
  };

  for (const area of SURFACE_GROUPS) {
    add(wordStartMatch(area.label, query) === null ? null : -1, {
      key: `area:${area.id}`,
      kind: "area",
      area: area.id,
      region: null,
      anchor: null,
      label: area.label,
      detail: null,
    });
    const rows = Object.values(LAYOUT.definitions).filter(
      (definition) => definition.kind === "row" && definition.group === area.id,
    );
    for (const row of rows) {
      const keyword = firstMatch(row.keywords, query);
      add(rowRank(wordStartMatch(row.label, query) !== null, keyword), {
        key: row.key,
        kind: "setting",
        area: area.id,
        region: null,
        anchor: row.anchor,
        label: row.label,
        detail: keyword,
      });
    }
  }

  for (const region of LAYOUT_REGION_LIST) {
    const state = regionStateWord(region.id, values, snapshot.arrangement);
    const option = firstMatch(regionDetailLabels(region.id), query);
    const stateMatch = wordStartMatch(state, query);
    const keyword = firstMatch(region.keywords, query);
    const rank = regionRank(
      wordStartMatch(region.name, query) !== null,
      option,
      stateMatch,
      keyword,
    );
    add(rank, {
      key: region.id,
      kind: "setting",
      area: region.surface,
      region: region.id,
      anchor: null,
      label: region.name,
      detail: regionDetail(rank, option, keyword, {
        text: state,
        match: stateMatch,
      }),
    });
  }

  return ranked
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.result);
}

/** A row: its label first, then a keyword. */
function rowRank(
  labelHit: boolean,
  keyword: LayoutFindDetail | null,
): number | null {
  if (labelHit) return 0;
  return keyword === null ? null : 3;
}

/** A region: its name, then an option, its state word, then a keyword. */
function regionRank(
  nameHit: boolean,
  option: LayoutFindDetail | null,
  stateMatch: HighlightRange | null,
  keyword: LayoutFindDetail | null,
): number | null {
  if (nameHit) return 0;
  if (option !== null) return 1;
  if (stateMatch !== null) return 2;
  if (keyword !== null) return 3;
  return null;
}

/** What a region's result shows under its name: the text its rank matched. */
function regionDetail(
  rank: number | null,
  option: LayoutFindDetail | null,
  keyword: LayoutFindDetail | null,
  state: LayoutFindDetail,
): LayoutFindDetail | null {
  if (rank === 1) return option;
  if (rank === 3) return keyword;
  return state;
}

function firstMatch(
  texts: ReadonlyArray<string>,
  query: string,
): LayoutFindDetail | null {
  for (const text of texts) {
    const match = wordStartMatch(text, query);
    if (match !== null) return { text, match };
  }
  return null;
}

/**
 * The words inside a region's details: a detail row's label, a Style
 * example's name, or any option a detail control offers ("Ring only",
 * "Remaining", "Cache read").
 */
function regionDetailLabels(region: RegionId): ReadonlyArray<string> {
  const rows: ReadonlyArray<AnyGrammarRow> = LAYOUT_REGIONS[region].rows;
  return rows.flatMap((row): ReadonlyArray<string> => {
    if (row.kind === "style")
      return [row.label, ...row.examples.map((example) => example.label)];
    if (row.kind !== "fine-tune") return [];
    return row.rows.flatMap((detail) => [
      detail.label,
      ...(detail.control.kind === "switch"
        ? []
        : detail.control.options.map((option) => option.label)),
    ]);
  });
}
