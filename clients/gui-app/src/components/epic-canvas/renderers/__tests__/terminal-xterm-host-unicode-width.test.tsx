import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render as renderUi,
  type RenderResult,
  waitFor,
} from "@testing-library/react";
import { TerminalXtermHost } from "@/components/epic-canvas/renderers/terminal-tile-xterm";
import {
  __disposeAllXtermHostsForTests,
  __getXtermHostEntryForTests,
} from "@/components/epic-canvas/renderers/xterm-host-registry";
import type { Terminal } from "@xterm/xterm";
import type { ReactNode } from "react";
import { WithTestQueryClient } from "@/__tests__/with-test-query-client";

/**
 * Every link surface below reaches the external-link bridge mutation, which
 * needs a `QueryClientProvider` above it.
 */
function render(ui: ReactNode): RenderResult {
  return renderUi(ui, { wrapper: WithTestQueryClient });
}

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

beforeAll(() => {
  const measuringContext: MeasuringContext = {
    font: "",
    measureText: (text: string) => ({ width: text.length * 8 }),
  };
  const getContext = (contextId: string): MeasuringContext | null =>
    contextId === "2d" ? measuringContext : null;
  // `defineProperty` rather than assignment: the real `getContext` is a set of overloads returning full context types, so no narrower function is assignable to it without an assertion the type rules here rightly forbid.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: getContext,
  });
});

function renderHost(): void {
  render(
    <TerminalXtermHost
      sessionId="unicode-width-session"
      hostId="host-1"
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
    const iterateColumnOffset = 13;

    await write(term, `\x1b[1;1H\x1b[2K${row}`);
    await write(term, `\x1b[1;1H\x1b[${iterateColumnOffset}CUPDATED`);

    expect(lineText(term, 0)).toBe("│ ✅ ok │ ❌ UPDATED │ end");
  });
});
