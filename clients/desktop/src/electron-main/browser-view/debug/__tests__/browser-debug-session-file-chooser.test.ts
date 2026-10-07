import { describe, expect, it, vi } from "vitest";
import {
  createHarnessWith,
  type BrowserDebugSessionHarness,
  type RecordedCommand,
} from "./browser-debug-session-test-support";

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  describeLogError: (err: unknown) => String(err),
}));

const INTERCEPT = "Page.setInterceptFileChooserDialog";

function interceptCommands(
  harness: BrowserDebugSessionHarness,
): RecordedCommand[] {
  return harness.webContents.debugger.commands.filter(
    (command) => command.method === INTERCEPT,
  );
}

function sentMethods(harness: BrowserDebugSessionHarness): string[] {
  return harness.webContents.debugger.commands.map((command) => command.method);
}

describe("BrowserDebugSession file chooser interception", () => {
  it("intercepts once on enable when the tab is not on screen", async () => {
    const reading = { value: true };
    const harness = createHarnessWith({
      interceptFileChooser: () => reading.value,
    });

    await harness.session.acquire().ready();

    expect(interceptCommands(harness)).toEqual([
      { method: INTERCEPT, params: { enabled: true }, sessionId: undefined },
    ]);
  });

  it("sends nothing on enable when the tab is on screen", async () => {
    const harness = createHarnessWith({ interceptFileChooser: () => false });

    await harness.session.acquire().ready();

    const methods = sentMethods(harness);
    expect(methods).toContain("Page.enable");
    expect(methods).not.toContain(INTERCEPT);
  });

  it("sends only the edges of the reading", async () => {
    const reading = { value: true };
    const harness = createHarnessWith({
      interceptFileChooser: () => reading.value,
    });
    await harness.session.acquire().ready();
    expect(interceptCommands(harness)).toHaveLength(1);

    reading.value = false;
    harness.session.syncFileChooserInterception();
    expect(interceptCommands(harness).map((c) => c.params)).toEqual([
      { enabled: true },
      { enabled: false },
    ]);

    harness.session.syncFileChooserInterception();
    expect(interceptCommands(harness)).toHaveLength(2);

    reading.value = true;
    harness.session.syncFileChooserInterception();
    expect(interceptCommands(harness).map((c) => c.params)).toEqual([
      { enabled: true },
      { enabled: false },
      { enabled: true },
    ]);
  });

  it("sends nothing before a lease is ready", () => {
    const harness = createHarnessWith({ interceptFileChooser: () => true });

    harness.session.syncFileChooserInterception();

    expect(harness.webContents.debugger.commands).toEqual([]);
  });

  it("sends the command again after a detach and a fresh enable", async () => {
    const harness = createHarnessWith({ interceptFileChooser: () => true });
    const first = harness.session.acquire();
    await first.ready();
    expect(interceptCommands(harness)).toHaveLength(1);

    first.release();
    expect(harness.session.isAttached()).toBe(false);

    await harness.session.acquire().ready();

    expect(interceptCommands(harness).map((c) => c.params)).toEqual([
      { enabled: true },
      { enabled: true },
    ]);
  });
});
