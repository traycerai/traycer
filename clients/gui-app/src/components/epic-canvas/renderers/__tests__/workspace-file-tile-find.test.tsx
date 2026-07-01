import "../../../../../__tests__/test-browser-apis";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import type { WorkspaceFileRef } from "@/stores/epics/canvas/types";
import {
  useTileFindStore,
  type TileFindStateSnapshot,
} from "@/stores/tile-find";

interface ReadFileState {
  readonly data:
    | {
        readonly content: string | null;
        readonly error: string | null;
        readonly truncated: boolean;
      }
    | undefined;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
}

interface FindTestState {
  activeHostId: string | null;
  reachability: {
    status: "checking" | "reachable" | "unreachable";
    hostLabel: string;
  };
  readFile: ReadFileState;
  syntaxHighlight: boolean;
}

class MockCssHighlight {
  readonly ranges: readonly Range[];

  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

const state = vi.hoisted((): FindTestState => ({
  activeHostId: "host-A",
  reachability: {
    status: "reachable",
    hostLabel: "Host A",
  },
  readFile: {
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
  },
  syntaxHighlight: false,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => state.activeHostId,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => state.reachability,
}));

vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => state.readFile,
}));

vi.mock("@/markdown/shiki-highlighter", () => ({
  useShikiHighlighter: () => ({
    highlighter: null,
    theme: "dark",
    themesVersion: 0,
  }),
  highlightCode: () => null,
}));

vi.mock("@/markdown/use-throttled-code-highlight", () => ({
  useThrottledCodeHighlight: (input: { readonly code: string }) => {
    if (!state.syntaxHighlight) return null;
    const lines = input.code.split("\n");
    let offset = 0;
    return (
      <>
        {lines.map((line) => {
          const key = `${offset}:${line}`;
          offset += line.length;
          const hasLineBreak = offset < input.code.length;
          if (hasLineBreak) offset += 1;
          return (
            <span key={key}>
              {line}
              {hasLineBreak ? "\n" : null}
            </span>
          );
        })}
      </>
    );
  },
}));

import { WorkspaceFileTile } from "../workspace-file-tile";
import { TabHostProvider } from "../../tab-host-provider";

const CODE_NODE: WorkspaceFileRef = {
  id: "workspace-file:host-A:/work/repo:src/index.ts",
  instanceId: "inst-file-index",
  type: "workspace-file",
  name: "index.ts",
  hostId: "host-A",
  workspacePath: "/work/repo",
  filePath: "src/index.ts",
};

const SECOND_CODE_NODE: WorkspaceFileRef = {
  id: "workspace-file:host-A:/work/repo:src/other.ts",
  instanceId: "inst-file-other",
  type: "workspace-file",
  name: "other.ts",
  hostId: "host-A",
  workspacePath: "/work/repo",
  filePath: "src/other.ts",
};

const MARKDOWN_NODE: WorkspaceFileRef = {
  id: "workspace-file:host-A:/work/repo:README.md",
  instanceId: "inst-file-readme",
  type: "workspace-file",
  name: "README.md",
  hostId: "host-A",
  workspacePath: "/work/repo",
  filePath: "README.md",
};

const highlightEntries = new Map<string, MockCssHighlight>();
const SOURCE_FIND_HIGHLIGHT_NAME_PREFIX = "traycer-source-find-match-";
const SOURCE_FIND_ACTIVE_HIGHLIGHT_NAME_PREFIX =
  "traycer-source-find-match-active-";

let originalCssDescriptor: PropertyDescriptor | undefined;
let originalWindowCssDescriptor: PropertyDescriptor | undefined;
let originalHighlightDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  state.activeHostId = "host-A";
  state.reachability = { status: "reachable", hostLabel: "Host A" };
  state.readFile = loadingReadFile();
  state.syntaxHighlight = false;
  installMockCssHighlights();
});

afterEach(() => {
  cleanup();
  useTileFindStore.getState().resetForTests();
  restoreProperty(globalThis, "CSS", originalCssDescriptor);
  restoreProperty(window, "CSS", originalWindowCssDescriptor);
  restoreProperty(globalThis, "Highlight", originalHighlightDescriptor);
  highlightEntries.clear();
});

