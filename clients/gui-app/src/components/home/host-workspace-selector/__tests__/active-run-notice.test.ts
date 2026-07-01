import { describe, expect, it } from "vitest";
import { activeRunNoticeFor } from "../active-run-notice";

describe("activeRunNoticeFor", () => {
  it("tells the user to stop the active run when a turn is genuinely active", () => {
    expect(activeRunNoticeFor("chat", true)).toBe(
      "Stop the active run before rebinding",
    );
  });

  it("tells the user to wait for background tasks when the owner is active purely from background work - the reported regression", () => {
    expect(activeRunNoticeFor("chat", false)).toBe(
      "Wait for background tasks to complete before rebinding",
    );
  });

  it("always shows the terminal-restart notice for a terminal agent, regardless of hasActiveTurn", () => {
    expect(activeRunNoticeFor("terminal-agent", true)).toBe(
      "Terminal will restart after rebinding",
    );
    expect(activeRunNoticeFor("terminal-agent", false)).toBe(
      "Terminal will restart after rebinding",
    );
  });
});
