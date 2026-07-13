import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const devStack = require("../dev-stack.cjs") as {
  readRendererPort: (env: NodeJS.ProcessEnv) => number;
  buildChildEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

describe("readRendererPort", () => {
  it("defaults to 5173 when PORT is unset", () => {
    expect(devStack.readRendererPort({})).toBe(5173);
  });

  it("reads an explicit PORT", () => {
    expect(devStack.readRendererPort({ PORT: "21005" })).toBe(21005);
  });

  it.each(["0", "65536", "not-a-number", "1.5"])(
    "rejects the out-of-range or non-integer PORT %j",
    (port) => {
      expect(() => devStack.readRendererPort({ PORT: port })).toThrow(/PORT/);
    },
  );
});

describe("buildChildEnv", () => {
  it("forwards DEV_DESKTOP_SLOT to the renderer as VITE_DEV_DESKTOP_SLOT", () => {
    const childEnv = devStack.buildChildEnv({
      DEV_DESKTOP_SLOT: "my-worktree",
    });
    expect(childEnv.VITE_DEV_DESKTOP_SLOT).toBe("my-worktree");
  });

  it("forwards the derived worktree label to the renderer", () => {
    const childEnv = devStack.buildChildEnv({
      DEV_DESKTOP_SLOT: "traycer-spry-panda-a2acaa5e",
    });

    expect(childEnv.VITE_DEV_DESKTOP_WORKTREE_LABEL).toBe("spry-panda");
  });

  it("forwards the loopback Cloud UI override to the renderer", () => {
    const childEnv = devStack.buildChildEnv({
      TRAYCER_DEV_CLOUD_UI_BASE_URL: "http://localhost:21003",
    });

    expect(childEnv.VITE_DEV_CLOUD_UI_BASE_URL).toBe("http://localhost:21003");
  });

  it("clears an inherited Cloud UI Vite override when the dev override is unset", () => {
    const childEnv = devStack.buildChildEnv({
      VITE_DEV_CLOUD_UI_BASE_URL: "http://localhost:21003",
    });

    expect(childEnv.VITE_DEV_CLOUD_UI_BASE_URL).toBeUndefined();
  });

  // The renderer derives its deep-link scheme from VITE_DEV_DESKTOP_SLOT while
  // the main process reads DEV_DESKTOP_SLOT. A stale VITE_ value inherited from
  // the parent shell would desynchronize them, so a no-slot run must clear it.
  it("clears an inherited VITE_DEV_DESKTOP_SLOT when DEV_DESKTOP_SLOT is unset", () => {
    const childEnv = devStack.buildChildEnv({
      VITE_DEV_DESKTOP_SLOT: "stale-slot",
    });
    expect(childEnv.VITE_DEV_DESKTOP_SLOT).toBeUndefined();
  });

  it("clears an inherited VITE worktree label when no dev slot is active", () => {
    const childEnv = devStack.buildChildEnv({
      VITE_DEV_DESKTOP_WORKTREE_LABEL: "stale-slot",
      VITE_DEV_DESKTOP_DISPLAY_NAME: "Traycer Dev — stale-slot",
    });

    expect(childEnv.VITE_DEV_DESKTOP_WORKTREE_LABEL).toBeUndefined();
    expect(childEnv.VITE_DEV_DESKTOP_DISPLAY_NAME).toBeUndefined();
  });

  it("overwrites an inherited VITE_DEV_DESKTOP_SLOT with the active slot", () => {
    const childEnv = devStack.buildChildEnv({
      DEV_DESKTOP_SLOT: "active-slot",
      VITE_DEV_DESKTOP_SLOT: "stale-slot",
    });
    expect(childEnv.VITE_DEV_DESKTOP_SLOT).toBe("active-slot");
  });

  it("marks the dev stack and derives the renderer URL from PORT", () => {
    const childEnv = devStack.buildChildEnv({ PORT: "21005" });
    expect(childEnv.TRAYCER_DESKTOP_DEV).toBe("1");
    expect(childEnv.PORT).toBe("21005");
    expect(childEnv.TRAYCER_DESKTOP_DEV_URL).toBe("http://localhost:21005");
  });

  it("overrides an inherited production NODE_ENV", () => {
    const childEnv = devStack.buildChildEnv({ NODE_ENV: "production" });

    expect(childEnv.NODE_ENV).toBe("development");
  });

  it("keeps an explicit TRAYCER_DESKTOP_DEV_URL", () => {
    const childEnv = devStack.buildChildEnv({
      TRAYCER_DESKTOP_DEV_URL: "http://127.0.0.1:39584",
    });
    expect(childEnv.TRAYCER_DESKTOP_DEV_URL).toBe("http://127.0.0.1:39584");
  });
});
