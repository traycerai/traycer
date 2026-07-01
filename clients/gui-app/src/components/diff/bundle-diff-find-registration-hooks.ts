import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { queryElementByDataAttribute } from "@/components/diff/data-attribute-lookup";
import {
  clearDiffFindHighlights,
  revealDiffFindMatches,
} from "@/components/diff/diff-find-navigation";
import { useRegisterDiffTileFindAdapter } from "@/components/diff/use-register-diff-tile-find-adapter";
import {
  createBundleDiffFindSource,
  type BundleDiffFindCoverageState,
  type BundleDiffFindFileInput,
  type BundleDiffFindLoadedPatchInput,
  type DiffTileFindRenderer,
  type DiffTileFindSource,
} from "@/stores/tile-find";
import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import type { DiffFindMatch } from "@/lib/diff/diff-find";
import type { TileFindExactHighlight } from "@/stores/tile-find/types";

export interface BundleDiffFindFileNavigationInput {
  readonly id: string;
  readonly filePath: string;
}

// Bundle navigation extends the shared single-file renderer with two
// bundle-only affordances: a root element setter (the Virtuoso scroll
// container) and a no-scroll repaint driven when a virtualized section mounts.
// Single-file diff keeps using the plain `DiffTileFindRenderer` and never has
// to implement these.
export interface BundleDiffTileFindRenderer extends DiffTileFindRenderer {
  readonly setRootElement: (element: HTMLDivElement | null) => void;
  readonly repaintMountedSection: (fileId: string) => void;
}

export interface BundleDiffFindRegistrationContextValue {
  readonly notifySectionMounted: (fileId: string) => void;
  readonly registerCoverageState: (
    fileId: string,
    state: BundleDiffFindCoverageState,
  ) => void;
  readonly registerLoadedPatch: (entry: BundleDiffFindLoadedPatchInput) => void;
}

interface BundleDiffFindSessionState {
  readonly contentIdentity: string;
  readonly loadedPatches: ReadonlyMap<string, BundleDiffFindLoadedPatchInput>;
  readonly coverageByFileId: ReadonlyMap<string, BundleDiffFindCoverageState>;
}

const NOOP_CONTEXT: BundleDiffFindRegistrationContextValue = {
  notifySectionMounted: () => undefined,
  registerCoverageState: () => undefined,
  registerLoadedPatch: () => undefined,
};

export const BundleDiffFindRegistrationContext =
  createContext<BundleDiffFindRegistrationContextValue | null>(null);

export function useBundleDiffFindRegistrationContext(): BundleDiffFindRegistrationContextValue {
  return use(BundleDiffFindRegistrationContext) ?? NOOP_CONTEXT;
}

export function useRegisterBundleDiffTileFindAdapter(args: {
  readonly tileInstanceId: string;
  readonly tileKind: TileKindId;
  readonly files: ReadonlyArray<BundleDiffFindFileInput>;
  readonly contentIdentity: string;
  readonly renderer: BundleDiffTileFindRenderer;
  readonly sourceOverride: DiffTileFindSource | null;
}): BundleDiffFindRegistrationContextValue {
  const [session, setSession] = useState<BundleDiffFindSessionState>(() =>
    emptySession(args.contentIdentity),
  );
  const activeSession =
    session.contentIdentity === args.contentIdentity
      ? session
      : emptySession(args.contentIdentity);

  const files = useMemo(
    () =>
      args.files.map((file): BundleDiffFindFileInput => ({
        ...file,
        coverageState:
          activeSession.coverageByFileId.get(file.id) ?? file.coverageState,
      })),
    [activeSession.coverageByFileId, args.files],
  );
  const source = useMemo(() => {
    // A section mounting changes DOM availability, not the indexed text, so it
    // must NOT recreate the source (that would spawn a new adapter + replay and
    // reset the active match). The source recomputes only on genuine content
    // changes: `registerLoadedPatch` returns a fresh `loadedPatches` Map (a
    // direct dep) and `registerCoverageState` flows through the `files` memo.
    return (
      args.sourceOverride ??
      createBundleDiffFindSource({
        files,
        loadedPatches: activeSession.loadedPatches,
      }).source
    );
  }, [activeSession.loadedPatches, args.sourceOverride, files]);

  useRegisterDiffTileFindAdapter({
    tileInstanceId: args.tileInstanceId,
    tileKind: args.tileKind,
    source,
    renderer: args.renderer,
  });

  // Hold the latest renderer in a ref so `notifySectionMounted` stays
  // referentially stable. If it depended on the renderer object directly, the
  // registration context value would change on every collapse/expand, which
  // would re-fire the `registerLoadedPatch`/`registerCoverageState` effects.
  const rendererRef = useRef(args.renderer);
  useEffect(() => {
    rendererRef.current = args.renderer;
  }, [args.renderer]);

  const notifySectionMounted = useCallback((fileId: string): void => {
    rendererRef.current.repaintMountedSection(fileId);
  }, []);

  const registerCoverageState = useCallback(
    (fileId: string, state: BundleDiffFindCoverageState): void => {
      setSession((current) =>
        ensureSession(current, args.contentIdentity, (next) => {
          if (next.coverageByFileId.get(fileId) === state) return next;
          const coverageByFileId = new Map(next.coverageByFileId);
          coverageByFileId.set(fileId, state);
          return {
            ...next,
            coverageByFileId,
          };
        }),
      );
    },
    [args.contentIdentity],
  );

  const registerLoadedPatch = useCallback(
    (entry: BundleDiffFindLoadedPatchInput): void => {
      setSession((current) =>
        ensureSession(current, args.contentIdentity, (next) => {
          // Idempotent: a virtualized section remounting and re-registering an
          // identical patch must not churn `loadedPatches` identity (which the
          // source memo keys on), so bail when the entry is unchanged.
          const existing = next.loadedPatches.get(entry.fileId);
          if (
            existing !== undefined &&
            existing.patch === entry.patch &&
            existing.cacheKey === entry.cacheKey &&
            existing.isTruncated === entry.isTruncated
          ) {
            return next;
          }
          const loadedPatches = new Map(next.loadedPatches);
          loadedPatches.set(entry.fileId, entry);
          return {
            ...next,
            loadedPatches,
          };
        }),
      );
    },
    [args.contentIdentity],
  );

  return useMemo(
    () => ({
      notifySectionMounted,
      registerCoverageState,
      registerLoadedPatch,
    }),
    [notifySectionMounted, registerCoverageState, registerLoadedPatch],
  );
}

