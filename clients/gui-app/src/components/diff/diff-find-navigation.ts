import { useCallback, useMemo, useRef } from "react";
import { queryElementsByDataAttribute } from "@/components/diff/data-attribute-lookup";
import type { DiffFindMatch, DiffFindUnit } from "@/lib/diff/diff-find";
import type { DiffTileFindRenderer } from "@/stores/tile-find";
import type { TileFindExactHighlight } from "@/stores/tile-find/types";

const DIFF_FIND_MATCH_ATTRIBUTE = "data-traycer-diff-find-match";
const DIFF_FIND_ACTIVE_ATTRIBUTE = "data-traycer-diff-find-active";
const DIFFS_CONTAINER_TAG_NAME = "diffs-container";

export interface DiffFindNavigationController extends DiffTileFindRenderer {
  readonly setScrollContainer: (element: HTMLDivElement | null) => void;
}

export function useDiffFindNavigation(): DiffFindNavigationController {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const clear = useCallback((): void => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer === null) return;
    clearDiffFindHighlights(scrollContainer);
  }, []);

  const setScrollContainer = useCallback(
    (element: HTMLDivElement | null): void => {
      if (element === null) clear();
      scrollContainerRef.current = element;
    },
    [clear],
  );

  const reveal = useCallback(
    (
      matches: ReadonlyArray<DiffFindMatch>,
      activeMatch: DiffFindMatch | null,
    ): TileFindExactHighlight => {
      const scrollContainer = scrollContainerRef.current;
      if (scrollContainer === null)
        return activeMatch === null ? "none" : "pending";
      return revealDiffFindMatches({
        scrollContainer,
        matches,
        activeMatch,
        scrollActiveIntoView: true,
      });
    },
    [],
  );

  return useMemo(
    () => ({
      setScrollContainer,
      reveal,
      clear,
    }),
    [clear, reveal, setScrollContainer],
  );
}

export function revealDiffFindMatches(args: {
  readonly scrollContainer: HTMLElement;
  readonly matches: ReadonlyArray<DiffFindMatch>;
  readonly activeMatch: DiffFindMatch | null;
  // User-initiated reveal (search/next/previous) scrolls the active match into
  // view; a section-mount repaint paints in place and passes `false` so a row
  // becoming available cannot yank the viewport.
  readonly scrollActiveIntoView: boolean;
}): TileFindExactHighlight {
  clearDiffFindHighlights(args.scrollContainer);
  if (args.activeMatch === null) return "none";

  const matchElements = args.matches.flatMap((match) =>
    findDiffUnitElements(args.scrollContainer, match.unit),
  );
  matchElements.forEach((element) => {
    element.setAttribute(DIFF_FIND_MATCH_ATTRIBUTE, "");
  });

  const activeElements = findDiffUnitElements(
    args.scrollContainer,
    args.activeMatch.unit,
  );
  activeElements.forEach((element) => {
    element.setAttribute(DIFF_FIND_ACTIVE_ATTRIBUTE, "");
  });

  const target = activeElements.at(0) ?? null;
  if (target === null) {
    if (args.activeMatch.unit.kind === "file") {
      if (args.scrollActiveIntoView) {
        args.scrollContainer.scrollTo({ top: 0, left: 0, behavior: "smooth" });
      }
      return "none";
    }
    return "pending";
  }

  if (args.scrollActiveIntoView) {
    target.scrollIntoView({ block: "center", inline: "nearest" });
  }
  return "painted";
}

export function clearDiffFindHighlights(scrollContainer: HTMLElement): void {
  const selector = `[${DIFF_FIND_MATCH_ATTRIBUTE}], [${DIFF_FIND_ACTIVE_ATTRIBUTE}]`;
  scrollContainer.querySelectorAll(selector).forEach((element) => {
    element.removeAttribute(DIFF_FIND_MATCH_ATTRIBUTE);
    element.removeAttribute(DIFF_FIND_ACTIVE_ATTRIBUTE);
  });
  diffShadowRoots(scrollContainer).forEach((shadowRoot) => {
    shadowRoot.querySelectorAll(selector).forEach((element) => {
      element.removeAttribute(DIFF_FIND_MATCH_ATTRIBUTE);
      element.removeAttribute(DIFF_FIND_ACTIVE_ATTRIBUTE);
    });
  });
}

function findDiffUnitElements(
  scrollContainer: HTMLElement,
  unit: DiffFindUnit,
): ReadonlyArray<HTMLElement> {
  if (unit.kind === "file") {
    // File-level (metadata) units have no paintable element today:
    // `data-diff-find-file` lives only on the bundle section root (excluded by
    // `querySelectorAll`) and single-file mode has no such element, so this
    // resolves nothing in either mode. It is kept so every unit kind flows
    // through one lookup; the empty result drives an honest `"none"` highlight
    // (navigation/scroll for file matches happens in the caller, not here).
    return queryElementsByDataAttribute({
      root: scrollContainer,
      attributeName: "data-diff-find-file",
      value: unit.filePath ?? "",
    });
  }

  const lineIndex = diffLineIndex(unit);
  if (lineIndex === null) return [];
  return diffShadowRoots(scrollContainer).flatMap((shadowRoot) =>
    findLineElementsInShadowRoot({
      shadowRoot,
      lineIndex,
      unit,
    }),
  );
}

function findLineElementsInShadowRoot(args: {
  readonly shadowRoot: ShadowRoot;
  readonly lineIndex: string;
  readonly unit: DiffFindUnit;
}): ReadonlyArray<HTMLElement> {
  const lineSelector = `[data-line-index="${attributeSelectorValue(args.lineIndex)}"]`;
  const sideSelectors = sideSelectorsForUnit(args.unit).map(
    (sideSelector) => `${sideSelector} ${lineSelector}`,
  );
  const selectors = [...sideSelectors, lineSelector];
  const elements = selectors.flatMap((selector) =>
    Array.from(args.shadowRoot.querySelectorAll(selector)),
  );
  const unique = new Set<HTMLElement>();
  elements.forEach((element) => {
    if (element instanceof HTMLElement) unique.add(element);
  });
  return Array.from(unique);
}

function sideSelectorsForUnit(unit: DiffFindUnit): ReadonlyArray<string> {
  if (unit.side === "additions") return ["[data-additions]", "[data-unified]"];
  if (unit.side === "deletions") return ["[data-deletions]", "[data-unified]"];
  if (unit.side === "context") {
    return ["[data-unified]", "[data-additions]", "[data-deletions]"];
  }
  return ["[data-unified]", "[data-additions]", "[data-deletions]"];
}

function diffShadowRoots(
  scrollContainer: HTMLElement,
): ReadonlyArray<ShadowRoot> {
  return Array.from(
    scrollContainer.querySelectorAll(DIFFS_CONTAINER_TAG_NAME),
  ).flatMap((element) => {
    if (!(element instanceof HTMLElement)) return [];
    return element.shadowRoot === null ? [] : [element.shadowRoot];
  });
}

function diffLineIndex(unit: DiffFindUnit): string | null {
  if (unit.unifiedLineIndex === null || unit.splitLineIndex === null) {
    return null;
  }
  return `${unit.unifiedLineIndex},${unit.splitLineIndex}`;
}

function attributeSelectorValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
