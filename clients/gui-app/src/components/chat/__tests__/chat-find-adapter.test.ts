import "../../../../__tests__/test-browser-apis";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChatFindAdapter,
  type ChatFindAdapter,
  type ChatFindReconcileTarget,
  type ChatFindRevealTarget,
  type ChatFindRow,
} from "@/components/chat/chat-find";
import type { ChatCollapsibleKey } from "@/components/chat/chat-collapsible-key";

class TestHighlight {
  readonly ranges: ReadonlyArray<Range>;

  constructor(...ranges: ReadonlyArray<Range>) {
    this.ranges = ranges;
  }
}

interface MockHighlightRegistry {
  readonly values: ReadonlyMap<string, TestHighlight>;
  readonly setCalls: ReadonlyArray<string>;
}

let restoreHighlights: (() => void) | null = null;
let restoreFrames: (() => void) | null = null;
const TILE_INSTANCE_ID = "chat-find-test-tile";

beforeEach(() => {
  restoreFrames = installFrameQueue();
});

afterEach(() => {
  restoreFrames?.();
  restoreFrames = null;
  restoreHighlights?.();
  restoreHighlights = null;
  vi.restoreAllMocks();
});

describe("chat find adapter", () => {
  it("counts projection matches and reports pending when the row is not mounted", () => {
    const revealMatch = vi.fn();
    const { adapter, setRows } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-a",
      revealMatch,
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });
    setRows([
      testRow("row-1", "unit-1", "alpha beta alpha"),
      testRow("row-2", "unit-2", "gamma"),
    ]);

    void adapter.search({ requestId: 1, query: "alpha", matchCase: false });

    expect(adapter.getSnapshot()).toMatchObject({
      requestId: 1,
      status: "ready",
      current: 1,
      total: 2,
      activeUnitId: "unit-1",
      exactHighlight: "pending",
    });
    expect(revealMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "row-1",
        unitId: "unit-1",
      }),
    );
  });

  it("scrolls to an offscreen match and paints after the row mounts", () => {
    const registry = installMockHighlights();
    const mountedRows = new Map<string, HTMLElement>();
    const { adapter, setRows } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-b",
      revealMatch: vi.fn(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: (messageId) => mountedRows.get(messageId) ?? null,
      getMountedUnitRoot: (messageId, unitId) =>
        mountedRows
          .get(messageId)
          ?.querySelector<HTMLElement>(`[data-unit-id="${unitId}"]`) ?? null,
    });
    setRows([
      testRow("visible-row", "visible-unit", "ordinary text"),
      testRow("offscreen-row", "offscreen-unit", "needle text"),
    ]);

    void adapter.search({ requestId: 2, query: "needle", matchCase: false });
    flushFrames();
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");

    const row = document.createElement("div");
    row.dataset.messageId = "offscreen-row";
    const unit = document.createElement("div");
    unit.dataset.unitId = "offscreen-unit";
    unit.textContent = "needle text";
    row.append(unit);
    mountedRows.set("offscreen-row", row);
    adapter.syncMountedHighlight();
    flushFrames();

    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
    const activeEntry = Array.from(registry.values.entries()).find(([name]) =>
      name.includes("active"),
    );
    expect(activeEntry).not.toBeUndefined();
    const activeRange = activeEntry?.[1].ranges[0];
    expect(activeRange?.startContainer.parentElement).toBe(unit);
  });

  it("paints visible content-bearing header text inside buttons", () => {
    const registry = installMockHighlights();
    const row = document.createElement("div");
    const trigger = document.createElement("button");
    trigger.dataset.findInclude = "true";
    const label = document.createElement("span");
    label.textContent = "Ran 1 command";
    trigger.append(label);
    const control = document.createElement("button");
    control.textContent = "Copy reply";
    row.append(trigger);
    row.append(control);
    const { adapter, setRows } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-header",
      revealMatch: (target) => target.paint(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => row,
      getMountedUnitRoot: () => trigger,
    });
    setRows([testRow("row-1", "header-unit", "Ran 1 command")]);

    void adapter.search({ requestId: 3, query: "Ran", matchCase: false });
    flushFrames();

    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
    const activeEntry = Array.from(registry.values.entries()).find(([name]) =>
      name.includes("active"),
    );
    expect(activeEntry).not.toBeUndefined();
    const activeRange = activeEntry?.[1].ranges[0];
    expect(activeRange?.startContainer.parentElement).toBe(label);

    setRows([testRow("row-1", "header-unit", "Ran 1 command Copy reply")]);
    void adapter.search({
      requestId: 4,
      query: "Copy reply",
      matchCase: false,
    });
    flushFrames();

    expect(adapter.getSnapshot().exactHighlight).toBe("pending");
  });

  it("scrolls the active match element into view on reveal but not on passive repaint", () => {
    installMockHighlights();
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const row = document.createElement("div");
    // Mirrors a subagent/A2A body: the unit anchor wraps a height-capped inner
    // scroll container, and the match sits below its fold.
    const unit = document.createElement("div");
    const matchLine = document.createElement("p");
    matchLine.textContent = "needle below the fold";
    unit.append(matchLine);
    row.append(unit);
    const { adapter, setRows } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-inner-scroll",
      revealMatch: (target) => target.paint(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => row,
      getMountedUnitRoot: () => unit,
    });
    setRows([testRow("row-1", "unit-1", "needle below the fold")]);

    void adapter.search({ requestId: 7, query: "needle", matchCase: false });
    flushFrames();

    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
    // Reveal scrolls the match's own element, walking every scroll ancestor
    // (the card's inner overflow-auto container included).
    expect(scrollIntoView.mock.instances).toContain(matchLine);

    // A passive re-sync (streaming/rendered-data change) repaints without
    // yanking the scroll position.
    scrollIntoView.mockClear();
    adapter.syncMountedHighlight();
    flushFrames();
    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps a missing exact DOM occurrence pending instead of clamping to another range", () => {
    const registry = installMockHighlights();
    const row = document.createElement("div");
    const unit = document.createElement("div");
    unit.textContent = "needle";
    row.append(unit);
    const { adapter, setRows } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-exact-occurrence",
      revealMatch: (target) => target.paint(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => row,
      getMountedUnitRoot: () => unit,
    });
    setRows([testRow("row-1", "unit-1", "needle needle")]);

    void adapter.search({ requestId: 5, query: "needle", matchCase: false });
    expect(adapter.getSnapshot().exactHighlight).toBe("painted");

    void adapter.next();

    expect(adapter.getSnapshot().exactHighlight).toBe("pending");
    const activeEntry = Array.from(registry.values.entries()).find(([name]) =>
      name.includes("active"),
    );
    expect(activeEntry).toBeUndefined();
  });

  it("can degrade a missing unit anchor to message-root paint when reveal falls back", () => {
    const registry = installMockHighlights();
    const row = document.createElement("div");
    row.textContent = "fallback needle";
    const { adapter, setRows } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-anchor-fallback",
      revealMatch: (target) => target.paintFallback(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => row,
      getMountedUnitRoot: () => null,
    });
    setRows([testRow("row-1", "missing-unit", "fallback needle")]);

    void adapter.search({
      requestId: 6,
      query: "needle",
      matchCase: false,
    });

    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
    const activeRange = Array.from(registry.values.entries()).find(([name]) =>
      name.includes("active"),
    )?.[1].ranges[0];
    expect(activeRange?.startContainer.parentElement).toBe(row);
  });

  it("paints the message-scoped occurrence when reveal degrades to message root", () => {
    const registry = installMockHighlights();
    const row = document.createElement("div");
    const earlier = document.createElement("p");
    earlier.textContent = "needle one";
    const target = document.createElement("p");
    target.textContent = "needle two";
    row.append(earlier);
    row.append(target);
    const { adapter, setRows } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-message-fallback",
      // The unit anchor never mounts, so every reveal degrades to the
      // message-root paint that walks BOTH units.
      revealMatch: (target_) => target_.paintFallback(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => row,
      getMountedUnitRoot: () => null,
    });
    setRows([
      {
        messageId: "row-1",
        units: [
          { unitId: "earlier-unit", text: "needle one", owningChain: [] },
          { unitId: "target-unit", text: "needle two", owningChain: [] },
        ],
      },
    ]);

    // First match: earlier unit, message occurrence 0 -> the first DOM range.
    void adapter.search({ requestId: 10, query: "needle", matchCase: false });
    expect(activeHighlightParent(registry)).toBe(earlier);

    // Second match: the target unit. Its per-unit ordinal is 0, but its
    // message-wide ordinal is 1 - the fallback must paint the SECOND DOM
    // occurrence, not re-highlight the earlier matching unit.
    void adapter.next();
    expect(adapter.getSnapshot()).toMatchObject({
      current: 2,
      total: 2,
      activeUnitId: "target-unit",
    });
    expect(activeHighlightParent(registry)).toBe(target);
  });

  it("prevents stale highlight work from overwriting a newer query", () => {
    installMockHighlights();
    const row = document.createElement("div");
    row.textContent = "old newer";
    const { adapter, setRows } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-c",
      revealMatch: (target) => {
        window.requestAnimationFrame(() => target.paint());
      },
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => row,
      getMountedUnitRoot: () => row,
    });
    setRows([testRow("row-1", "unit-1", "old newer")]);

    void adapter.search({ requestId: 1, query: "old", matchCase: false });
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");
    void adapter.search({ requestId: 2, query: "missing", matchCase: false });
    expect(adapter.getSnapshot()).toMatchObject({
      requestId: 2,
      query: "missing",
      total: 0,
      exactHighlight: "none",
    });
    flushFrames();

    expect(adapter.getSnapshot()).toMatchObject({
      requestId: 2,
      query: "missing",
      total: 0,
      exactHighlight: "none",
    });
  });

  it("preserves the active streaming match by unit occurrence as totals grow", () => {
    const revealMatch = vi.fn();
    const reconcileMatch = vi.fn();
    const chain = [testCollapsibleKey("subagent", "streaming-subagent")];
    const { adapter, setRows } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-streaming-identity",
      revealMatch,
      reconcileMatch,
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });
    setRows([
      testRowWithChain(
        "row-1",
        "streaming-unit",
        "prefix needle before needle active",
        chain,
      ),
    ]);
    void adapter.search({ requestId: 7, query: "needle", matchCase: false });
    void adapter.next();

    expect(adapter.getSnapshot()).toMatchObject({
      current: 2,
      total: 2,
      activeUnitId: "streaming-unit",
    });

    reconcileMatch.mockClear();
    setRows([
      testRowWithChain(
        "row-1",
        "streaming-unit",
        "prefix needle before inserted streaming text needle active needle tail",
        chain,
      ),
    ]);

    expect(adapter.getSnapshot()).toMatchObject({
      current: 2,
      total: 3,
      activeUnitId: "streaming-unit",
    });
    expect(reconcileMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "row-1",
        unitId: "streaming-unit",
        matchKey: "row-1:streaming-unit:1",
      }),
    );
    expect(revealMatch).toHaveBeenCalledTimes(2);
  });

  it("keeps the active match when a streamed query insert lands before it in a concatenated unit", () => {
    const revealMatch = vi.fn();
    const reconcileMatch = vi.fn();
    const chain = [testCollapsibleKey("subagent", "streaming-body")];
    const { adapter, setRows } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-streaming-insert",
      revealMatch,
      reconcileMatch,
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });
    // One concatenated body unit (task + progress + result). The only match is
    // the occurrence in the trailing "result" text.
    setRows([
      testRowWithChain(
        "row-1",
        "body-unit",
        "task line result needle here",
        chain,
      ),
    ]);
    void adapter.search({ requestId: 11, query: "needle", matchCase: false });
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 1,
      activeUnitId: "body-unit",
    });

    reconcileMatch.mockClear();
    // A streamed progress line containing the query streams in BEFORE the active
    // occurrence. Its per-unit ordinal shifts 0 -> 1, so the old exact-ordinal
    // identity would have yanked the active match onto the inserted occurrence.
    setRows([
      testRowWithChain(
        "row-1",
        "body-unit",
        "task line needle progress result needle here",
        chain,
      ),
    ]);

    // The active match stays on the original (now second) occurrence.
    expect(adapter.getSnapshot()).toMatchObject({
      current: 2,
      total: 2,
      activeUnitId: "body-unit",
    });
    expect(reconcileMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "row-1",
        unitId: "body-unit",
        matchKey: "row-1:body-unit:1",
      }),
    );
    // Streaming rescans reconcile in place; no second navigation occurs.
    expect(revealMatch).toHaveBeenCalledTimes(1);
  });

  it("reconciles an active chain change on rescan without navigating", () => {
    const revealMatch = vi.fn();
    const reconcileMatch = vi.fn();
    const { adapter, setRows } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-rescan-chain",
      revealMatch,
      reconcileMatch,
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });
    const firstChain = [testCollapsibleKey("activity-group", "activity:old")];
    const nextChain = [testCollapsibleKey("subagent", "promoted:subagent")];
    setRows([testRowWithChain("row-1", "unit-1", "needle", firstChain)]);
    void adapter.search({ requestId: 8, query: "needle", matchCase: false });

    revealMatch.mockClear();
    setRows([testRowWithChain("row-1", "unit-1", "needle", nextChain)]);

    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 1,
      activeUnitId: "unit-1",
    });
    expect(revealMatch).not.toHaveBeenCalled();
    expect(reconcileMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "row-1",
        unitId: "unit-1",
        owningChain: nextChain,
      }),
    );
  });

  it("reconciles to the fallback active match when the previous unit disappears", () => {
    const reconcileMatch = vi.fn();
    const { adapter, setRows } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-rescan-release",
      revealMatch: vi.fn(),
      reconcileMatch,
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });
    setRows([
      testRowWithChain("row-1", "removed-unit", "needle", [
        testCollapsibleKey("subagent", "removed-subagent"),
      ]),
      testRow("row-2", "visible-unit", "needle"),
    ]);
    void adapter.search({ requestId: 9, query: "needle", matchCase: false });

    reconcileMatch.mockClear();
    setRows([
      testRowWithChain("row-1", "removed-unit", "no remaining target", [
        testCollapsibleKey("subagent", "removed-subagent"),
      ]),
      testRow("row-2", "visible-unit", "needle"),
    ]);

    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 1,
      activeUnitId: "visible-unit",
    });
    expect(reconcileMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "row-2",
        unitId: "visible-unit",
        owningChain: [],
      }),
    );
  });

  it("ends scanning after clear so post-close streaming does no projection work", () => {
    const reconcileMatch = vi.fn();
    const { adapter, setRows, getRowsCalls } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-clear",
      revealMatch: vi.fn(),
      reconcileMatch,
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });
    setRows([testRow("row-1", "unit-1", "alpha beta alpha")]);
    void adapter.search({ requestId: 1, query: "alpha", matchCase: false });
    expect(adapter.getSnapshot().total).toBe(2);

    adapter.clear();
    expect(adapter.getSnapshot()).toMatchObject({
      query: "",
      total: 0,
      status: "idle",
    });

    reconcileMatch.mockClear();
    const closedGetRowsCalls = getRowsCalls();
    // Simulate streaming tokens after the bar closed: notifyRowsChanged runs
    // from a layout effect on every messages change. With scanning ended it
    // must neither pull rows from the supplier (no transcript projection /
    // markdown tokenization) nor re-run findMatches, so matches stay empty and
    // nothing is reconciled.
    setRows([
      testRow("row-1", "unit-1", "alpha alpha alpha"),
      testRow("row-2", "unit-2", "alpha"),
    ]);
    expect(adapter.getSnapshot().total).toBe(0);
    expect(adapter.getSnapshot().query).toBe("");
    expect(reconcileMatch).not.toHaveBeenCalled();
    // The closed-find fast path never invokes the row supplier.
    expect(getRowsCalls()).toBe(closedGetRowsCalls);

    // Reopening still works: a fresh search scans the current rows again.
    void adapter.search({ requestId: 2, query: "alpha", matchCase: false });
    expect(adapter.getSnapshot().total).toBe(4);
  });

  it("does not rebuild the projection on message changes while the bar is closed", () => {
    const { adapter, setRows, getRowsCalls } = createChatFindTestAdapter({
      tileInstanceId: "chat-tile-closed-projection",
      revealMatch: vi.fn(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });

    // The bar has never opened: every streaming message change must be free,
    // pulling no rows from the supplier.
    setRows([testRow("row-1", "unit-1", "alpha beta")]);
    setRows([testRow("row-1", "unit-1", "alpha beta gamma")]);
    setRows([testRow("row-1", "unit-1", "alpha beta gamma delta")]);
    expect(getRowsCalls()).toBe(0);
    expect(adapter.getSnapshot().total).toBe(0);

    // Opening the search is the first time rows are projected.
    void adapter.search({ requestId: 1, query: "alpha", matchCase: false });
    expect(getRowsCalls()).toBe(1);
    expect(adapter.getSnapshot().total).toBe(1);

    // While open, a streaming message change rebuilds rows once to rescan.
    setRows([testRow("row-1", "unit-1", "alpha beta gamma delta alpha")]);
    expect(getRowsCalls()).toBe(2);
    expect(adapter.getSnapshot().total).toBe(2);
  });
});

