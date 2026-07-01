import "../../../../../__tests__/test-browser-apis";
import { act } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceFileRef } from "@/stores/epics/canvas/types";
import {
  setWorkspaceFileRevealTarget,
  useWorkspaceFileRevealStore,
} from "@/stores/epics/canvas/workspace-file-reveal-store";

interface RevealTestState {
  readFile: {
    data: { content: string; error: string | null; truncated: boolean };
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
  };
  reachability: { status: "reachable" | "unreachable"; hostLabel: string };
}

const state = vi.hoisted((): RevealTestState => ({
  readFile: {
    data: { content: "", error: null, truncated: false },
    isLoading: false,
    isError: false,
    error: null,
  },
  reachability: { status: "reachable", hostLabel: "Host A" },
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-A",
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

import { WorkspaceFileTile } from "../workspace-file-tile";
import { TabHostProvider } from "../../tab-host-provider";

const MARKDOWN_NODE: WorkspaceFileRef = {
  id: "workspace-file:host-A:/work/repo:NOTES.md",
  instanceId: "inst-notes",
  type: "workspace-file",
  name: "NOTES.md",
  hostId: "host-A",
  workspacePath: "/work/repo",
  filePath: "NOTES.md",
};

const CODE_NODE: WorkspaceFileRef = {
  id: "workspace-file:host-A:/work/repo:src/index.ts",
  instanceId: "inst-index",
  type: "workspace-file",
  name: "index.ts",
  hostId: "host-A",
  workspacePath: "/work/repo",
  filePath: "src/index.ts",
};

const TAB_1 = "tab-1";
const TAB_2 = "tab-2";

function renderTile(node: WorkspaceFileRef, viewTabId: string): void {
  render(
    <TabHostProvider hostId="host-A">
      <WorkspaceFileTile node={node} viewTabId={viewTabId} isActive />
    </TabHostProvider>,
  );
}

// Reveal entries are keyed by the NUL-joined `(viewTabId, contentId)` composite;
// mirror that here to assert per-tab scoping at the store boundary.
function revealEntry(viewTabId: string, contentId: string) {
  return useWorkspaceFileRevealStore.getState().targetsByKey[
    `${viewTabId}\u0000${contentId}`
  ];
}

function revealEntryCount(): number {
  return Object.keys(useWorkspaceFileRevealStore.getState().targetsByKey)
    .length;
}

let scrollIntoViewSpy: Mock;
let originalScrollIntoView: PropertyDescriptor | undefined;

beforeEach(() => {
  useWorkspaceFileRevealStore.setState({ targetsByKey: {} }, true);
  state.reachability = { status: "reachable", hostLabel: "Host A" };
  // jsdom does not implement scrollIntoView; install a spy so the reveal effect
  // can run and be observed. Capture the original property descriptor (read by
  // string key, so it doesn't trip the unbound-method lint) so teardown
  // restores it and the spy does not leak into later suites.
  originalScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView",
  );
  scrollIntoViewSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoViewSpy;
});

afterEach(() => {
  cleanup();
  if (originalScrollIntoView === undefined) {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  } else {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  }
  useWorkspaceFileRevealStore.setState({ targetsByKey: {} }, true);
});

describe("<WorkspaceFileTile /> line reveal", () => {
  it("scrolls to and consumes a line target on a code file", () => {
    state.readFile = {
      data: { content: "a\nb\nc\nd\ne", error: null, truncated: false },
      isLoading: false,
      isError: false,
      error: null,
    };
    setWorkspaceFileRevealTarget(TAB_1, CODE_NODE.id, 3, null);

    renderTile(CODE_NODE, TAB_1);

    // The targeted gutter row is scrolled into view and the one-shot target is
    // consumed (G4) so a later remount won't re-scroll a stale line.
    expect(scrollIntoViewSpy).toHaveBeenCalled();
    expect(revealEntry(TAB_1, CODE_NODE.id)).toBeUndefined();
  });

  it("does not move a second open preview of the same file in another tab (CL-6)", () => {
    state.readFile = {
      data: { content: "a\nb\nc\nd\ne", error: null, truncated: false },
      isLoading: false,
      isError: false,
      error: null,
    };
    // The same file is previewed in two tabs.
    renderTile(CODE_NODE, TAB_1);
    renderTile(CODE_NODE, TAB_2);

    // A `:line` click scoped to TAB_1 only.
    act(() => {
      setWorkspaceFileRevealTarget(TAB_1, CODE_NODE.id, 3, null);
    });

    // Exactly one tile (TAB_1's) reacts and scrolls; TAB_2's preview is left
    // alone and never had an entry written for it.
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
    expect(revealEntry(TAB_1, CODE_NODE.id)).toBeUndefined();
    expect(revealEntry(TAB_2, CODE_NODE.id)).toBeUndefined();

    // A later click scoped to TAB_2 moves only that preview.
    act(() => {
      setWorkspaceFileRevealTarget(TAB_2, CODE_NODE.id, 4, null);
    });
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(2);
  });

  it("forces source long enough to scroll a markdown file the user had on preview, then consumes the target and returns to preview", () => {
    state.readFile = {
      data: {
        content: "# Heading\n\nbody line\nmore body\nlast line",
        error: null,
        truncated: false,
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    renderTile(MARKDOWN_NODE, TAB_1);

    // User switches to rendered preview.
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy();

    // A line link arrives: source is forced (G5) so the code view mounts and the
    // row scrolls; the one-shot target is then consumed (G4). With the target
    // gone the view returns to the user's rendered preview - acceptable for the
    // rare markdown+preview+line case; code files (the common line target) only
    // ever have a source view.
    act(() => {
      setWorkspaceFileRevealTarget(TAB_1, MARKDOWN_NODE.id, 3, null);
    });

    expect(scrollIntoViewSpy).toHaveBeenCalled();
    expect(revealEntry(TAB_1, MARKDOWN_NODE.id)).toBeUndefined();
    expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy();
  });

  it("clamps a line target past end-of-file without throwing and consumes it", () => {
    state.readFile = {
      data: { content: "a\nb\nc", error: null, truncated: false },
      isLoading: false,
      isError: false,
      error: null,
    };
    setWorkspaceFileRevealTarget(TAB_1, CODE_NODE.id, 9999, null);

    expect(() => renderTile(CODE_NODE, TAB_1)).not.toThrow();

    expect(scrollIntoViewSpy).toHaveBeenCalled();
    expect(revealEntry(TAB_1, CODE_NODE.id)).toBeUndefined();
  });

  it("evicts a stranded target when the read settles into an error (CL-5)", () => {
    state.readFile = {
      data: { content: "", error: "Permission denied", truncated: false },
      isLoading: false,
      isError: false,
      error: null,
    };
    setWorkspaceFileRevealTarget(TAB_1, CODE_NODE.id, 3, null);

    renderTile(CODE_NODE, TAB_1);

    // The error body never mounts the consuming preview, so the tile clears the
    // entry itself rather than stranding it on the channel.
    expect(screen.getByText("Permission denied")).toBeTruthy();
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(revealEntry(TAB_1, CODE_NODE.id)).toBeUndefined();
    expect(revealEntryCount()).toBe(0);
  });

  it("evicts a stranded target on a dead (offline) tile (CL-5)", () => {
    state.reachability = { status: "unreachable", hostLabel: "Host A" };
    state.readFile = {
      data: { content: "a\nb\nc", error: null, truncated: false },
      isLoading: false,
      isError: false,
      error: null,
    };
    setWorkspaceFileRevealTarget(TAB_1, CODE_NODE.id, 3, null);

    renderTile(CODE_NODE, TAB_1);

    // The dead-tile banner returns before the live preview mounts; the outer
    // tile still evicts the entry so offline clicks don't strand it.
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(revealEntry(TAB_1, CODE_NODE.id)).toBeUndefined();
    expect(revealEntryCount()).toBe(0);
  });
});
