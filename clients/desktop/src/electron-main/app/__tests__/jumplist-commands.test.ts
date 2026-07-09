import { describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  on: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    on: electronMock.on,
  },
}));

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn() },
}));

import {
  findJumplistCommandInArgv,
  registerJumplistCommandHandling,
} from "../jumplist-commands";

describe("findJumplistCommandInArgv", () => {
  it("maps the jump-list task flags to their commands", () => {
    const exe = "C:\\Program Files\\Traycer\\Traycer.exe";
    expect(findJumplistCommandInArgv([exe, "--new-epic"])).toBe(
      "epic.newWindow",
    );
    expect(findJumplistCommandInArgv([exe, "--open-settings"])).toBe(
      "app.openSettings",
    );
  });

  it("ignores argv without a jump-list flag", () => {
    expect(findJumplistCommandInArgv(["Traycer.exe"])).toBeNull();
    expect(
      findJumplistCommandInArgv([
        "Traycer.exe",
        "traycer-staging://auth/callback",
      ]),
    ).toBeNull();
  });
});

describe("registerJumplistCommandHandling", () => {
  function installAndFire(argv: readonly string[]): {
    dispatch: ReturnType<typeof vi.fn>;
    focusMainWindow: ReturnType<typeof vi.fn>;
  } {
    electronMock.on.mockReset();
    const sink = { dispatch: vi.fn(), focusMainWindow: vi.fn() };
    registerJumplistCommandHandling(sink);
    expect(electronMock.on).toHaveBeenCalledWith(
      "second-instance",
      expect.any(Function),
    );
    const listener = electronMock.on.mock.calls[0][1] as (
      event: unknown,
      argv: readonly string[],
    ) => void;
    listener({}, argv);
    return sink;
  }

  it("focuses the main window and dispatches a recognized flag", () => {
    const sink = installAndFire(["Traycer.exe", "--open-settings"]);
    expect(sink.focusMainWindow).toHaveBeenCalledOnce();
    expect(sink.dispatch).toHaveBeenCalledWith("app.openSettings");
  });

  it("still focuses the main window on a plain relaunch", () => {
    const sink = installAndFire(["Traycer.exe"]);
    expect(sink.focusMainWindow).toHaveBeenCalledOnce();
    expect(sink.dispatch).not.toHaveBeenCalled();
  });
});