function activeHighlightParent(
  registry: MockHighlightRegistry,
): Element | null {
  const activeEntry = Array.from(registry.values.entries()).find(([name]) =>
    name.includes("active"),
  );
  return activeEntry?.[1].ranges[0]?.startContainer.parentElement ?? null;
}
function testRow(messageId: string, unitId: string, text: string): ChatFindRow {
  return testRowWithChain(messageId, unitId, text, []);
}

function testRowWithChain(
  messageId: string,
  unitId: string,
  text: string,
  owningChain: ReadonlyArray<ChatCollapsibleKey>,
): ChatFindRow {
  return {
    messageId,
    units: [
      {
        unitId,
        text,
        owningChain,
      },
    ],
  };
}

function testCollapsibleKey(
  kind: ChatCollapsibleKey["kind"],
  id: string,
): ChatCollapsibleKey {
  return {
    tileInstanceId: TILE_INSTANCE_ID,
    kind,
    id,
  };
}

interface ChatFindAdapterCallbacks {
  readonly tileInstanceId: string;
  readonly revealMatch: (target: ChatFindRevealTarget) => void;
  readonly reconcileMatch: (target: ChatFindReconcileTarget) => void;
  readonly clearReveal: () => void;
  readonly getMountedMessageRoot: (messageId: string) => HTMLElement | null;
  readonly getMountedUnitRoot: (
    messageId: string,
    unitId: string,
  ) => HTMLElement | null;
}

