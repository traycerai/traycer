import { describe, expect, it } from "vitest";
import { shouldPreserveClosedWindowSnapshot } from "../../ipc/windows-ipc";
import { ShellQuitState } from "../shell-quit-state";

describe("ShellQuitState", () => {
  it("starts not quitting", () => {
    expect(new ShellQuitState().isQuitting()).toBe(false);
  });

  it("marks quitting and reports it", () => {
    const state = new ShellQuitState();
    state.markQuitting();
    expect(state.isQuitting()).toBe(true);
  });

  it("markQuitting is idempotent across the multi-pass quit", () => {
    const state = new ShellQuitState();
    state.markQuitting();
    state.markQuitting();
    expect(state.isQuitting()).toBe(true);
  });

  it("resetQuitting reverts to not-quitting after an aborted quit", () => {
    const state = new ShellQuitState();
    state.markQuitting();
    state.resetQuitting();
    expect(state.isQuitting()).toBe(false);
  });

  it("resetQuitting is idempotent when no quit was in progress", () => {
    const state = new ShellQuitState();
    state.resetQuitting();
    expect(state.isQuitting()).toBe(false);
  });

  it("a quit attempt can be re-armed after resetQuitting", () => {
    const state = new ShellQuitState();
    state.markQuitting();
    state.resetQuitting();
    state.markQuitting();
    expect(state.isQuitting()).toBe(true);
  });

  it("pins the regression: an aborted quit must not preserve a later non-last window close", () => {
    // Mirrors `before-quit` in desktop-startup.ts: the first pass marks
    // quitting, then a stay-alive branch (install failure / rejected quit
    // decision / failed fresh-snapshot query) fires and must reset the flag -
    // otherwise a later mid-session close of a non-last window is wrongly
    // treated as part of that abandoned quit and its restore snapshot
    // survives when it should be pruned.
    const state = new ShellQuitState();
    state.markQuitting();
    state.resetQuitting();

    const preserve = shouldPreserveClosedWindowSnapshot({
      quitting: state.isQuitting(),
      remainingWindowCount: 1,
    });
    expect(preserve).toBe(false);
  });
});
