import { describe, expect, it } from "vitest";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { readDesktopWindowId } from "@/lib/windows/desktop-window-id";

/**
 * `readDesktopWindowId` is the renderer half of an identity that spans three
 * processes (see the doc comment on the function itself): desktop main mints
 * the id and answers it as `RunnerHostSync.windowId`, the same
 * `resolveSenderWindowId` names the window a `browser.sessions` stream opens
 * for and stamps it on `electronTabLifecycleReady.desktopWindowId`
 * (`browser-sessions-owner.ts:1108`), and the host echoes it back as
 * `BrowserTabInfo.boundWindowId`. The desktop-main half of this identity is
 * pinned separately by `runner-ipc.test.ts:3667`; this file only pins that
 * the renderer reads the bridge's `windows.windowId` structurally, and
 * degrades to `null` rather than throwing wherever that shape is missing.
 */

function runnerHostWithWindows(windows: unknown): IRunnerHost {
  return Object.assign(createFakeRunnerHost({}), { windows });
}

describe("readDesktopWindowId", () => {
  it("reads the bridge's windowId", () => {
    expect(
      readDesktopWindowId(runnerHostWithWindows({ windowId: "window-a" })),
    ).toBe("window-a");
  });

  it("returns null for a null runner host", () => {
    expect(readDesktopWindowId(null)).toBeNull();
  });

  it("returns null when the runner host has no windows bridge", () => {
    expect(readDesktopWindowId(createFakeRunnerHost({}))).toBeNull();
  });

  it("returns null when windowId is not a string", () => {
    expect(
      readDesktopWindowId(runnerHostWithWindows({ windowId: 123 })),
    ).toBeNull();
  });

  it("returns null when windowId is an empty string", () => {
    expect(
      readDesktopWindowId(runnerHostWithWindows({ windowId: "" })),
    ).toBeNull();
  });
});
