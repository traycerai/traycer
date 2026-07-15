import "../../../../__tests__/test-browser-apis";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { VirtuosoHandle } from "react-virtuoso";
import { BundleDiffFindRegistrationProvider } from "@/components/diff/bundle-diff-find-registration";
import {
  useBundleDiffFindNavigation,
  useBundleDiffFindRegistrationContext,
  useRegisterBundleDiffTileFindAdapter,
  type BundleDiffTileFindRenderer,
} from "@/components/diff/bundle-diff-find-registration-hooks";
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import {
  useTileFindStore,
  type BundleDiffFindFileInput,
  type BundleDiffFindLoadedPatchInput,
  type TileFindStateSnapshot,
} from "@/stores/tile-find";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

const NODE: EpicCanvasTileRef = {
  id: "bundle-node",
  instanceId: "bundle-instance",
  name: "Bundle",
  hostId: "host-1",
  repositoryContext: null,
  type: "git-diff",
  diff: {
    kind: "bundle",
    runningDir: "/repo",
    bundleGroup: "changes",
  },
  view: { collapsedFilePaths: [] },
};

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-const label = 'OldName';",
  "+const label = 'NewName';",
  "",
].join("\n");

const FILES: ReadonlyArray<BundleDiffFindFileInput> = [
  {
    id: "app",
    filePath: "src/app.ts",
    coverageState: "unloaded",
    metadataUnits: [
      {
        id: "app-metadata",
        filePath: "src/app.ts",
        scopeId: "app",
        text: "app.ts src metadata",
      },
    ],
  },
];

const LOADED_PATCH: BundleDiffFindLoadedPatchInput = {
  fileId: "app",
  patch: PATCH,
  cacheKey: "loaded-app",
  isTruncated: false,
};

function Harness(props: {
  readonly contentIdentity: string;
  readonly registerPatch: boolean;
}): ReactNode {
  const renderer = useMemo<BundleDiffTileFindRenderer>(
    () => ({
      reveal: () => "painted",
      clear: vi.fn(),
      setRootElement: vi.fn(),
      repaintMountedSection: vi.fn(),
    }),
    [],
  );
  const context = useRegisterBundleDiffTileFindAdapter({
    tileInstanceId: NODE.instanceId,
    tileKind: "git-diff",
    files: FILES,
    contentIdentity: props.contentIdentity,
    renderer,
    sourceOverride: null,
  });

  return (
    <BundleDiffFindRegistrationProvider value={context}>
      {props.registerPatch ? <PatchRegistrar entry={LOADED_PATCH} /> : null}
    </BundleDiffFindRegistrationProvider>
  );
}

function PatchRegistrar(props: {
  readonly entry: BundleDiffFindLoadedPatchInput;
}): ReactNode {
  const context = useBundleDiffFindRegistrationContext();
  useEffect(() => {
    context.registerLoadedPatch(props.entry);
  }, [context, props.entry]);
  return null;
}

function renderHarness(props: {
  readonly contentIdentity: string;
  readonly registerPatch: boolean;
}) {
  return render(
    <TileFindScope
      node={NODE}
      viewTabId="view-1"
      tileId="tile-1"
      epicId="epic-1"
      isActive
    >
      <Harness
        contentIdentity={props.contentIdentity}
        registerPatch={props.registerPatch}
      />
    </TileFindScope>,
  );
}

