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

const ROOT_FRAME_ID = "root-frame";

function commandsForSession(
  harness: BrowserDebugSessionHarness,
  sessionId: string | undefined,
): RecordedCommand[] {
  return interceptCommands(harness).filter(
    (command) => command.sessionId === sessionId,
  );
}

/** Lets the root learn its frame tree, with one cross-process child frame. */
async function recordRootFrame(
  harness: BrowserDebugSessionHarness,
): Promise<void> {
  const browserDebugger = harness.webContents.debugger;
  browserDebugger.responses.set("Target.getTargets", {
    targetInfos: [{ targetId: "frame-1", type: "iframe" }],
  });
  browserDebugger.responses.set("Target.attachToTarget", {
    sessionId: "child-1",
  });
  browserDebugger.responses.set("Page.getFrameTree", {
    frameTree: {
      frame: { id: ROOT_FRAME_ID, url: "https://example.com" },
      childFrames: [
        {
          frame: {
            id: "frame-1",
            parentId: ROOT_FRAME_ID,
            url: "https://example.com/frame",
          },
        },
      ],
    },
  });
  await expect(
    harness.session.dispatch({ kind: "root" }, { kind: "cdpGetFrameTree" }),
  ).resolves.toMatchObject({ ok: true });
}

/** Resolves a command in the child frame, which attaches and enables it. */
async function reachChild(harness: BrowserDebugSessionHarness): Promise<void> {
  await expect(
    harness.session.dispatch(
      { kind: "frame", frameId: "frame-1", parentFrameId: ROOT_FRAME_ID },
      { kind: "cdpInsertText", text: "x" },
    ),
  ).resolves.toEqual({ kind: "cdpInsertText", ok: true });
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
  it("intercepts in a child target's own session when the reading is true", async () => {
    const harness = createHarnessWith({ interceptFileChooser: () => true });
    await harness.session.acquire().ready();
    await recordRootFrame(harness);

    await reachChild(harness);

    expect(commandsForSession(harness, "child-1")).toEqual([
      { method: INTERCEPT, params: { enabled: true }, sessionId: "child-1" },
    ]);
    expect(commandsForSession(harness, undefined)).toHaveLength(1);
  });

  it("sends a child session nothing when the reading is false", async () => {
    const harness = createHarnessWith({ interceptFileChooser: () => false });
    await harness.session.acquire().ready();
    await recordRootFrame(harness);

    await reachChild(harness);

    const childMethods = harness.webContents.debugger.commands
      .filter((command) => command.sessionId === "child-1")
      .map((command) => command.method);
    expect(childMethods).toContain("Page.enable");
    expect(childMethods).not.toContain(INTERCEPT);
  });

  it("applies each edge of the reading to the root and the ready child once", async () => {
    const reading = { value: true };
    const harness = createHarnessWith({
      interceptFileChooser: () => reading.value,
    });
    await harness.session.acquire().ready();
    await recordRootFrame(harness);
    await reachChild(harness);

    reading.value = false;
    harness.session.syncFileChooserInterception();

    expect(commandsForSession(harness, undefined).map((c) => c.params)).toEqual(
      [{ enabled: true }, { enabled: false }],
    );
    expect(commandsForSession(harness, "child-1").map((c) => c.params)).toEqual(
      [{ enabled: true }, { enabled: false }],
    );

    harness.session.syncFileChooserInterception();
    expect(interceptCommands(harness)).toHaveLength(4);
  });

  it("gives a child attached after a flip the then-current reading", async () => {
    const reading = { value: true };
    const harness = createHarnessWith({
      interceptFileChooser: () => reading.value,
    });
    await harness.session.acquire().ready();
    await recordRootFrame(harness);

    reading.value = false;
    harness.session.syncFileChooserInterception();
    await reachChild(harness);
    // The child came up on a tab that is now on screen: it holds false, the
    // fresh default, so nothing is sent to it.
    expect(commandsForSession(harness, "child-1")).toEqual([]);

    reading.value = true;
    harness.session.syncFileChooserInterception();
    expect(commandsForSession(harness, "child-1").map((c) => c.params)).toEqual(
      [{ enabled: true }],
    );
  });
  it("gives a child attached after the root was enabled the reading it has by then", async () => {
    const reading = { value: false };
    const harness = createHarnessWith({
      interceptFileChooser: () => reading.value,
    });
    await harness.session.acquire().ready();
    await recordRootFrame(harness);
    expect(interceptCommands(harness)).toEqual([]);

    reading.value = true;
    await reachChild(harness);

    expect(commandsForSession(harness, "child-1")).toEqual([
      { method: INTERCEPT, params: { enabled: true }, sessionId: "child-1" },
    ]);
  });
});
