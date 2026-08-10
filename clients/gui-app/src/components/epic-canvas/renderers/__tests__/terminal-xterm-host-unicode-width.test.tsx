import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { TerminalXtermHost } from "@/components/epic-canvas/renderers/terminal-tile-xterm";
import {
  __disposeAllXtermHostsForTests,
  __getXtermHostEntryForTests,
} from "@/components/epic-canvas/renderers/xterm-host-registry";
import type { Terminal } from "@xterm/xterm";

const INSTANCE_ID = "unicode-width-instance";

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    openExternalLink: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock("@/lib/terminal-theme", () => ({
  useTerminalTheme: () => ({}),
}));

// The only part of a 2D context xterm's DOM-renderer WidthCache touches.
type MeasuringContext = {
  font: string;
  measureText: (text: string) => { readonly width: number };
};

// The shared setup stubs `getContext` to null, which is enough for components
// that skip drawing when there is no context - but the WidthCache is built
// during `open()` and throws on a null context. This suite needs a REAL
// `Terminal`, opened, so it measures real cell widths; monospace-ish text
// measurement is all the cache asks for.
beforeAll(() => {
  const measuringContext: MeasuringContext = {
    font: "",
    measureText: (text: string) => ({ width: text.length * 8 }),
  };
  const getContext = (contextId: string): MeasuringContext | null =>
    contextId === "2d" ? measuringContext : null;
  // `defineProperty` rather than assignment: the real `getContext` is a set of
  // overloads returning full context types, so no narrower function is
  // assignable to it without an assertion the type rules here rightly forbid.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: getContext,
  });
});

function renderHost(): void {
  render(
    <TerminalXtermHost
      sessionId="unicode-width-session"
      tileKind="terminal"
      instanceId={INSTANCE_ID}
      effectiveCols={40}
      effectiveRows={4}
      onUserInput={vi.fn()}
      onContainerResize={vi.fn()}
      onWriterReady={vi.fn()}
      shouldFocusOnActivePane={false}
      registerImperativeFocus
      findTargetId={null}
      keepAlive={false}
      chrome="padded"
      onTerminalReady={null}
    />,
  );
}

async function mountedTerminal(): Promise<Terminal> {
  renderHost();
  await waitFor(() => {
    expect(__getXtermHostEntryForTests(INSTANCE_ID)).not.toBeNull();
  });
  const entry = __getXtermHostEntryForTests(INSTANCE_ID);
  if (entry === null) throw new Error("xterm host engine was never created");
  return entry.term;
}

function write(term: Terminal, chunk: string): Promise<void> {
  return new Promise((resolve) => term.write(chunk, () => resolve()));
}

function lineText(term: Terminal, row: number): string {
  return term.buffer.active.getLine(row)?.translateToString(true) ?? "";
}

// The host advertises `TERM_PROGRAM=kitty` to TUI sessions, so chat TUIs
// (claude-code, codex) do their cursor math with string-width semantics, where
// U+2705 / U+274C are width 2. xterm defaults to the Unicode 6 tables, where
// they are width 1. These tests pin the renderer to the same width model the
// TUIs assume - see the Unicode11Addon comment in terminal-tile-xterm.tsx.
describe("<TerminalXtermHost /> emoji cell width", () => {
  afterEach(() => {
    cleanup();
    __disposeAllXtermHostsForTests();
  });

  it("advances the cursor two columns for an emoji the TUI counts as width 2", async () => {
    const term = await mountedTerminal();

    await write(term, "✅X");

    expect(term.buffer.active.cursorX).toBe(3);
  });

  it("keeps an incremental repaint aligned when the TUI positions with width-2 math", async () => {
    const term = await mountedTerminal();
    const row = "│ ✅ ok │ ❌ iterate │ end";
    // Where the TUI believes "iterate" starts: 13 columns of prefix counting
    // both emoji as width 2. It repaints that span with a RELATIVE move
    // (column 1, then cursor-forward), which is exactly what makes the drift
    // visible - one column per emoji if the grid disagrees about the width.
    const iterateColumnOffset = 13;

    await write(term, `\x1b[1;1H\x1b[2K${row}`);
    await write(term, `\x1b[1;1H\x1b[${iterateColumnOffset}CUPDATED`);

    expect(lineText(term, 0)).toBe("│ ✅ ok │ ❌ UPDATED │ end");
  });
});