interface ChatFindTestAdapter {
  readonly adapter: ChatFindAdapter;
  // Publish a new transcript projection and notify the adapter, mirroring the
  // renderer's per-message layout effect. The adapter only rebuilds matches
  // while a find session is active, so this is a no-op for a closed bar.
  readonly setRows: (rows: ReadonlyArray<ChatFindRow>) => void;
  // Number of times the adapter has pulled rows from the supplier - used to
  // prove a closed find session does no projection work.
  readonly getRowsCalls: () => number;
}

function createChatFindTestAdapter(
  callbacks: ChatFindAdapterCallbacks,
): ChatFindTestAdapter {
  let rows: ReadonlyArray<ChatFindRow> = [];
  let getRowsCalls = 0;
  const adapter = createChatFindAdapter({
    tileInstanceId: callbacks.tileInstanceId,
    getRows: () => {
      getRowsCalls += 1;
      return rows;
    },
    revealMatch: callbacks.revealMatch,
    reconcileMatch: callbacks.reconcileMatch,
    clearReveal: callbacks.clearReveal,
    getMountedMessageRoot: callbacks.getMountedMessageRoot,
    getMountedUnitRoot: callbacks.getMountedUnitRoot,
  });
  return {
    adapter,
    setRows: (next) => {
      rows = next;
      adapter.notifyRowsChanged();
    },
    getRowsCalls: () => getRowsCalls,
  };
}