describe("bundle diff find registration", () => {
  afterEach(() => {
    cleanup();
    useTileFindStore.getState().resetForTests();
  });

  it("keeps loaded patches searchable after row unmount and clears on identity change", async () => {
    const rendered = renderHarness({
      contentIdentity: "identity:one",
      registerPatch: true,
    });

    await waitFor(() => {
      expect(tileSnapshot()).toMatchObject({ status: "ready" });
    });
    search("NewName");
    expect(tileSnapshot()).toMatchObject({
      status: "ready",
      total: 1,
      coverageMessage: null,
    });

    rendered.rerender(
      <TileFindScope
        node={NODE}
        viewTabId="view-1"
        tileId="tile-1"
        epicId="epic-1"
        isActive
      >
        <Harness contentIdentity="identity:one" registerPatch={false} />
      </TileFindScope>,
    );
    await waitFor(() => {
      search("NewName");
      expect(tileSnapshot()).toMatchObject({
        status: "ready",
        total: 1,
      });
    });

    rendered.rerender(
      <TileFindScope
        node={NODE}
        viewTabId="view-1"
        tileId="tile-1"
        epicId="epic-1"
        isActive
      >
        <Harness contentIdentity="identity:two" registerPatch={false} />
      </TileFindScope>,
    );
    await waitFor(() => {
      search("NewName");
      expect(tileSnapshot()).toMatchObject({
        status: "partial",
        total: 0,
      });
    });
    expect(tileSnapshot().coverageMessage).toContain("1 unloaded file was");
  });
});

function search(query: string): void {
  act(() => {
    const store = useTileFindStore.getState();
    store.openForTile(NODE.instanceId);
    store.setQuery(NODE.instanceId, query);
    store.search(NODE.instanceId);
  });
}

function tileSnapshot(): TileFindStateSnapshot {
  const snapshot =
    useTileFindStore.getState().uiByTileInstanceId[NODE.instanceId]
      ?.lastSnapshot;
  if (snapshot === undefined) {
    throw new Error("Missing bundle find snapshot");
  }
  return snapshot;
}

// --- Navigation tests: exercise the real useBundleDiffFindNavigation reveal +
// repaint AND the real registration/source path (no sourceOverride), so a
// section mount that wrongly recreated the source (the fixed bug) would be
// caught. Loaded patches are registered independently of which sections are
// mounted, mirroring the retained-after-unmount model. The canonical 4-line
// hunk parses the addition line to unified/split index "2,1". ---

const ACTIVE_ATTR = "data-traycer-diff-find-active";
const MATCH_ATTR = "data-traycer-diff-find-match";
const ADDITION_LINE = "2,1";
const NO_COLLAPSED: ReadonlySet<string> = new Set<string>();

interface NavSection {
  readonly fileId: string;
  readonly lineIndex: string;
}

let scrollIntoViewSpy: Mock;
let originalScrollIntoView: PropertyDescriptor | undefined;

function navPatch(args: {
  readonly path: string;
  readonly needle: string;
}): string {
  return [
    `diff --git a/${args.path} b/${args.path}`,
    `--- a/${args.path}`,
    `+++ b/${args.path}`,
    "@@ -1,4 +1,4 @@ function greet",
    " const keep = true;",
    "-const x = 'OldName';",
    `+const x = '${args.needle}';`,
    " export const value = x;",
    "",
  ].join("\n");
}

function navFileInput(args: {
  readonly id: string;
  readonly path: string;
}): BundleDiffFindFileInput {
  return {
    id: args.id,
    filePath: args.path,
    coverageState: null,
    metadataUnits: [
      {
        id: `meta:${args.id}`,
        filePath: args.path,
        scopeId: args.id,
        text: `${args.path} metadata`,
      },
    ],
  };
}

function navLoadedPatch(args: {
  readonly fileId: string;
  readonly path: string;
  readonly needle: string;
}): BundleDiffFindLoadedPatchInput {
  return {
    fileId: args.fileId,
    patch: navPatch({ path: args.path, needle: args.needle }),
    cacheKey: `nav:${args.fileId}`,
    isTruncated: false,
  };
}

// "Needle" matches the addition line in each file; one match per file.
const TWO_FILE_INPUTS: ReadonlyArray<BundleDiffFindFileInput> = [
  navFileInput({ id: "app", path: "src/app.ts" }),
  navFileInput({ id: "lib", path: "src/lib.ts" }),
];
const TWO_LOADED_PATCHES: ReadonlyArray<BundleDiffFindLoadedPatchInput> = [
  navLoadedPatch({ fileId: "app", path: "src/app.ts", needle: "appNeedle" }),
  navLoadedPatch({ fileId: "lib", path: "src/lib.ts", needle: "libNeedle" }),
];
const ONE_FILE_INPUT: ReadonlyArray<BundleDiffFindFileInput> = [
  navFileInput({ id: "app", path: "src/app.ts" }),
];
const ONE_LOADED_PATCH: ReadonlyArray<BundleDiffFindLoadedPatchInput> = [
  navLoadedPatch({ fileId: "app", path: "src/app.ts", needle: "appNeedle" }),
];