describe("<WorkspaceFileTile /> tile find", () => {
  it("searches source text, navigates next and previous, respects match case, and clears line highlight", async () => {
    state.readFile = loadedReadFile("alpha\nBeta alpha\nALPHA", false);
    const { container } = renderTile(CODE_NODE);
    await waitForSearchable(CODE_NODE);

    searchTile(CODE_NODE, "alpha", false);

    await waitFor(() => {
      expect(tileSnapshot(CODE_NODE).total).toBe(3);
    });
    expect(tileSnapshot(CODE_NODE)).toMatchObject({
      status: "ready",
      current: 1,
      activeUnitId: "line:1",
      exactHighlight: "pending",
    });
    await waitFor(() => {
      expect(activeSourceLine(container)?.textContent).toBe("1");
    });

    act(() => {
      useTileFindStore.getState().next(CODE_NODE.instanceId);
    });

    expect(tileSnapshot(CODE_NODE)).toMatchObject({
      current: 2,
      activeUnitId: "line:2",
    });
    await waitFor(() => {
      expect(activeSourceLine(container)?.textContent).toBe("2");
      expect(
        activeSourceLine(container)?.getAttribute(
          "data-workspace-file-find-column",
        ),
      ).toBe("6");
    });

    act(() => {
      useTileFindStore.getState().previous(CODE_NODE.instanceId);
    });

    expect(tileSnapshot(CODE_NODE)).toMatchObject({
      current: 1,
      activeUnitId: "line:1",
    });

    searchTile(CODE_NODE, "alpha", true);

    expect(tileSnapshot(CODE_NODE)).toMatchObject({
      matchCase: true,
      total: 2,
      current: 1,
    });

    act(() => {
      useTileFindStore.getState().close(CODE_NODE.instanceId);
    });

    await waitFor(() => {
      expect(activeSourceLine(container)).toBeNull();
    });
  });

  it("paints distinct active and inactive spans for two matches on one source line", async () => {
    state.readFile = loadedReadFile("ab cd ab", false);
    renderTile(CODE_NODE);
    await waitForSearchable(CODE_NODE);

    searchTile(CODE_NODE, "ab", false);

    await waitFor(() => {
      expect(tileSnapshot(CODE_NODE).total).toBe(2);
    });
    expect(tileSnapshot(CODE_NODE)).toMatchObject({
      current: 1,
      activeUnitId: "line:1",
    });

    // Match 1 (offset 0) is active; match 2 (offset 6) is the inactive span.
    await waitFor(() => {
      expect(activeHighlightStartOffset()).toBe(0);
    });
    expect(activeHighlightEndOffset()).toBe(2);
    expect(inactiveHighlightStartOffsets()).toEqual([6]);

    act(() => {
      useTileFindStore.getState().next(CODE_NODE.instanceId);
    });

    expect(tileSnapshot(CODE_NODE)).toMatchObject({
      current: 2,
      activeUnitId: "line:1",
    });
    // Same line, but the active span moved to the second occurrence.
    await waitFor(() => {
      expect(activeHighlightStartOffset()).toBe(6);
    });
    expect(activeHighlightEndOffset()).toBe(8);
    expect(inactiveHighlightStartOffsets()).toEqual([0]);

    act(() => {
      useTileFindStore.getState().close(CODE_NODE.instanceId);
    });

    await waitFor(() => {
      expect(sourceHighlightKeys()).toHaveLength(0);
    });
  });

  it("keeps source highlights isolated between mounted file tiles", async () => {
    state.readFile = loadedReadFile("ab cd ab cd", false);
    renderTiles([CODE_NODE, SECOND_CODE_NODE]);
    await waitForSearchable(CODE_NODE);
    await waitForSearchable(SECOND_CODE_NODE);

    searchTile(CODE_NODE, "ab", false);
    searchTile(SECOND_CODE_NODE, "cd", false);

    await waitFor(() => {
      expect(sourceActiveHighlightTexts()).toEqual(["ab", "cd"]);
    });

    act(() => {
      useTileFindStore.getState().close(CODE_NODE.instanceId);
    });

    await waitFor(() => {
      expect(sourceActiveHighlightTexts()).toEqual(["cd"]);
    });
  });

  it("keeps CRLF source highlights aligned on the syntax-highlighted path", async () => {
    state.syntaxHighlight = true;
    state.readFile = loadedReadFile("foo\r\nbar\r\nbaz", false);
    renderTile(CODE_NODE);
    await waitForSearchable(CODE_NODE);

    searchTile(CODE_NODE, "baz", false);

    await waitFor(() => {
      expect(tileSnapshot(CODE_NODE).total).toBe(1);
    });
    await waitFor(() => {
      expect(activeHighlightText()).toBe("baz");
    });
  });

  it("searches the markdown preview root only and cleans up CSS highlights", async () => {
    state.readFile = loadedReadFile(
      "# Preview\n\nneedle one\n\nneedle two",
      false,
    );
    renderTileWithOutside(MARKDOWN_NODE, "needle outside the tile");
    await waitForSearchable(MARKDOWN_NODE);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByLabelText("README.md markdown preview");

    searchTile(MARKDOWN_NODE, "needle", false);

    await waitFor(() => {
      expect(tileSnapshot(MARKDOWN_NODE).total).toBe(2);
    });
    expect(tileSnapshot(MARKDOWN_NODE)).toMatchObject({
      status: "ready",
      current: 1,
      activeUnitId: "markdown-preview",
      exactHighlight: "painted",
    });
    expect(highlightEntries.get("traycer-find-match-active")).toBeDefined();

    act(() => {
      useTileFindStore.getState().close(MARKDOWN_NODE.instanceId);
    });

    await waitFor(() => {
      expect(highlightEntries.size).toBe(0);
    });
  });

  it("recomputes search results when the active markdown view changes", async () => {
    state.readFile = loadedReadFile("[Docs](target.md)\n\nvisible text", false);
    renderTile(MARKDOWN_NODE);
    await waitForSearchable(MARKDOWN_NODE);

    searchTile(MARKDOWN_NODE, "target.md", false);

    expect(tileSnapshot(MARKDOWN_NODE)).toMatchObject({
      status: "ready",
      total: 1,
      activeUnitId: "line:1",
    });

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByLabelText("README.md markdown preview");

    await waitFor(() => {
      expect(tileSnapshot(MARKDOWN_NODE)).toMatchObject({
        status: "ready",
        total: 0,
        current: 0,
        activeUnitId: null,
      });
    });
  });

  it.each([
    {
      label: "loading",
      readFile: loadingReadFile(),
      coverageMessage: "File is still loading.",
    },
    {
      label: "error",
      readFile: errorReadFile("Permission denied"),
      coverageMessage: "Permission denied",
    },
    {
      label: "missing",
      readFile: missingReadFile(),
      coverageMessage: "File content is unavailable.",
    },
  ])("reports $label content as unavailable", async (scenario) => {
    state.readFile = scenario.readFile;
    renderTile(CODE_NODE);
    await waitForSnapshot(CODE_NODE, scenario.coverageMessage);
    searchTile(CODE_NODE, "needle", false);
    expect(tileSnapshot(CODE_NODE)).toMatchObject({
      status: "unavailable",
      coverageMessage: scenario.coverageMessage,
      total: 0,
    });
  });

  it("reports truncated loaded content as partial coverage", async () => {
    state.readFile = loadedReadFile("needle\nneedle", true);
    renderTile(CODE_NODE);
    await waitForSearchable(CODE_NODE);

    searchTile(CODE_NODE, "needle", false);

    expect(tileSnapshot(CODE_NODE)).toMatchObject({
      status: "partial",
      coverageMessage:
        "File preview is truncated. Search covers loaded content only.",
      total: 2,
      current: 1,
    });
  });
});