export function useBundleDiffFindNavigation(args: {
  readonly files: ReadonlyArray<BundleDiffFindFileNavigationInput>;
  readonly collapsedFileIds: ReadonlySet<string>;
  readonly expandFile: (fileId: string) => void;
  readonly virtuosoRef: RefObject<VirtuosoHandle | null>;
}): BundleDiffTileFindRenderer {
  const { collapsedFileIds, expandFile, files, virtuosoRef } = args;
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Retain the last revealed (matches, activeMatch) so a section that mounts
  // later can re-paint its highlight without re-running the search.
  const lastMatchesRef = useRef<ReadonlyArray<DiffFindMatch>>([]);
  const lastActiveMatchRef = useRef<DiffFindMatch | null>(null);
  const filesById = useMemo(
    () => new Map(files.map((file) => [file.id, file])),
    [files],
  );

  const setRootElement = useCallback((element: HTMLDivElement | null): void => {
    rootRef.current = element;
  }, []);

  const clear = useCallback((): void => {
    // Drop the retained reveal state so a later section mount cannot repaint a
    // ghost highlight for a search that is no longer active. Both the adapter's
    // clear() and the zero-match revealCurrent path funnel through here, so this
    // covers every "no active match" transition (clear, refine-to-zero, close).
    lastMatchesRef.current = [];
    lastActiveMatchRef.current = null;
    const root = rootRef.current;
    if (root === null) return;
    clearDiffFindHighlights(root);
  }, []);

  const reveal = useCallback(
    (
      matches: ReadonlyArray<DiffFindMatch>,
      activeMatch: DiffFindMatch | null,
    ): TileFindExactHighlight => {
      lastMatchesRef.current = matches;
      lastActiveMatchRef.current = activeMatch;
      const root = rootRef.current;
      if (root === null) return activeMatch === null ? "none" : "pending";
      clearDiffFindHighlights(root);
      if (activeMatch === null) return "none";

      const fileId = activeMatch.unit.scopeId;
      if (fileId === null) {
        return revealDiffFindMatches({
          scrollContainer: root,
          matches,
          activeMatch,
          scrollActiveIntoView: true,
        });
      }

      const file = filesById.get(fileId);
      if (file === undefined) return "none";
      if (collapsedFileIds.has(fileId)) expandFile(fileId);

      const fileIndex = files.findIndex((candidate) => candidate.id === fileId);
      if (fileIndex !== -1) {
        virtuosoRef.current?.scrollIntoView({
          index: fileIndex,
          behavior: "auto",
        });
      }

      const section = queryElementByDataAttribute({
        root,
        attributeName: "data-bundle-diff-file-id",
        value: fileId,
      });
      if (section === null) return "pending";

      const scopedMatches = matches.filter(
        (match) => match.unit.scopeId === fileId,
      );
      return revealDiffFindMatches({
        scrollContainer: section,
        matches: scopedMatches,
        activeMatch,
        scrollActiveIntoView: true,
      });
    },
    [collapsedFileIds, expandFile, files, filesById, virtuosoRef],
  );

  // Paint-only response to a section mount: re-reveal the retained highlight
  // for the section that owns the active match, WITHOUT scrolling or expanding.
  // Other sections were never painted (reveal scopes highlights to the active
  // file), so nothing to repaint there; the active position is left untouched.
  const repaintMountedSection = useCallback((fileId: string): void => {
    const root = rootRef.current;
    if (root === null) return;
    const activeMatch = lastActiveMatchRef.current;
    if (activeMatch === null || activeMatch.unit.scopeId !== fileId) return;

    const section = queryElementByDataAttribute({
      root,
      attributeName: "data-bundle-diff-file-id",
      value: fileId,
    });
    if (section === null) return;

    const scopedMatches = lastMatchesRef.current.filter(
      (match) => match.unit.scopeId === fileId,
    );
    revealDiffFindMatches({
      scrollContainer: section,
      matches: scopedMatches,
      activeMatch,
      scrollActiveIntoView: false,
    });
  }, []);

  return useMemo(
    () => ({
      setRootElement,
      clear,
      reveal,
      repaintMountedSection,
    }),
    [clear, reveal, repaintMountedSection, setRootElement],
  );
}

function emptySession(contentIdentity: string): BundleDiffFindSessionState {
  return {
    contentIdentity,
    loadedPatches: new Map(),
    coverageByFileId: new Map(),
  };
}

function ensureSession(
  current: BundleDiffFindSessionState,
  contentIdentity: string,
  update: (state: BundleDiffFindSessionState) => BundleDiffFindSessionState,
): BundleDiffFindSessionState {
  const state =
    current.contentIdentity === contentIdentity
      ? current
      : emptySession(contentIdentity);
  return update(state);
}
