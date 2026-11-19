import { describe, expect, it } from "vitest";
import {
  PERSONAL_LEAVE_SKIPPED_SHARED,
  personalLeaveSignInNotKept,
  personalLeaveSkipped,
} from "../personal-leave-copy";

describe("personal leave copy", () => {
  it("tells a skipped shared account it is not kept on this computer", () => {
    expect(PERSONAL_LEAVE_SKIPPED_SHARED).toBe(
      "Skipped. Not kept on this computer.",
    );
  });

  it("keeps the skipped line of an account with its own sign-in", () => {
    expect(personalLeaveSkipped("Codex")).toBe(
      "Skipped. Works until Codex asks for a new sign-in.",
    );
  });

  it("keeps the line for a sign-in that was not kept", () => {
    expect(personalLeaveSignInNotKept("Work", "Codex")).toBe(
      "The sign-in for Work wasn't kept. It works until Codex asks for a new sign-in.",
    );
  });
});
