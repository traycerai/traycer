import { create } from "zustand";

import type {
  GithubMentionRepository,
  GithubMentionRow,
  GithubMentionSection,
} from "@traycer/protocol/host/mention-schemas";

/**
 * Session-lived catalog rows per (scope, section) - the list ROOT search reads.
 *
 * Root search is cache-only by design: typing at `@` must never fan out a
 * GitHub call per keystroke, so it ranks whatever the last catalog read left
 * here. That read is a `refresh: "none"` call, which fetches nothing at all, so
 * a warmed host cache serves root search immediately after a restart while a
 * genuinely cold cache simply leaves this empty until a section is first
 * opened - exactly the cache-warming rule the flows describe.
 *
 * Deliberately NOT TanStack state: the rows outlive any one query observer
 * (the section unmounts when the menu closes) and are read by a code path that
 * issues no request of its own, which is the case Zustand is for here.
 */

interface GithubMentionCatalogStore {
  readonly rowsByKey: Readonly<Record<string, ReadonlyArray<GithubMentionRow>>>;
  /**
   * The scope's repositories, keyed by scope alone - they are a property of the
   * attached folders, not of a section.
   *
   * Stored beside the rows rather than read from the query, because the two
   * have different LIFETIMES: this store is session-lived while the TanStack
   * entries carry the default 5-minute `gcTime`. Past that window, root search
   * would serve rows from the warm store while the query answered `undefined`
   * for the scope - and a single-repo scope would silently start labelling its
   * chips `repo#123`. Both halves of a root-search row need one lifetime.
   */
  readonly repositoriesByScope: Readonly<
    Record<string, ReadonlyArray<GithubMentionRepository>>
  >;
  readonly setRows: (input: {
    readonly scopeKey: string;
    readonly section: GithubMentionSection;
    readonly rows: ReadonlyArray<GithubMentionRow>;
  }) => void;
  readonly setRepositories: (input: {
    readonly scopeKey: string;
    readonly repositories: ReadonlyArray<GithubMentionRepository>;
  }) => void;
  readonly resetForTests: () => void;
}

const EMPTY_ROWS: ReadonlyArray<GithubMentionRow> = [];
const EMPTY_REPOSITORIES: ReadonlyArray<GithubMentionRepository> = [];

function catalogKey(scopeKey: string, section: GithubMentionSection): string {
  return `${scopeKey}\x1f${section}`;
}

export const useGithubMentionCatalogStore = create<GithubMentionCatalogStore>()(
  (set) => ({
    rowsByKey: {},
    repositoriesByScope: {},
    setRows: ({ scopeKey, section, rows }) => {
      set((state) => {
        const key = catalogKey(scopeKey, section);
        if (state.rowsByKey[key] === rows) return state;
        return { rowsByKey: { ...state.rowsByKey, [key]: rows } };
      });
    },
    setRepositories: ({ scopeKey, repositories }) => {
      set((state) => {
        if (state.repositoriesByScope[scopeKey] === repositories) return state;
        return {
          repositoriesByScope: {
            ...state.repositoriesByScope,
            [scopeKey]: repositories,
          },
        };
      });
    },
    resetForTests: () => {
      set({ rowsByKey: {}, repositoriesByScope: {} });
    },
  }),
);

export function selectGithubMentionCatalogRows(
  state: GithubMentionCatalogStore,
  scopeKey: string,
  section: GithubMentionSection,
): ReadonlyArray<GithubMentionRow> {
  return state.rowsByKey[catalogKey(scopeKey, section)] ?? EMPTY_ROWS;
}

export function selectGithubMentionScopeRepositories(
  state: GithubMentionCatalogStore,
  scopeKey: string,
): ReadonlyArray<GithubMentionRepository> {
  return state.repositoriesByScope[scopeKey] ?? EMPTY_REPOSITORIES;
}
