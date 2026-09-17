/**
 * Docs: see `src/components/settings/SETTINGS.md`.
 * Update that file whenever this ranking changes.
 */
import {
  resortByNameTier,
  searchFuzzyMatches,
} from "@/lib/composer/fuzzy-ranking";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import type {
  SettingsSearchEntry,
  SettingsSearchEntryKind,
} from "@/lib/settings-search/settings-definitions";
import { SETTINGS_SEARCH_ENTRIES } from "@/lib/settings-search/settings-search-entries";
import {
  SETTINGS_SECTION_GROUPS,
  visibleSettingsSections,
  type SettingsSectionId,
} from "@/lib/settings-sections";

/**
 * How many hits the result list shows.
 *
 * The list is scrollable, so this is not a layout limit — it is a relevance
 * one. Fuse's threshold is deliberately loose (see `fuzzy-ranking.ts`) so that
 * "brnch prefx" still lands, and the cost of a loose threshold is a long tail
 * of rows that merely share letters with the query. Past a dozen, that tail is
 * all a user is scrolling through.
 */
const MAX_RESULTS = 12;

/**
 * A flattened entry, which is what Fuse actually reads.
 *
 * Fuse resolves keys by path and treats a `null` as a miss for that key, which
 * is fine, but it also means every optional field would need a null check at
 * every call site that renders a match. Flattening to `""` once here keeps the
 * search keys uniform and leaves the nullable shape where it belongs — on the
 * entry, which the UI reads for its breadcrumb.
 *
 * `sectionLabel` and `scopeLabel` are denormalized from the section registry
 * rather than stored per entry: they are facts about the SECTION, and ~110
 * copies of "Application" would be ~110 chances for one of them to go stale
 * when a section moves group.
 */
interface SettingsSearchDocument {
  readonly entry: SettingsSearchEntry;
  readonly label: string;
  readonly keywords: ReadonlyArray<string>;
  readonly description: string;
  readonly group: string;
  readonly sectionLabel: string;
  readonly scopeLabel: string;
}

export interface SettingsSearchResult {
  readonly entry: SettingsSearchEntry;
  /** The page's own name, for the result's breadcrumb. */
  readonly sectionLabel: string;
  /** "Application" / "Account" / "Host" — which scope the page belongs to. */
  readonly scopeLabel: string;
}

/**
 * Field weights, in the order a person would rank them if asked.
 *
 * The label is what the row calls itself, so it dominates. Keywords come next
 * because they exist precisely for the queries the label cannot answer
 * ("dark mode", "proxy") — but under the label, so a row NAMED for the query
 * always beats a row that merely lists it. Group and section names are
 * scope words: they should let "terminal cursor" and "appearance font" work as
 * two-word queries without letting the section name alone drag its whole page
 * of rows into the results. The description is last: it is a sentence, and a
 * sentence shares words with almost any query.
 */
const SEARCH_KEYS: Array<{ name: string; weight: number }> = [
  { name: "label", weight: 1 },
  { name: "keywords", weight: 0.55 },
  { name: "group", weight: 0.25 },
  { name: "sectionLabel", weight: 0.2 },
  { name: "scopeLabel", weight: 0.12 },
  { name: "description", weight: 0.12 },
];

/**
 * A nudge, not a rule — Fuse scores run 0 (perfect) to 1 (worst), and these
 * shave a fraction off the more specific kinds.
 *
 * When a query matches a row and the page containing it about equally well,
 * the row is the better answer: it is what the user came to change, and it
 * still carries the page's name in its breadcrumb, so nothing is lost by
 * ranking it first. The factors are tiny on purpose. A page whose own name is
 * the query ("Appearance") outscores its rows by far more than 4%, so it stays
 * on top; these only decide the near-ties.
 */
const KIND_SCORE_FACTOR: Readonly<Record<SettingsSearchEntryKind, number>> = {
  setting: 0.96,
  group: 0.98,
  section: 1,
};

/**
 * The searchable index for THIS shell.
 *
 * Filtered twice, for the same reason each time — a hit that navigates to
 * something the current build will not draw is a dead end with no way back:
 * by `visibleSettingsSections()` (the mobile app offers no Keybindings or
 * Link-mobile page), exactly as the sidebar and the command palette filter,
 * and then per entry by its `availableWhen` — the same predicate the panel
 * calls to decide whether the entry's element renders at all.
 *
 * Rebuilt per search rather than cached: the context is an argument, ~90
 * entries is nothing, and a cache keyed on it would be a second thing to
 * reason about for no measurable gain.
 */
function buildSearchDocuments(
  context: SettingsAvailabilityContext,
): ReadonlyArray<SettingsSearchDocument> {
  const sections = visibleSettingsSections();
  const scopeLabelByGroupId = new Map(
    SETTINGS_SECTION_GROUPS.map((group) => [group.id, group.label]),
  );
  const documents: Array<SettingsSearchDocument> = [];
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    if (!entry.availableWhen(context)) continue;
    const section = sections.find(
      (candidate) => candidate.id === entry.section,
    );
    if (section === undefined) continue;
    documents.push({
      entry,
      label: entry.label,
      keywords: entry.keywords,
      description: entry.description ?? "",
      group: entry.group ?? "",
      sectionLabel: section.label,
      scopeLabel: scopeLabelByGroupId.get(section.group) ?? "",
    });
  }
  return documents;
}

/**
 * Whether a query is asking for anything. The one definition of "searching",
 * and it lives beside the search rather than beside the input: the sidebar and
 * the search component both have to agree on it, and a component file that
 * also exports a plain function loses fast refresh for its components.
 */
export function isSettingsSearchActive(query: string): boolean {
  return query.trim().length > 0;
}

/**
 * Rank the index against `query`, best first.
 *
 * An empty or whitespace-only query returns nothing rather than everything:
 * the caller shows its normal section list in that state, and "no query" is
 * not a search with 110 equally good answers.
 */
export function searchSettings(
  query: string,
  context: SettingsAvailabilityContext,
): ReadonlyArray<SettingsSearchResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const matches = searchFuzzyMatches(
    buildSearchDocuments(context),
    trimmed,
    SEARCH_KEYS,
    (document, score) => score * KIND_SCORE_FACTOR[document.entry.kind],
  );
  return resortByNameTier(matches, trimmed, (document) => document.label)
    .slice(0, MAX_RESULTS)
    .map((match) => ({
      entry: match.item.entry,
      sectionLabel: match.item.sectionLabel,
      scopeLabel: match.item.scopeLabel,
    }));
}

/**
 * A stable React key / test id for one result.
 *
 * The section alone is not unique (a page contributes many entries) and the
 * label alone is not either — "Theme" is both a group and the row inside it,
 * "Diagnostics" is two different pages, and "Terminal" appears under both
 * Appearance and Opening behavior. Section + anchor is unique by construction,
 * and the label closes the remaining gap for the anchorless entries that share
 * a page (Providers' seven concept rows).
 */
export function settingsSearchResultKey(entry: SettingsSearchEntry): string {
  return `${entry.section}:${entry.anchor ?? entry.label}`;
}

/** Every section id the index can send a user to — for the drift test. */
export function indexedSettingsSectionIds(): ReadonlySet<SettingsSectionId> {
  return new Set(SETTINGS_SEARCH_ENTRIES.map((entry) => entry.section));
}
