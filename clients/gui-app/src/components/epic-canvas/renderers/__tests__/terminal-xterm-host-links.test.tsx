import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { TerminalXtermHost } from "@/components/epic-canvas/renderers/terminal-tile-xterm";
import { __disposeAllXtermHostsForTests } from "@/components/epic-canvas/renderers/xterm-host-registry";

type LinkActivate = (event: MouseEvent, uri: string) => void;

type CapturedOptions = {
  linkHandler?: { activate: LinkActivate };
};

type MockTerminalInstance = {
  readonly options: CapturedOptions;
  readonly scrollPages: Mock;
};

const xtermMocks = vi.hoisted(() => ({
  terminals: [] as MockTerminalInstance[],
  customKeyHandlers: [] as Array<(event: KeyboardEvent) => boolean>,
  webLinksHandlers: [] as LinkActivate[],
  openExternalLink: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    openExternalLink: xtermMocks.openExternalLink,
  }),
}));

vi.mock("@/lib/terminal-theme", () => ({
  useTerminalTheme: () => ({}),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    options: CapturedOptions & Record<string, unknown>;
    readonly buffer = { active: { baseY: 0, length: 24 } };
    readonly focus = vi.fn();
    readonly scrollPages = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      xtermMocks.terminals.push(this);
    }

    loadAddon(addon: { activate: (terminal: unknown) => void } | object): void {
      if ("activate" in addon && typeof addon.activate === "function") {
        addon.activate(this);
      }
    }

    open(_container: HTMLElement): void {}

    attachCustomKeyEventHandler(
      handler: (event: KeyboardEvent) => boolean,
    ): void {
      xtermMocks.customKeyHandlers.push(handler);
    }

    onData(_listener: (data: string) => void): { dispose: () => void } {
      return { dispose: vi.fn() };
    }

    onRender(_listener: () => void): { dispose: () => void } {
      return { dispose: vi.fn() };
    }

    write(_chunk: string): void {}

    resize(cols: number, rows: number): void {
      this.cols = cols;
      this.rows = rows;
    }

    refresh(_start: number, _end: number): void {}

    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class MockSearchAddon {
    readonly findNext = vi.fn(() => true);
    readonly findPrevious = vi.fn(() => true);
    readonly clearDecorations = vi.fn();

    onDidChangeResults(_listener: () => void): { dispose: () => void } {
      return { dispose: vi.fn() };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    proposeDimensions(): undefined {
      return undefined;
    }

    fit(): void {}
  },
}));

vi.mock("@xterm/addon-clipboard", () => ({
  ClipboardAddon: class MockClipboardAddon {},
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {
    constructor(handler: LinkActivate) {
      xtermMocks.webLinksHandlers.push(handler);
    }
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class MockWebglAddon {
    onContextLoss(_listener: () => void): { dispose: () => void } {
      return { dispose: vi.fn() };
    }

    clearTextureAtlas(): void {}

    dispose(): void {}
  },
}));

function renderHost(): void {
  render(
    <TerminalXtermHost
      sessionId="test-session"
      tileKind="terminal"
      instanceId="test-instance"
      effectiveCols={80}
      effectiveRows={24}
      onUserInput={vi.fn()}
      onContainerResize={vi.fn()}
      onWriterReady={vi.fn()}
      shouldFocusOnActivePane={false}
      findTargetId={null}
      keepAlive={false}
    />,
  );
}

describe("<TerminalXtermHost /> link handling", () => {
  afterEach(() => {
    cleanup();
    __disposeAllXtermHostsForTests();
    xtermMocks.terminals.length = 0;
    xtermMocks.customKeyHandlers.length = 0;
    xtermMocks.webLinksHandlers.length = 0;
    xtermMocks.openExternalLink.mockClear();
  });

  // OSC 8 hyperlinks (e.g. Codex's OAuth sign-in URL) flow through xterm's
  // built-in OscLinkProvider, which falls back to a dead `window.open` confirm
  // dialog unless `options.linkHandler` is set. Guard that we set it and route
  // it to the host browser.
  it("routes OSC 8 hyperlinks through the host browser via linkHandler", async () => {
    renderHost();

    await waitFor(() => {
      expect(xtermMocks.terminals[0]?.options.linkHandler).toBeDefined();
    });

    const linkHandler = xtermMocks.terminals[0].options.linkHandler;
    if (linkHandler === undefined) {
      throw new Error("OSC 8 linkHandler was not registered");
    }

    linkHandler.activate(
      new MouseEvent("click"),
      "https://auth.openai.com/oauth",
    );

    expect(xtermMocks.openExternalLink).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth",
    );
  });

  it("routes plain-text URLs through the host browser via WebLinksAddon", async () => {
    renderHost();

    await waitFor(() => {
      expect(xtermMocks.webLinksHandlers[0]).toBeDefined();
    });

    xtermMocks.webLinksHandlers[0](
      new MouseEvent("click"),
      "https://example.test/plain",
    );

    expect(xtermMocks.openExternalLink).toHaveBeenCalledWith(
      "https://example.test/plain",
    );
  });

  it("scrolls terminal history instead of sending Page Up and Page Down to the PTY", async () => {
    renderHost();

    await waitFor(() => {
      expect(xtermMocks.customKeyHandlers[0]).toBeDefined();
    });

    const handler = xtermMocks.customKeyHandlers[0];
    const pageUp = new KeyboardEvent("keydown", { key: "PageUp" });
    const pageDown = new KeyboardEvent("keydown", { key: "PageDown" });
    const preventPageUpDefault = vi.spyOn(pageUp, "preventDefault");
    const stopPageUpPropagation = vi.spyOn(pageUp, "stopPropagation");
    const preventPageDownDefault = vi.spyOn(pageDown, "preventDefault");
    const stopPageDownPropagation = vi.spyOn(pageDown, "stopPropagation");

    expect(handler(pageUp)).toBe(false);
    expect(handler(pageDown)).toBe(false);

    expect(xtermMocks.terminals[0].scrollPages).toHaveBeenNthCalledWith(1, -1);
    expect(xtermMocks.terminals[0].scrollPages).toHaveBeenNthCalledWith(2, 1);
    expect(preventPageUpDefault).toHaveBeenCalledTimes(1);
    expect(stopPageUpPropagation).toHaveBeenCalledTimes(1);
    expect(preventPageDownDefault).toHaveBeenCalledTimes(1);
    expect(stopPageDownPropagation).toHaveBeenCalledTimes(1);
  });
});