function makeVirtuosoHandle(scrollIntoView: Mock): VirtuosoHandle {
  return {
    autoscrollToBottom: vi.fn(),
    getState: vi.fn(),
    scrollBy: vi.fn(),
    scrollIntoView,
    scrollTo: vi.fn(),
    scrollToIndex: vi.fn(),
  };
}

// Builds a faithful section DOM (a `diffs-container` custom element whose shadow
// root holds one `data-line-index` row) and fires the mount signal — mirroring
// what a real virtualized BundleFileSection does on mount.
function FauxBundleSection(props: NavSection): ReactNode {
  const context = useBundleDiffFindRegistrationContext();
  const sectionRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = sectionRef.current;
    if (element === null) return undefined;
    const container = document.createElement("diffs-container");
    // `diffs-container` is a registered custom element that attaches its own
    // open shadow root in its constructor; reuse it rather than re-attaching.
    const shadow =
      container.shadowRoot ?? container.attachShadow({ mode: "open" });
    const additions = document.createElement("div");
    additions.setAttribute("data-additions", "");
    const row = document.createElement("code");
    row.setAttribute("data-line-index", props.lineIndex);
    additions.appendChild(row);
    shadow.appendChild(additions);
    element.appendChild(container);
    context.notifySectionMounted(props.fileId);
    return () => {
      container.remove();
    };
  }, [context, props.fileId, props.lineIndex]);
  return <div data-bundle-diff-file-id={props.fileId} ref={sectionRef} />;
}

// Registers loaded patches once, independent of section mounting, so the match
// set survives a section being virtualized (unmounted).
function NavPatchRegistrar(props: {
  readonly patches: ReadonlyArray<BundleDiffFindLoadedPatchInput>;
}): ReactNode {
  const context = useBundleDiffFindRegistrationContext();
  useEffect(() => {
    props.patches.forEach((patch) => context.registerLoadedPatch(patch));
  }, [context, props.patches]);
  return null;
}

function NavHarness(props: {
  readonly files: ReadonlyArray<BundleDiffFindFileInput>;
  readonly loadedPatches: ReadonlyArray<BundleDiffFindLoadedPatchInput>;
  readonly collapsedFileIds: ReadonlySet<string>;
  readonly expandFile: (fileId: string) => void;
  readonly virtuosoRef: RefObject<VirtuosoHandle | null>;
  readonly sections: ReadonlyArray<NavSection>;
}): ReactNode {
  const renderer = useBundleDiffFindNavigation({
    files: props.files,
    collapsedFileIds: props.collapsedFileIds,
    expandFile: props.expandFile,
    virtuosoRef: props.virtuosoRef,
  });
  const setRootElement = useCallback(
    (element: HTMLDivElement | null): void => {
      renderer.setRootElement(element);
    },
    [renderer],
  );
  const context = useRegisterBundleDiffTileFindAdapter({
    tileInstanceId: NODE.instanceId,
    tileKind: "git-diff",
    files: props.files,
    contentIdentity: "nav-identity",
    renderer,
    sourceOverride: null,
  });
  return (
    <BundleDiffFindRegistrationProvider value={context}>
      <NavPatchRegistrar patches={props.loadedPatches} />
      <div ref={setRootElement}>
        {props.sections.map((section) => (
          <FauxBundleSection
            key={section.fileId}
            fileId={section.fileId}
            lineIndex={section.lineIndex}
          />
        ))}
      </div>
    </BundleDiffFindRegistrationProvider>
  );
}

