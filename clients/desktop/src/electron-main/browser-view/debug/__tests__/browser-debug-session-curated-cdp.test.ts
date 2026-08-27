import { describe, expect, it, vi } from "vitest";
import {
  commandKey,
  createHarness,
} from "./browser-debug-session-test-support";
import type { BrowserDebugSessionHarness } from "./browser-debug-session-test-support";

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  describeLogError: (err: unknown) => String(err),
}));

const ROOT_TARGET = { kind: "root" } as const;
const ROOT_FRAME_ID = "root-frame";

async function recordRootFrame(
  harness: BrowserDebugSessionHarness,
  rootFrameId: string,
): Promise<void> {
  harness.webContents.debugger.responses.set("Page.getFrameTree", {
    frameTree: {
      frame: { id: rootFrameId, url: "https://example.com" },
      childFrames: [
        {
          frame: {
            id: "frame-1",
            parentId: rootFrameId,
            url: "https://example.com/frame",
          },
        },
      ],
    },
  });
  await expect(
    harness.session.dispatch(ROOT_TARGET, { kind: "cdpGetFrameTree" }),
  ).resolves.toEqual({
    kind: "cdpGetFrameTree",
    ok: true,
    frames: [
      {
        frameId: rootFrameId,
        parentFrameId: null,
        url: "https://example.com",
      },
      {
        frameId: "frame-1",
        parentFrameId: rootFrameId,
        url: "https://example.com/frame",
      },
    ],
  });
}

function frameTarget(frameId: string, parentFrameId: string) {
  return { kind: "frame" as const, frameId, parentFrameId };
}

async function establishOopif(
  harness: BrowserDebugSessionHarness,
): Promise<void> {
  const browserDebugger = harness.webContents.debugger;
  browserDebugger.responses.set("Target.getTargets", {
    targetInfos: [{ targetId: "frame-1", type: "iframe" }],
  });
  browserDebugger.responses.set("Target.attachToTarget", {
    sessionId: "child-1",
  });
  await harness.session.enableAfterCommit();
  await recordRootFrame(harness, ROOT_FRAME_ID);
  await expect(
    harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
      kind: "cdpInsertText",
      text: "prime-oopif",
    }),
  ).resolves.toEqual({ kind: "cdpInsertText", ok: true });
}

async function recordNestedOopifFrame(
  harness: BrowserDebugSessionHarness,
): Promise<void> {
  const browserDebugger = harness.webContents.debugger;
  browserDebugger.responses.set(commandKey("Page.getFrameTree", "child-1"), {
    frameTree: {
      frame: {
        id: "frame-1",
        parentId: ROOT_FRAME_ID,
        url: "https://example.com/frame",
      },
      childFrames: [
        {
          frame: {
            id: "frame-2",
            parentId: "frame-1",
            url: "https://example.com/frame/nested",
          },
        },
      ],
    },
  });
  await expect(
    harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
      kind: "cdpGetFrameTree",
    }),
  ).resolves.toEqual({
    kind: "cdpGetFrameTree",
    ok: true,
    frames: [
      {
        frameId: "frame-1",
        parentFrameId: ROOT_FRAME_ID,
        url: "https://example.com/frame",
      },
      {
        frameId: "frame-2",
        parentFrameId: "frame-1",
        url: "https://example.com/frame/nested",
      },
    ],
  });
}