function installMockHighlights(): MockHighlightRegistry {
  const globalWithHighlights: {
    readonly CSS?: typeof CSS;
    readonly Highlight?: typeof Highlight;
  } = globalThis;
  const previousCss = globalWithHighlights.CSS;
  const previousHighlight = globalWithHighlights.Highlight;
  const values = new Map<string, TestHighlight>();
  const setCalls: string[] = [];
  Object.defineProperty(globalThis, "Highlight", {
    configurable: true,
    writable: true,
    value: TestHighlight,
  });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: {
      highlights: {
        set: (name: string, highlight: TestHighlight) => {
          setCalls.push(name);
          values.set(name, highlight);
        },
        delete: (name: string) => {
          values.delete(name);
        },
      },
    },
  });
  restoreHighlights = () => {
    if (previousCss === undefined) Reflect.deleteProperty(globalThis, "CSS");
    else {
      Object.defineProperty(globalThis, "CSS", {
        configurable: true,
        writable: true,
        value: previousCss,
      });
    }
    if (previousHighlight === undefined) {
      Reflect.deleteProperty(globalThis, "Highlight");
    } else {
      Object.defineProperty(globalThis, "Highlight", {
        configurable: true,
        writable: true,
        value: previousHighlight,
      });
    }
  };
  return { values, setCalls };
}

function installFrameQueue(): () => void {
  const frames: FrameRequestCallback[] = [];
  const request = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id) => {
      const index = id - 1;
      frames[index] = () => undefined;
    });
  flushFrames = () => {
    const pending = frames.splice(0, frames.length);
    pending.forEach((callback) => callback(performance.now()));
  };
  return () => {
    request.mockRestore();
    cancel.mockRestore();
    flushFrames = () => undefined;
  };
}

let flushFrames: () => void = () => undefined;