function navTree(props: {
  readonly files: ReadonlyArray<BundleDiffFindFileInput>;
  readonly loadedPatches: ReadonlyArray<BundleDiffFindLoadedPatchInput>;
  readonly collapsedFileIds: ReadonlySet<string>;
  readonly expandFile: (fileId: string) => void;
  readonly virtuosoRef: RefObject<VirtuosoHandle | null>;
  readonly sections: ReadonlyArray<NavSection>;
}): ReactNode {
  return (
    <TileFindScope
      node={NODE}
      viewTabId="view-1"
      tileId="tile-1"
      epicId="epic-1"
      isActive
    >
      <NavHarness
        files={props.files}
        loadedPatches={props.loadedPatches}
        collapsedFileIds={props.collapsedFileIds}
        expandFile={props.expandFile}
        virtuosoRef={props.virtuosoRef}
        sections={props.sections}
      />
    </TileFindScope>
  );
}

function navSearch(query: string): void {
  act(() => {
    const store = useTileFindStore.getState();
    store.openForTile(NODE.instanceId);
    store.setQuery(NODE.instanceId, query);
    store.search(NODE.instanceId);
  });
}

function goNext(): void {
  act(() => {
    useTileFindStore.getState().next(NODE.instanceId);
  });
}

function goPrevious(): void {
  act(() => {
    useTileFindStore.getState().previous(NODE.instanceId);
  });
}

function closeFind(): void {
  act(() => {
    useTileFindStore.getState().close(NODE.instanceId);
  });
}

function sectionActiveRow(
  fileId: string,
  lineIndex: string,
): HTMLElement | null {
  const section =
    Array.from(document.querySelectorAll("[data-bundle-diff-file-id]")).find(
      (element) => element.getAttribute("data-bundle-diff-file-id") === fileId,
    ) ?? null;
  const container = section?.querySelector("diffs-container") ?? null;
  const shadow = container instanceof HTMLElement ? container.shadowRoot : null;
  const row = shadow?.querySelector(`[data-line-index="${lineIndex}"]`) ?? null;
  return row instanceof HTMLElement ? row : null;
}