describe("BrowserDebugSession curated CDP dispatch", () => {
  it("settles domain enable when the root debugger detaches", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.deferResponse("Page.enable", undefined);

    const enabling = harness.session.enableAfterCommit();
    await vi.waitFor(() => {
      expect(browserDebugger.commands).toContainEqual({
        method: "Page.enable",
        params: {},
        sessionId: undefined,
      });
    });
    browserDebugger.emitDetach("target closed");

    await expect(enabling).rejects.toThrow(
      "Browser debugger detached while enabling",
    );
    browserDebugger.resolveResponse("Page.enable", undefined, {});
  });

  it("inherits a same-process frame route without attaching a child target", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [],
    });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);

    expect(
      browserDebugger.commands
        .filter(
          ({ method, sessionId }) =>
            sessionId === undefined && method.endsWith(".enable"),
        )
        .map(({ method }) => method),
    ).toEqual([
      "Page.enable",
      "Runtime.enable",
      "Log.enable",
      "Network.enable",
      "DOM.enable",
    ]);
    expect(
      browserDebugger.commands.some(
        ({ method }) => method === "Target.setAutoAttach",
      ),
    ).toBe(false);

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "same-process",
      }),
    ).resolves.toEqual({
      kind: "cdpInsertText",
      ok: true,
    });
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "same-process" },
      sessionId: undefined,
    });
    expect(
      browserDebugger.commands.some(
        ({ method }) => method === "Target.attachToTarget",
      ),
    ).toBe(false);
  });

  it("records a frame attached after the last frame-tree snapshot", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", { targetInfos: [] });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);

    browserDebugger.emitMessage(
      "Page.frameAttached",
      { frameId: "late-frame", parentFrameId: ROOT_FRAME_ID },
      undefined,
    );

    await expect(
      harness.session.dispatch(frameTarget("late-frame", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "late-frame",
      }),
    ).resolves.toEqual({ kind: "cdpInsertText", ok: true });
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "late-frame" },
      sessionId: undefined,
    });
  });

  it("routes nested same-process frames from an OOPIF tree through its child session", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    await establishOopif(harness);
    await recordNestedOopifFrame(harness);

    await expect(
      harness.session.dispatch(frameTarget("frame-2", "frame-1"), {
        kind: "cdpInsertText",
        text: "nested-oopif",
      }),
    ).resolves.toEqual({ kind: "cdpInsertText", ok: true });
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "nested-oopif" },
      sessionId: "child-1",
    });
    expect(
      browserDebugger.commands.filter(
        ({ method }) => method === "Target.attachToTarget",
      ),
    ).toHaveLength(1);
  });

  it("attaches and enables an OOPIF before dispatching into it", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "child-1",
    });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "oopif",
      }),
    ).resolves.toEqual({
      kind: "cdpInsertText",
      ok: true,
    });
    expect(
      browserDebugger.commands
        .filter(({ sessionId }) => sessionId === "child-1")
        .map(({ method }) => method),
    ).toEqual([
      "Page.enable",
      "Runtime.enable",
      "Log.enable",
      "Network.enable",
      "DOM.enable",
      "Input.insertText",
    ]);

    browserDebugger.emitMessage(
      "Target.detachedFromTarget",
      { sessionId: "child-1" },
      undefined,
    );
    browserDebugger.responses.set("Target.getTargets", { targetInfos: [] });
    await harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
      kind: "cdpInsertText",
      text: "after-detach",
    });
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "after-detach" },
      sessionId: undefined,
    });
  });

  it("keeps a child attachment when Page.enable emits its initial navigation", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "child-1",
    });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);
    browserDebugger.onSendCommand = ({ method, sessionId }) => {
      if (method !== "Page.enable" || sessionId !== "child-1") return;
      browserDebugger.emitMessage(
        "Page.frameNavigated",
        {
          frame: {
            id: "frame-1",
            parentId: ROOT_FRAME_ID,
            url: "https://example.com/frame-ready",
          },
        },
        "child-1",
      );
    };

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "during-enable",
      }),
    ).resolves.toMatchObject({ kind: "cdpInsertText", ok: false });

    browserDebugger.onSendCommand = null;
    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "after-enable",
      }),
    ).resolves.toEqual({ kind: "cdpInsertText", ok: true });
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "after-enable" },
      sessionId: "child-1",
    });
    expect(
      browserDebugger.commands.some(
        ({ method }) => method === "Target.detachFromTarget",
      ),
    ).toBe(false);
  });

  it("rejects an OOPIF whose claimed parent is not recorded", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);

    await expect(
      harness.session.dispatch(frameTarget("frame-1", "unknown-parent"), {
        kind: "cdpInsertText",
        text: "invalid",
      }),
    ).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
      error: {
        kind: "cdp_error",
        message:
          "Cannot resolve frame frame-1: expected parent root-frame, received unknown-parent.",
      },
    });
    expect(
      browserDebugger.commands.some(
        ({ method }) => method === "Target.attachToTarget",
      ),
    ).toBe(false);
  });

  it("does not resurrect a frame detached while target discovery is pending", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);
    browserDebugger.onSendCommand = ({ method }) => {
      if (method !== "Target.getTargets") return;
      browserDebugger.emitMessage(
        "Page.frameDetached",
        { frameId: "frame-1" },
        undefined,
      );
    };

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "stale",
      }),
    ).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
      error: {
        kind: "cdp_error",
        message:
          "Cannot resolve frame frame-1: frame is not present in the recorded tree.",
      },
    });
    expect(
      browserDebugger.commands.some(
        ({ method }) => method === "Target.attachToTarget",
      ),
    ).toBe(false);
  });

  it("shares one explicit attach request across concurrent commands for an OOPIF", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "child-1",
    });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);

    const results = await Promise.all([
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "first",
      }),
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "second",
      }),
    ]);

    expect(results).toEqual([
      { kind: "cdpInsertText", ok: true },
      { kind: "cdpInsertText", ok: true },
    ]);
    expect(
      browserDebugger.commands.filter(
        ({ method }) => method === "Target.attachToTarget",
      ),
    ).toHaveLength(1);
    expect(
      browserDebugger.commands.filter(
        ({ method }) => method === "Target.getTargets",
      ),
    ).toHaveLength(1);
    expect(
      browserDebugger.commands
        .filter(
          ({ method, sessionId }) =>
            method === "Input.insertText" && sessionId === "child-1",
        )
        .map(({ params }) => params.text),
    ).toEqual(["first", "second"]);
  });

  it("retires an OOPIF attachment invalidated by root navigation", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "stale-child",
    });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);
    browserDebugger.onSendCommand = ({ method }) => {
      if (method !== "Target.attachToTarget") return;
      browserDebugger.emitMessage(
        "Page.frameNavigated",
        { frame: { id: "next-root", url: "https://example.com/next" } },
        undefined,
      );
    };

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "stale",
      }),
    ).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
      error: {
        kind: "cdp_error",
        message:
          "Cannot resolve frame frame-1: frame is not present in the recorded tree.",
      },
    });
    expect(browserDebugger.commands).toContainEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "stale-child" },
      sessionId: undefined,
    });
  });

  it("does not retain a child detached before its attach response resolves", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "detached-child",
    });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);
    browserDebugger.onSendCommand = ({ method }) => {
      if (method !== "Target.attachToTarget") return;
      browserDebugger.emitMessage(
        "Target.detachedFromTarget",
        { sessionId: "detached-child" },
        undefined,
      );
    };

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "stale",
      }),
    ).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
      error: {
        kind: "cdp_error",
        message: "Child debugger session ended while enabling",
      },
    });

    browserDebugger.onSendCommand = null;
    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "replacement-child",
    });
    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "fresh",
      }),
    ).resolves.toEqual({ kind: "cdpInsertText", ok: true });
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "fresh" },
      sessionId: "replacement-child",
    });
  });

  it("settles a pending child attach when the root debugger detaches", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    browserDebugger.deferResponse("Target.attachToTarget", undefined);
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);

    const pending = harness.session.dispatch(
      frameTarget("frame-1", ROOT_FRAME_ID),
      {
        kind: "cdpInsertText",
        text: "stale",
      },
    );
    await vi.waitFor(() => {
      expect(browserDebugger.commands).toContainEqual({
        method: "Target.attachToTarget",
        params: { targetId: "frame-1", flatten: true },
        sessionId: undefined,
      });
    });
    browserDebugger.emitDetach("target closed");

    await expect(pending).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
      error: {
        kind: "not_attached",
        message: "Browser debugger detached while enabling",
      },
    });
    await harness.session.enableAfterCommit();
    browserDebugger.resolveResponse("Target.attachToTarget", undefined, {
      sessionId: "late-child",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(browserDebugger.commands).not.toContainEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "late-child" },
      sessionId: undefined,
    });
  });

  it("waits for child detach completion before replacing an OOPIF attachment", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    await establishOopif(harness);
    browserDebugger.deferResponse("Target.detachFromTarget", undefined);
    browserDebugger.responses.set("Page.getFrameTree", {
      frameTree: {
        frame: {
          id: "next-root",
          url: "https://example.com/replaced",
        },
        childFrames: [
          {
            frame: {
              id: "frame-1",
              parentId: "next-root",
              url: "https://example.com/frame-replaced",
            },
          },
        ],
      },
    });
    await expect(
      harness.session.dispatch(ROOT_TARGET, { kind: "cdpGetFrameTree" }),
    ).resolves.toMatchObject({ kind: "cdpGetFrameTree", ok: true });
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "replacement-child",
    });

    const replacement = harness.session.dispatch(
      frameTarget("frame-1", "next-root"),
      {
        kind: "cdpInsertText",
        text: "replacement",
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(
      browserDebugger.commands.filter(
        ({ method }) => method === "Target.attachToTarget",
      ),
    ).toHaveLength(1);

    browserDebugger.resolveResponse("Target.detachFromTarget", undefined, {});
    await expect(replacement).resolves.toEqual({
      kind: "cdpInsertText",
      ok: true,
    });
    expect(browserDebugger.commands).toContainEqual({
      method: "Target.attachToTarget",
      params: { targetId: "frame-1", flatten: true },
      sessionId: undefined,
    });
    expect(
      browserDebugger.commands.filter(
        ({ method }) => method === "Target.attachToTarget",
      ),
    ).toHaveLength(2);
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "replacement" },
      sessionId: "replacement-child",
    });
    const detachIndex = browserDebugger.commands.findIndex(
      ({ method }) => method === "Target.detachFromTarget",
    );
    const attachIndices = browserDebugger.commands.flatMap(
      ({ method }, index) =>
        method === "Target.attachToTarget" ? [index] : [],
    );
    expect(detachIndex).toBeLessThan(attachIndices[1]);
  });

  it("settles child retirement when the root debugger detaches", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    await establishOopif(harness);
    browserDebugger.deferResponse("Target.detachFromTarget", undefined);
    browserDebugger.responses.set("Page.getFrameTree", {
      frameTree: {
        frame: { id: "next-root", url: "https://example.com/replaced" },
        childFrames: [
          {
            frame: {
              id: "frame-1",
              parentId: "next-root",
              url: "https://example.com/frame-replaced",
            },
          },
        ],
      },
    });
    await harness.session.dispatch(ROOT_TARGET, { kind: "cdpGetFrameTree" });

    const pending = harness.session.dispatch(
      frameTarget("frame-1", "next-root"),
      {
        kind: "cdpInsertText",
        text: "replacement",
      },
    );
    await vi.waitFor(() => {
      expect(browserDebugger.commands).toContainEqual({
        method: "Target.detachFromTarget",
        params: { sessionId: "child-1" },
        sessionId: undefined,
      });
    });
    browserDebugger.emitDetach("target closed");

    await expect(pending).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
      error: { kind: "not_attached" },
    });
    browserDebugger.resolveResponse("Target.detachFromTarget", undefined, {});
  });

  it("does not route inherited descendants through a detached OOPIF session", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    await establishOopif(harness);
    await recordNestedOopifFrame(harness);

    browserDebugger.emitMessage(
      "Target.detachedFromTarget",
      { sessionId: "child-1" },
      undefined,
    );
    browserDebugger.responses.set("Target.getTargets", { targetInfos: [] });

    await expect(
      harness.session.dispatch(frameTarget("frame-2", "frame-1"), {
        kind: "cdpInsertText",
        text: "after-detach",
      }),
    ).resolves.toEqual({ kind: "cdpInsertText", ok: true });
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "after-detach" },
      sessionId: undefined,
    });
    expect(
      browserDebugger.commands.some(
        ({ method, params, sessionId }) =>
          method === "Input.insertText" &&
          sessionId === "child-1" &&
          params.text === "after-detach",
      ),
    ).toBe(false);
  });

  it("retires a late child attachment after disposal", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.attached = true;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "late-child",
    });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);
    browserDebugger.onSendCommand = ({ method }) => {
      if (method === "Target.attachToTarget") harness.session.dispose();
    };

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "stale",
      }),
    ).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
      error: { kind: "not_attached" },
    });
    expect(browserDebugger.commands).toContainEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "late-child" },
      sessionId: undefined,
    });
  });

  it("releases an established child session on root navigation", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "child-1",
    });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);
    await harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
      kind: "cdpInsertText",
      text: "before-navigation",
    });

    browserDebugger.emitMessage(
      "Page.frameNavigated",
      { frame: { id: "next-root", url: "https://example.com/next" } },
      undefined,
    );

    expect(browserDebugger.commands).toContainEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "child-1" },
      sessionId: undefined,
    });
  });

  it("preserves an established OOPIF session across navigation and drops only descendants", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    await establishOopif(harness);
    await recordNestedOopifFrame(harness);

    browserDebugger.emitMessage(
      "Page.frameNavigated",
      {
        frame: {
          id: "frame-1",
          parentId: ROOT_FRAME_ID,
          url: "https://example.com/frame-next",
        },
      },
      "child-1",
    );

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "after-navigation",
      }),
    ).resolves.toEqual({ kind: "cdpInsertText", ok: true });
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "after-navigation" },
      sessionId: "child-1",
    });
    expect(
      browserDebugger.commands.filter(
        ({ method }) =>
          method === "Target.attachToTarget" ||
          method === "Target.detachFromTarget",
      ),
    ).toHaveLength(1);
    await expect(
      harness.session.dispatch(frameTarget("frame-2", "frame-1"), {
        kind: "cdpInsertText",
        text: "stale-descendant",
      }),
    ).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
      error: {
        kind: "cdp_error",
        message:
          "Cannot resolve frame frame-2: frame is not present in the recorded tree.",
      },
    });
  });

  it("ignores a Page.frameNavigated event from an unrelated child session", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    await establishOopif(harness);

    browserDebugger.emitMessage(
      "Page.frameNavigated",
      {
        frame: {
          id: "frame-1",
          parentId: ROOT_FRAME_ID,
          url: "https://example.com/forged",
        },
      },
      "unrelated-child",
    );

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "authorized-route",
      }),
    ).resolves.toEqual({ kind: "cdpInsertText", ok: true });
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "authorized-route" },
      sessionId: "child-1",
    });
    expect(
      browserDebugger.commands.some(
        ({ method }) => method === "Target.detachFromTarget",
      ),
    ).toBe(false);
  });

  it("ignores a Page.frameDetached event from an unrelated child session", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    await establishOopif(harness);

    browserDebugger.emitMessage(
      "Page.frameDetached",
      { frameId: "frame-1" },
      "unrelated-child",
    );

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "authorized-route",
      }),
    ).resolves.toEqual({ kind: "cdpInsertText", ok: true });
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "authorized-route" },
      sessionId: "child-1",
    });
  });

  it("releases an established child while preserving an external root debugger", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.attached = true;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "child-1",
    });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);
    await harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
      kind: "cdpInsertText",
      text: "before-dispose",
    });

    harness.session.dispose();

    expect(browserDebugger.attached).toBe(true);
    expect(browserDebugger.commands).toContainEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "child-1" },
      sessionId: undefined,
    });
  });

  it("retires a child that fails domain setup and can resolve it again", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "child-1",
    });
    browserDebugger.failures.set(
      commandKey("DOM.enable", "child-1"),
      new Error("DOM unavailable"),
    );
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "first",
      }),
    ).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
      error: { kind: "cdp_error", message: "DOM unavailable" },
    });
    expect(browserDebugger.commands).toContainEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "child-1" },
      sessionId: undefined,
    });

    browserDebugger.failures.clear();
    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "child-2",
    });
    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "second",
      }),
    ).resolves.toEqual({
      kind: "cdpInsertText",
      ok: true,
    });
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "second" },
      sessionId: "child-2",
    });
  });

  it("rejects a stale frame route whose parent identity changed", async () => {
    const harness = createHarness();
    harness.webContents.debugger.responses.set("Target.getTargets", {
      targetInfos: [],
    });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);
    await harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
      kind: "cdpInsertText",
      text: "initial",
    });

    await expect(
      harness.session.dispatch(frameTarget("frame-1", "other-parent"), {
        kind: "cdpInsertText",
        text: "stale",
      }),
    ).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
      error: {
        kind: "cdp_error",
        message:
          "Cannot resolve frame frame-1: expected parent root-frame, received other-parent.",
      },
    });
  });

  it("invalidates logical frame routes when the root frame navigates", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", { targetInfos: [] });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);
    await harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
      kind: "cdpInsertText",
      text: "before-navigation",
    });

    browserDebugger.emitMessage(
      "Page.frameNavigated",
      { frame: { id: "next-root", url: "https://example.com/next" } },
      undefined,
    );

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "stale-parent",
      }),
    ).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
      error: {
        kind: "cdp_error",
        message:
          "Cannot resolve frame frame-1: frame is not present in the recorded tree.",
      },
    });
    await recordRootFrame(harness, "next-root");
    await expect(
      harness.session.dispatch(frameTarget("frame-1", "next-root"), {
        kind: "cdpInsertText",
        text: "fresh-parent",
      }),
    ).resolves.toEqual({ kind: "cdpInsertText", ok: true });
  });

  it("does not commit a frame tree invalidated while Page.getFrameTree is in flight", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);
    browserDebugger.onSendCommand = ({ method }) => {
      if (method !== "Page.getFrameTree") return;
      browserDebugger.emitMessage(
        "Page.frameNavigated",
        { frame: { id: "next-root", url: "https://example.com/next" } },
        undefined,
      );
    };

    await expect(
      harness.session.dispatch(ROOT_TARGET, { kind: "cdpGetFrameTree" }),
    ).resolves.toMatchObject({
      kind: "cdpGetFrameTree",
      ok: false,
      error: {
        kind: "cdp_error",
        message: "Browser target route changed before command dispatch.",
      },
    });
    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "stale",
      }),
    ).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
      error: {
        kind: "cdp_error",
        message:
          "Cannot resolve frame frame-1: frame is not present in the recorded tree.",
      },
    });
  });

  it("rejects a cyclic frame parent graph at the Page.getFrameTree boundary", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", { targetInfos: [] });
    browserDebugger.responses.set("Page.getFrameTree", {
      frameTree: {
        frame: { id: ROOT_FRAME_ID, url: "https://example.com" },
        childFrames: [
          {
            frame: {
              id: "frame-1",
              parentId: "frame-2",
              url: "https://example.com/frame-1",
            },
            childFrames: [
              {
                frame: {
                  id: "frame-2",
                  parentId: "frame-1",
                  url: "https://example.com/frame-2",
                },
              },
            ],
          },
        ],
      },
    });
    await harness.session.enableAfterCommit();

    await expect(
      harness.session.dispatch(ROOT_TARGET, { kind: "cdpGetFrameTree" }),
    ).resolves.toMatchObject({
      kind: "cdpGetFrameTree",
      ok: false,
      error: {
        kind: "cdp_error",
        message: expect.stringMatching(/cyclic|cycle/i),
      },
    });
  });

  it("does not dispatch through a cached route invalidated before send", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", { targetInfos: [] });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);
    await harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
      kind: "cdpInsertText",
      text: "prime-route",
    });
    const insertCount = browserDebugger.commands.filter(
      ({ method }) => method === "Input.insertText",
    ).length;

    const pending = harness.session.dispatch(
      frameTarget("frame-1", ROOT_FRAME_ID),
      {
        kind: "cdpInsertText",
        text: "stale",
      },
    );
    browserDebugger.emitMessage(
      "Page.frameDetached",
      { frameId: "frame-1" },
      undefined,
    );

    await expect(pending).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
      error: {
        kind: "cdp_error",
        message:
          "Cannot resolve frame frame-1: frame is not present in the recorded tree.",
      },
    });
    expect(
      browserDebugger.commands.filter(
        ({ method }) => method === "Input.insertText",
      ),
    ).toHaveLength(insertCount);
  });

  it("classifies a command rejection from actual post-failure attach state", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    await harness.session.enableAfterCommit();
    browserDebugger.failures.set(
      "Page.captureScreenshot",
      new Error("transport rejected"),
    );
    browserDebugger.detachBeforeFailure = true;

    await expect(
      harness.session.dispatch(ROOT_TARGET, {
        kind: "cdpCaptureScreenshot",
        format: "png",
        quality: null,
      }),
    ).resolves.toEqual({
      kind: "cdpCaptureScreenshot",
      ok: false,
      error: {
        kind: "not_attached",
        message: "transport rejected",
        code: null,
      },
    });
  });

  it("serializes replacement behind a pending attach and its detach", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    browserDebugger.deferResponse("Target.attachToTarget", undefined);
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);

    const stale = harness.session.dispatch(
      frameTarget("frame-1", ROOT_FRAME_ID),
      {
        kind: "cdpInsertText",
        text: "stale-attach",
      },
    );
    await vi.waitFor(() => {
      expect(
        browserDebugger.commands.filter(
          ({ method }) => method === "Target.attachToTarget",
        ),
      ).toHaveLength(1);
    });

    browserDebugger.responses.set("Page.getFrameTree", {
      frameTree: {
        frame: { id: "replacement-root", url: "https://example.com/replaced" },
        childFrames: [
          {
            frame: {
              id: "frame-1",
              parentId: "replacement-root",
              url: "https://example.com/frame-replaced",
            },
          },
        ],
      },
    });
    await expect(
      harness.session.dispatch(ROOT_TARGET, { kind: "cdpGetFrameTree" }),
    ).resolves.toMatchObject({ kind: "cdpGetFrameTree", ok: true });

    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "current-child",
    });
    const current = harness.session.dispatch(
      frameTarget("frame-1", "replacement-root"),
      {
        kind: "cdpInsertText",
        text: "current-attach",
      },
    );
    let currentSettled = false;
    void current.then(() => {
      currentSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(currentSettled).toBe(false);

    browserDebugger.deferResponse("Target.detachFromTarget", undefined);
    browserDebugger.resolveResponse("Target.attachToTarget", undefined, {
      sessionId: "stale-child",
    });
    await vi.waitFor(() => {
      expect(
        browserDebugger.commands.some(
          ({ method }) => method === "Target.detachFromTarget",
        ),
      ).toBe(true);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(currentSettled).toBe(false);

    browserDebugger.resolveResponse("Target.detachFromTarget", undefined, {});
    await expect(current).resolves.toEqual({
      kind: "cdpInsertText",
      ok: true,
    });
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "current-attach" },
      sessionId: "current-child",
    });
    await expect(stale).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
    });
  });

  it("rebuilds attachment-scoped routes after a silent native detach", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    await establishOopif(harness);
    browserDebugger.attached = false;

    await expect(
      harness.session.sendCommand("Runtime.evaluate", {}, undefined),
    ).rejects.toThrow("Browser debugger is not ready.");
    expect(browserDebugger.attached).toBe(false);

    await harness.session.enableAfterCommit();

    expect(browserDebugger.attached).toBe(true);
    expect(
      browserDebugger.commands.filter(
        ({ method, sessionId }) =>
          method === "Page.enable" && sessionId === undefined,
      ),
    ).toHaveLength(2);

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "stale-route",
      }),
    ).resolves.toMatchObject({
      kind: "cdpInsertText",
      ok: false,
    });

    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "child-2",
    });
    await recordRootFrame(harness, ROOT_FRAME_ID);
    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpInsertText",
        text: "fresh-route",
      }),
    ).resolves.toEqual({ kind: "cdpInsertText", ok: true });
    expect(browserDebugger.commands).toContainEqual({
      method: "Input.insertText",
      params: { text: "fresh-route" },
      sessionId: "child-2",
    });
  });

  it("preserves JavaScript undefined separately from JSON null", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    await harness.session.enableAfterCommit();
    browserDebugger.responses.set("Runtime.evaluate", {
      result: { value: undefined },
    });
    const command = {
      kind: "cdpEvaluate" as const,
      expression: "undefined",
      awaitPromise: true,
      returnByValue: true,
      contextId: null,
    };

    await expect(
      harness.session.dispatch(ROOT_TARGET, command),
    ).resolves.toEqual({
      kind: "cdpEvaluate",
      ok: true,
      value: { kind: "undefined" },
      objectId: null,
      exceptionDescription: null,
    });

    browserDebugger.responses.set("Runtime.evaluate", {
      result: { value: null },
    });
    await expect(
      harness.session.dispatch(ROOT_TARGET, command),
    ).resolves.toEqual({
      kind: "cdpEvaluate",
      ok: true,
      value: { kind: "json", value: null },
      objectId: null,
      exceptionDescription: null,
    });
  });

  it("does not replace a child session whose explicit detach failed", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    await establishOopif(harness);
    browserDebugger.failures.set(
      "Target.detachFromTarget",
      new Error("detach transport failed"),
    );
    browserDebugger.responses.set("Page.getFrameTree", {
      frameTree: {
        frame: { id: "next-root", url: "https://example.com/next" },
        childFrames: [
          {
            frame: {
              id: "frame-1",
              parentId: "next-root",
              url: "https://example.com/frame-next",
            },
          },
        ],
      },
    });
    await harness.session.dispatch(ROOT_TARGET, { kind: "cdpGetFrameTree" });
    browserDebugger.responses.set("Target.getTargets", {
      targetInfos: [{ targetId: "frame-1", type: "iframe" }],
    });
    browserDebugger.responses.set("Target.attachToTarget", {
      sessionId: "replacement-child",
    });

    await expect(
      harness.session.dispatch(frameTarget("frame-1", "next-root"), {
        kind: "cdpInsertText",
        text: "replacement",
      }),
    ).resolves.toMatchObject({ kind: "cdpInsertText", ok: false });
    expect(
      browserDebugger.commands.filter(
        ({ method }) => method === "Target.attachToTarget",
      ),
    ).toHaveLength(1);
  });

  it("reads a frame tree through a same-process frame route", async () => {
    const harness = createHarness();
    harness.webContents.debugger.responses.set("Target.getTargets", {
      targetInfos: [],
    });
    await harness.session.enableAfterCommit();
    await recordRootFrame(harness, ROOT_FRAME_ID);

    await expect(
      harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
        kind: "cdpGetFrameTree",
      }),
    ).resolves.toMatchObject({ kind: "cdpGetFrameTree", ok: true });
  });

  it("keeps an in-flight frame command valid when an unrelated sibling navigates", async () => {
    const harness = createHarness();
    const browserDebugger = harness.webContents.debugger;
    browserDebugger.responses.set("Target.getTargets", { targetInfos: [] });
    browserDebugger.responses.set("Page.getFrameTree", {
      frameTree: {
        frame: { id: ROOT_FRAME_ID, url: "https://example.com" },
        childFrames: [
          {
            frame: {
              id: "frame-1",
              parentId: ROOT_FRAME_ID,
              url: "https://example.com/one",
            },
          },
          {
            frame: {
              id: "frame-2",
              parentId: ROOT_FRAME_ID,
              url: "https://example.com/two",
            },
          },
        ],
      },
    });
    await harness.session.enableAfterCommit();
    await harness.session.dispatch(ROOT_TARGET, { kind: "cdpGetFrameTree" });
    await harness.session.dispatch(frameTarget("frame-1", ROOT_FRAME_ID), {
      kind: "cdpInsertText",
      text: "prime-route",
    });

    const pending = harness.session.dispatch(
      frameTarget("frame-1", ROOT_FRAME_ID),
      {
        kind: "cdpInsertText",
        text: "still-current",
      },
    );
    browserDebugger.emitMessage(
      "Page.frameNavigated",
      {
        frame: {
          id: "frame-2",
          parentId: ROOT_FRAME_ID,
          url: "https://example.com/two-next",
        },
      },
      undefined,
    );

    await expect(pending).resolves.toEqual({
      kind: "cdpInsertText",
      ok: true,
    });
  });
});