function loadedReadFile(content: string, truncated: boolean): ReadFileState {
  return {
    data: { content, error: null, truncated },
    isLoading: false,
    isError: false,
    error: null,
  };
}

function loadingReadFile(): ReadFileState {
  return {
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
  };
}

function errorReadFile(message: string): ReadFileState {
  return {
    data: { content: "", error: message, truncated: false },
    isLoading: false,
    isError: false,
    error: null,
  };
}

function missingReadFile(): ReadFileState {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  };
}

function renderTile(node: WorkspaceFileRef): RenderResult {
  return render(
    <TabHostProvider hostId="host-A">
      <TileFindScope
        node={node}
        viewTabId="tab-1"
        tileId="pane-1"
        epicId="epic-1"
        isActive
      >
        <WorkspaceFileTile node={node} viewTabId="tab-1" isActive />
      </TileFindScope>
    </TabHostProvider>,
  );
}

function renderTiles(nodes: readonly WorkspaceFileRef[]): RenderResult {
  return render(
    <TabHostProvider hostId="host-A">
      {nodes.map((node, index) => (
        <TileFindScope
          key={node.id}
          node={node}
          viewTabId={`tab-${index}`}
          tileId={`pane-${index}`}
          epicId="epic-1"
          isActive
        >
          <WorkspaceFileTile node={node} viewTabId={`tab-${index}`} isActive />
        </TileFindScope>
      ))}
    </TabHostProvider>,
  );
}

