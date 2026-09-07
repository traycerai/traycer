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

/** The composer's PR/Issue mention filters, sticky per (task, section). */

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

/** The bucket a composer WITHOUT a task writes into. */
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
          // Back to defaults is a DELETE, not a stored default: the funnel's dot is "a filter is active",
          // and a persisted row that happens to equal the default would be indistinguishable from a real one
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
      // Task-keyed rows persist; the landing composer's do not.
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
  // Coerced on the way out, not trusted as stored.
  return withGithubMentionSectionShape(section, state.filtersByKey[key]);
}

/**
 * A stored repository selection that is no longer in scope (the folder was detached, or the cache
 * has not warmed yet) must not silently hide every row.
 */
export function reconcileRepositorySelection(
  section: GithubMentionSection,
  filter: GithubMentionFilter,
  repositories: ReadonlyArray<GithubMentionRepository>,
): GithubMentionFilter {
  const selected = filter.repository;
  if (selected === null) return filter;
  // Case-insensitive, because the two sides have different provenance: the scope's entries are
  // parsed from the folder's configured remote, while a persisted selection may predate a remote
  const selectedKey = githubRepositoryIdentityKey(selected);
  const present = repositories.find(
    (repository) => githubRepositoryIdentityKey(repository) === selectedKey,
  );
  if (present !== undefined) {
    // A selection that IS the whole scope filters nothing, and the popover only renders the Repository
    // group for a multi-repository scope - so a scope shrinking onto the selected repository would
    if (repositories.length === 1) {
      return withGithubMentionRepository(section, filter, null);
    }
    if (present === selected) return filter;
    return withGithubMentionRepository(section, filter, present);
  }
  return withGithubMentionRepository(section, filter, null);
}

/**
 * The write-path complement of `reconcileRepositorySelection`, for edits made THROUGH the
 * reconciled projection.
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
