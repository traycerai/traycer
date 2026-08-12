import { create } from "zustand";
import { persist } from "zustand/middleware";

import type {
  GithubMentionSection,
  GithubMentionRepository,
} from "@traycer/protocol/host/mention-schemas";

import {
  defaultGithubMentionFilter,
  githubRepositoryIdentityKey,
  isDefaultGithubMentionFilter,
  withGithubMentionRepository,
  withGithubMentionSectionShape,
  type GithubMentionFilter,
} from "@/lib/composer/mentions/github-mention-rows";
import { basePersistOptions, githubMentionFiltersKey } from "@/lib/persist";

/**
 * The composer's PR/Issue mention filters, sticky per (task, section).
 *
 * A VIEW preference and nothing more: it is never round-tripped to the host,
 * and a composer without a task reads defaults every time (the "this task's own
 * PRs" bucket does not exist there, so a remembered narrowing would be a
 * preference carried in from somewhere it did not apply).
 *
 * Stored per epic rather than globally because the useful narrowing is
 * task-shaped - "review requested, in this repo" is an answer about the work in
 * front of you, not a global mode.
 */

interface GithubMentionFilterStore {
  readonly filtersByKey: Readonly<Record<string, GithubMentionFilter>>;
  readonly setFilter: (input: {
    /** Null is the landing composer - adjustable, but never persisted. */
    readonly epicId: string | null;
    readonly section: GithubMentionSection;
    readonly filter: GithubMentionFilter;
  }) => void;
  readonly resetForTests: () => void;
}

/**
 * The bucket a composer WITHOUT a task writes into.
 *
 * It is a real, adjustable bucket rather than a read-only default, because a
 * funnel that silently refuses every selection is a broken control, not a
 * simplification. It is excluded from persistence below, which is what makes
 * "composers without a task start from defaults" true across sessions while
 * still letting the user narrow the list in front of them right now.
 */
const LANDING_SCOPE = "\x00landing";

function storeKey(
  epicId: string | null,
  section: GithubMentionSection,
): string {
  return `${epicId ?? LANDING_SCOPE}\x1f${section}`;
}

function isLandingKey(key: string): boolean {
  return key.startsWith(`${LANDING_SCOPE}\x1f`);
}

export const useGithubMentionFilterStore = create<GithubMentionFilterStore>()(
  persist(
    (set) => ({
      filtersByKey: {},
      setFilter: ({ epicId, section, filter }) => {
        set((state) => {
          const key = storeKey(epicId, section);
          // Back to defaults is a DELETE, not a stored default: the funnel's
          // dot is "a filter is active", and a persisted row that happens to
          // equal the default would be indistinguishable from a real one the
          // next time the shape of "default" changes.
          if (isDefaultGithubMentionFilter(section, filter)) {
            if (!Object.hasOwn(state.filtersByKey, key)) return state;
            const next = { ...state.filtersByKey };
            delete next[key];
            return { filtersByKey: next };
          }
          return {
            filtersByKey: { ...state.filtersByKey, [key]: filter },
          };
        });
      },
      resetForTests: () => {
        set({ filtersByKey: {} });
      },
    }),
    {
      // Anonymous bucket until the lifecycle bridge retargets to the
      // signed-in identity; see GithubMentionFiltersPersistLifecycleBridge.
      ...basePersistOptions(githubMentionFiltersKey(null)),
      // Task-keyed rows persist; the landing composer's do not. Its filter is
      // adjustable for as long as that composer is on screen and starts from
      // defaults on the next launch - stickiness is keyed to the task, and
      // that composer has none to key to.
      partialize: (state) => ({
        filtersByKey: Object.fromEntries(
          Object.entries(state.filtersByKey).filter(
            ([key]) => !isLandingKey(key),
          ),
        ),
      }),
    },
  ),
);

/**
 * The filter to apply right now. A landing composer reads its own in-session
 * bucket, which starts empty on every launch because it is never persisted.
 */
export function selectGithubMentionFilter(
  state: GithubMentionFilterStore,
  epicId: string | null,
  section: GithubMentionSection,
): GithubMentionFilter {
  const key = storeKey(epicId, section);
  if (!Object.hasOwn(state.filtersByKey, key)) {
    return defaultGithubMentionFilter(section);
  }
  // Coerced on the way out, not trusted as stored. This bucket is persisted,
  // so its contents outlive the build that wrote them: a `state` or
  // `involvement` value that a later version renames or drops would otherwise
  // reach `filterGithubMentionRows` as an unrecognized qualifier and quietly
  // narrow the list to nothing. The coercions rebuild per section and carry
  // `repository` across by reference, so a live selection survives untouched.
  return withGithubMentionSectionShape(section, state.filtersByKey[key]);
}

/**
 * A stored repository selection that is no longer in scope (the folder was
 * detached, or the cache has not warmed yet) must not silently hide every row.
 * The filter falls back to "all repositories" for as long as the selection is
 * unrepresented, without forgetting it.
 */
export function reconcileRepositorySelection(
  section: GithubMentionSection,
  filter: GithubMentionFilter,
  repositories: ReadonlyArray<GithubMentionRepository>,
): GithubMentionFilter {
  const selected = filter.repository;
  if (selected === null) return filter;
  // Case-insensitive, because the two sides have different provenance: the
  // scope's entries are parsed from the folder's configured remote, while a
  // persisted selection may predate a remote being re-spelled. Matched
  // case-insensitively but kept VERBATIM as the scope's own entry, so every
  // downstream identity comparison (the popover's radio, the row filter's
  // key) sees one spelling.
  const selectedKey = githubRepositoryIdentityKey(selected);
  const present = repositories.find(
    (repository) => githubRepositoryIdentityKey(repository) === selectedKey,
  );
  if (present !== undefined) {
    // A selection that IS the whole scope filters nothing, and the popover
    // only renders the Repository group for a multi-repository scope - so a
    // scope shrinking onto the selected repository would otherwise leave the
    // funnel dot lit with no control able to clear it, and the stored
    // selection lying in wait to exclude the next repository attached.
    if (repositories.length === 1) {
      return withGithubMentionRepository(section, filter, null);
    }
    if (present === selected) return filter;
    return withGithubMentionRepository(section, filter, present);
  }
  return withGithubMentionRepository(section, filter, null);
}

/**
 * The write-path complement of `reconcileRepositorySelection`, for edits made
 * THROUGH the reconciled projection. The popover edits the reconciled filter
 * (that is what the list is applying, and what the funnel dot claims), but
 * reconcile nulls an out-of-scope selection as a DISPLAY fallback - so a
 * State or Involvement change written back verbatim would turn "remembered
 * while unrepresented" into a permanent delete, breaking the contract above.
 *
 * Only the unrepresented case restores. A selection the scope still contains
 * writes through as reconciled: the whole-scope null and the casing
 * normalization are both decisions reconcile is entitled to make durable.
 * The Repository group must NOT route its own writes through here - picking
 * "All repositories" while the old selection is out of scope is the user
 * explicitly clearing it, and restoring it over that click would make the
 * one control that manages the selection the one place it cannot be changed.
 */
export function restoreUnrepresentedRepositorySelection(
  section: GithubMentionSection,
  next: GithubMentionFilter,
  stored: GithubMentionRepository | null,
  repositories: ReadonlyArray<GithubMentionRepository>,
): GithubMentionFilter {
  if (stored === null) return next;
  const storedKey = githubRepositoryIdentityKey(stored);
  const represented = repositories.some(
    (repository) => githubRepositoryIdentityKey(repository) === storedKey,
  );
  if (represented) return next;
  return withGithubMentionRepository(section, next, stored);
}