function renderTileWithOutside(
  node: WorkspaceFileRef,
  outsideText: string,
): RenderResult {
  return render(
    <div>
      <p>{outsideText}</p>
      <TabHostProvider hostId="host-A">
        <TileFindScope
          node={node}
          viewTabId="tab-1"
          tileId="pane-1"
          epicId="epic-1"
          isActive
        >
          <WorkspaceFileTile node={node} viewTabId="tab-1" isActive />
        </TileFindScope>
      </TabHostProvider>
    </div>,
  );
}

async function waitForSearchable(node: WorkspaceFileRef): Promise<void> {
  await waitFor(() => {
    expect(tileSnapshot(node).capabilities.has("find")).toBe(true);
  });
}

async function waitForSnapshot(
  node: WorkspaceFileRef,
  coverageMessage: string,
): Promise<void> {
  await waitFor(() => {
    expect(tileSnapshot(node).coverageMessage).toBe(coverageMessage);
  });
}

function searchTile(
  node: WorkspaceFileRef,
  query: string,
  matchCase: boolean,
): void {
  act(() => {
    const store = useTileFindStore.getState();
    store.openForTile(node.instanceId);
    store.setMatchCase(node.instanceId, matchCase);
    store.setQuery(node.instanceId, query);
    store.search(node.instanceId);
  });
}

function tileSnapshot(node: WorkspaceFileRef): TileFindStateSnapshot {
  const snapshot =
    useTileFindStore.getState().uiByTileInstanceId[node.instanceId]
      ?.lastSnapshot;
  if (snapshot === undefined) {
    throw new Error(`Missing tile find snapshot for ${node.instanceId}`);
  }
  return snapshot;
}

function activeSourceLine(container: HTMLElement): Element | null {
  return container.querySelector('[data-workspace-file-find-active="true"]');
}

function activeHighlightRange(): Range {
  const highlight = firstSourceActiveHighlight();
  if (highlight === undefined || highlight.ranges.length === 0) {
    throw new Error("Missing active find highlight range");
  }
  return highlight.ranges[0];
}

function activeHighlightStartOffset(): number {
  return activeHighlightRange().startOffset;
}

function activeHighlightEndOffset(): number {
  return activeHighlightRange().endOffset;
}

function activeHighlightText(): string {
  return activeHighlightRange().cloneContents().textContent;
}

function inactiveHighlightStartOffsets(): readonly number[] {
  const highlight = firstSourceInactiveHighlight();
  if (highlight === undefined) return [];
  return highlight.ranges.map((range) => range.startOffset);
}

function sourceActiveHighlightTexts(): readonly string[] {
  return sourceActiveHighlights()
    .filter((highlight) => highlight.ranges.length > 0)
    .map((highlight) => highlight.ranges[0].cloneContents().textContent)
    .sort();
}

function firstSourceActiveHighlight(): MockCssHighlight | undefined {
  return sourceActiveHighlights()[0];
}

function firstSourceInactiveHighlight(): MockCssHighlight | undefined {
  return Array.from(highlightEntries)
    .filter(([name]) => isSourceInactiveHighlightName(name))
    .map(([_name, highlight]) => highlight)[0];
}

function sourceActiveHighlights(): readonly MockCssHighlight[] {
  return Array.from(highlightEntries)
    .filter(([name]) =>
      name.startsWith(SOURCE_FIND_ACTIVE_HIGHLIGHT_NAME_PREFIX),
    )
    .map(([_name, highlight]) => highlight);
}

function sourceHighlightKeys(): readonly string[] {
  return Array.from(highlightEntries.keys()).filter((name) =>
    name.startsWith(SOURCE_FIND_HIGHLIGHT_NAME_PREFIX),
  );
}

function isSourceInactiveHighlightName(name: string): boolean {
  return (
    name.startsWith(SOURCE_FIND_HIGHLIGHT_NAME_PREFIX) &&
    !name.startsWith(SOURCE_FIND_ACTIVE_HIGHLIGHT_NAME_PREFIX)
  );
}

function installMockCssHighlights(): void {
  highlightEntries.clear();
  originalCssDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  originalWindowCssDescriptor = Object.getOwnPropertyDescriptor(window, "CSS");
  originalHighlightDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Highlight",
  );
  const highlights = {
    set: (name: string, highlight: MockCssHighlight): void => {
      highlightEntries.set(name, highlight);
    },
    delete: (name: string): void => {
      highlightEntries.delete(name);
    },
  };
  const css = { highlights };
  Object.defineProperty(globalThis, "Highlight", {
    configurable: true,
    writable: true,
    value: MockCssHighlight,
  });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: css,
  });
  Object.defineProperty(window, "CSS", {
    configurable: true,
    writable: true,
    value: css,
  });
}

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
    return;
  }
  Object.defineProperty(target, key, descriptor);
}
