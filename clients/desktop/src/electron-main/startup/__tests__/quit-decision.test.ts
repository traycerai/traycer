import { describe, expect, it, vi } from "vitest";
import type { QuitDecision } from "../../../ipc-contracts/app-lifecycle-types";
import { applyQuitDecision } from "../quit-decision";

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("applyQuitDecision", () => {
  const QUITTING_DECISIONS: ReadonlyArray<QuitDecision> = [
    "proceed",
    "userConfirmedDiscard",
  ];

  for (const decision of QUITTING_DECISIONS) {
    it(`authorizes the quit for "${decision}" and never calls stayOpen`, () => {
      const authorizeQuitAfterFlush = vi.fn();
      const stayOpen = vi.fn();

      applyQuitDecision(decision, { authorizeQuitAfterFlush, stayOpen });

      expect(authorizeQuitAfterFlush).toHaveBeenCalledTimes(1);
      expect(stayOpen).not.toHaveBeenCalled();
    });
  }

  it('stays open for "userCancelled" and never authorizes the quit', () => {
    const authorizeQuitAfterFlush = vi.fn();
    const stayOpen = vi.fn();

    applyQuitDecision("userCancelled", { authorizeQuitAfterFlush, stayOpen });

    expect(stayOpen).toHaveBeenCalledTimes(1);
    expect(authorizeQuitAfterFlush).not.toHaveBeenCalled();
  });
});
