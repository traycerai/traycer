import { describe, expect, it } from "vitest";
import { terminalSessionTitle } from "../terminal-title";

describe("terminalSessionTitle", () => {
  it("prefers a user title over the active process name", () => {
    expect(
      terminalSessionTitle({
        title: "Manual name",
        activeProcessName: "vim",
      }),
    ).toBe("Manual name");
  });

  it("uses the active process name before the default title", () => {
    expect(
      terminalSessionTitle({
        title: null,
        activeProcessName: "npm",
      }),
    ).toBe("npm");
  });

  it("falls back when both title sources are blank", () => {
    expect(
      terminalSessionTitle({
        title: null,
        activeProcessName: "  ",
      }),
    ).toBe("New Terminal");
  });
});