describe("bundle diff find navigation", () => {
  beforeEach(() => {
    originalScrollIntoView = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    scrollIntoViewSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewSpy;
  });

  afterEach(() => {
    cleanup();
    useTileFindStore.getState().resetForTests();
    if (originalScrollIntoView === undefined) {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    } else {
      Object.defineProperty(
        Element.prototype,
        "scrollIntoView",
        originalScrollIntoView,
      );
    }
  });

  it("keeps the active match and viewport when another section mounts after navigation", async () => {
    const virtuosoSpy = vi.fn();
    const virtuosoRef: RefObject<VirtuosoHandle | null> = {
      current: makeVirtuosoHandle(virtuosoSpy),
    };
    const expandFile = vi.fn();
    // The lib section is mounted; the app section starts virtualized and will
    // mount mid-navigation (what Virtuoso does while scrolling).
    const rendered = render(
      navTree({
        files: TWO_FILE_INPUTS,
        loadedPatches: TWO_LOADED_PATCHES,
        collapsedFileIds: NO_COLLAPSED,
        expandFile,
        virtuosoRef,
        sections: [{ fileId: "lib", lineIndex: ADDITION_LINE }],
      }),
    );

    await waitFor(() => {
      navSearch("Needle");
      expect(tileSnapshot().total).toBe(2);
    });
    expect(tileSnapshot().current).toBe(1);

    goNext();
    expect(tileSnapshot().current).toBe(2);

    // The app section mounts (Virtuoso row mount). It is not the active match's
    // section, so it must not reset the active match or move the viewport.
    virtuosoSpy.mockClear();
    scrollIntoViewSpy.mockClear();
    rendered.rerender(
      navTree({
        files: TWO_FILE_INPUTS,
        loadedPatches: TWO_LOADED_PATCHES,
        collapsedFileIds: NO_COLLAPSED,
        expandFile,
        virtuosoRef,
        sections: [
          { fileId: "app", lineIndex: ADDITION_LINE },
          { fileId: "lib", lineIndex: ADDITION_LINE },
        ],
      }),
    );

    expect(tileSnapshot().current).toBe(2);
    expect(virtuosoSpy).not.toHaveBeenCalled();
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });

  it("paints a previously-pending active highlight once its section mounts, without scrolling", async () => {
    const virtuosoSpy = vi.fn();
    const virtuosoRef: RefObject<VirtuosoHandle | null> = {
      current: makeVirtuosoHandle(virtuosoSpy),
    };
    const expandFile = vi.fn();
    const rendered = render(
      navTree({
        files: TWO_FILE_INPUTS,
        loadedPatches: TWO_LOADED_PATCHES,
        collapsedFileIds: NO_COLLAPSED,
        expandFile,
        virtuosoRef,
        // The lib section starts virtualized (unmounted), so reveal can only
        // report "pending" for the lib match.
        sections: [{ fileId: "app", lineIndex: ADDITION_LINE }],
      }),
    );

    await waitFor(() => {
      navSearch("Needle");
      expect(tileSnapshot().total).toBe(2);
    });
    goNext();
    expect(tileSnapshot().current).toBe(2);
    expect(sectionActiveRow("lib", ADDITION_LINE)).toBeNull();

    // Now Virtuoso mounts the lib section. The retained active highlight should
    // paint in place, with no scroll and no change to the active position.
    virtuosoSpy.mockClear();
    scrollIntoViewSpy.mockClear();
    rendered.rerender(
      navTree({
        files: TWO_FILE_INPUTS,
        loadedPatches: TWO_LOADED_PATCHES,
        collapsedFileIds: NO_COLLAPSED,
        expandFile,
        virtuosoRef,
        sections: [
          { fileId: "app", lineIndex: ADDITION_LINE },
          { fileId: "lib", lineIndex: ADDITION_LINE },
        ],
      }),
    );

    const libRow = sectionActiveRow("lib", ADDITION_LINE);
    expect(libRow?.hasAttribute(ACTIVE_ATTR)).toBe(true);
    expect(libRow?.hasAttribute(MATCH_ATTR)).toBe(true);
    expect(tileSnapshot().current).toBe(2);
    expect(virtuosoSpy).not.toHaveBeenCalled();
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });

  it("finds mounted bundle sections whose file ids contain selector syntax", async () => {
    const fileId = 'src/weird"]\\\\\nfile';
    const path = "src/weird.ts";
    const files: ReadonlyArray<BundleDiffFindFileInput> = [
      navFileInput({ id: fileId, path }),
    ];
    const patches: ReadonlyArray<BundleDiffFindLoadedPatchInput> = [
      navLoadedPatch({ fileId, path, needle: "weirdNeedle" }),
    ];
    const virtuosoSpy = vi.fn();
    const virtuosoRef: RefObject<VirtuosoHandle | null> = {
      current: makeVirtuosoHandle(virtuosoSpy),
    };
    render(
      navTree({
        files,
        loadedPatches: patches,
        collapsedFileIds: NO_COLLAPSED,
        expandFile: vi.fn(),
        virtuosoRef,
        sections: [{ fileId, lineIndex: ADDITION_LINE }],
      }),
    );

    await waitFor(() => {
      navSearch("weirdNeedle");
      expect(tileSnapshot().total).toBe(1);
    });

    const activeRow = sectionActiveRow(fileId, ADDITION_LINE);
    expect(tileSnapshot().current).toBe(1);
    expect(activeRow?.hasAttribute(ACTIVE_ATTR)).toBe(true);
    expect(activeRow?.hasAttribute(MATCH_ATTR)).toBe(true);
    expect(virtuosoSpy).toHaveBeenCalled();
    expect(scrollIntoViewSpy).toHaveBeenCalled();
  });

  it("does not repaint a stale highlight when a section remounts after the search closes", async () => {
    const virtuosoRef: RefObject<VirtuosoHandle | null> = {
      current: makeVirtuosoHandle(vi.fn()),
    };
    const expandFile = vi.fn();
    const baseSections: ReadonlyArray<NavSection> = [
      { fileId: "app", lineIndex: ADDITION_LINE },
      { fileId: "lib", lineIndex: ADDITION_LINE },
    ];
    const rendered = render(
      navTree({
        files: TWO_FILE_INPUTS,
        loadedPatches: TWO_LOADED_PATCHES,
        collapsedFileIds: NO_COLLAPSED,
        expandFile,
        virtuosoRef,
        sections: baseSections,
      }),
    );

    await waitFor(() => {
      navSearch("Needle");
      expect(tileSnapshot().total).toBe(2);
    });
    // app is the active match (current 1); its mounted row is painted.
    expect(tileSnapshot().current).toBe(1);
    expect(
      sectionActiveRow("app", ADDITION_LINE)?.hasAttribute(ACTIVE_ATTR),
    ).toBe(true);

    // Closing the bar clears the adapter -> renderer.clear(); both the DOM
    // highlight and the retained reveal state must be dropped.
    closeFind();
    expect(
      sectionActiveRow("app", ADDITION_LINE)?.hasAttribute(ACTIVE_ATTR),
    ).toBe(false);

    // Virtualize the app section away, then remount it (fires the mount signal).
    rendered.rerender(
      navTree({
        files: TWO_FILE_INPUTS,
        loadedPatches: TWO_LOADED_PATCHES,
        collapsedFileIds: NO_COLLAPSED,
        expandFile,
        virtuosoRef,
        sections: [{ fileId: "lib", lineIndex: ADDITION_LINE }],
      }),
    );
    rendered.rerender(
      navTree({
        files: TWO_FILE_INPUTS,
        loadedPatches: TWO_LOADED_PATCHES,
        collapsedFileIds: NO_COLLAPSED,
        expandFile,
        virtuosoRef,
        sections: baseSections,
      }),
    );

    // No ghost: the remounted app row must not be re-painted for a closed search.
    const remountedRow = sectionActiveRow("app", ADDITION_LINE);
    expect(remountedRow).not.toBeNull();
    expect(remountedRow?.hasAttribute(ACTIVE_ATTR)).toBe(false);
    expect(remountedRow?.hasAttribute(MATCH_ATTR)).toBe(false);
  });

  it("scrolls the target into view on user-initiated search and next/previous", async () => {
    const virtuosoSpy = vi.fn();
    const virtuosoRef: RefObject<VirtuosoHandle | null> = {
      current: makeVirtuosoHandle(virtuosoSpy),
    };
    render(
      navTree({
        files: TWO_FILE_INPUTS,
        loadedPatches: TWO_LOADED_PATCHES,
        collapsedFileIds: NO_COLLAPSED,
        expandFile: vi.fn(),
        virtuosoRef,
        sections: [
          { fileId: "app", lineIndex: ADDITION_LINE },
          { fileId: "lib", lineIndex: ADDITION_LINE },
        ],
      }),
    );

    await waitFor(() => {
      navSearch("Needle");
      expect(tileSnapshot().total).toBe(2);
    });
    expect(tileSnapshot().current).toBe(1);
    expect(scrollIntoViewSpy).toHaveBeenCalled();

    virtuosoSpy.mockClear();
    scrollIntoViewSpy.mockClear();
    goNext();
    expect(tileSnapshot().current).toBe(2);
    expect(virtuosoSpy).toHaveBeenCalled();
    expect(scrollIntoViewSpy).toHaveBeenCalled();

    scrollIntoViewSpy.mockClear();
    goPrevious();
    expect(tileSnapshot().current).toBe(1);
    expect(scrollIntoViewSpy).toHaveBeenCalled();
  });

  it("expands a collapsed file and scrolls on user-initiated navigation", async () => {
    const virtuosoSpy = vi.fn();
    const virtuosoRef: RefObject<VirtuosoHandle | null> = {
      current: makeVirtuosoHandle(virtuosoSpy),
    };
    const expandFile = vi.fn();
    render(
      navTree({
        files: ONE_FILE_INPUT,
        loadedPatches: ONE_LOADED_PATCH,
        collapsedFileIds: new Set<string>(["app"]),
        expandFile,
        virtuosoRef,
        sections: [{ fileId: "app", lineIndex: ADDITION_LINE }],
      }),
    );

    await waitFor(() => {
      navSearch("Needle");
      expect(tileSnapshot().total).toBe(1);
    });
    expect(tileSnapshot().current).toBe(1);
    expect(expandFile).toHaveBeenCalledWith("app");
    expect(virtuosoSpy).toHaveBeenCalled();
  });
});
