import { describe, expect, it } from "vitest";
import type { MigrationJournal } from "@traycer/protocol/config/data-migration-contracts";
import { engineBlocker, type EngineResult } from "../../engine/engine-types";
import { sampleJournal } from "../../engine/__tests__/engine-fixtures";
import type { DataCommandOutcome } from "../data-command-types";
import { stoppedOutcome } from "../data-report";

// The wording the engine gives a source-change stop; named here as literals so
// the test imports nothing the production change introduces.
const SOURCE_CHANGED_MESSAGE =
  "the data folder changed while the move was running; run `traycer data recover --rollback` and start the move again";

function copyingJournal(): MigrationJournal {
  return { ...sampleJournal({ maintenanceBuild: null }), phase: "copying" };
}

function stoppedWith(
  code: string,
  message: string,
): Extract<EngineResult, { kind: "stopped" }> {
  return {
    kind: "stopped",
    reason: "conflict",
    journal: copyingJournal(),
    blockers: [engineBlocker(code, "notes/readme.txt", message)],
    impact: null,
  };
}

function textOf(outcome: DataCommandOutcome): string {
  if (outcome.status !== "error")
    throw new Error("expected an error outcome for a stopped run");
  return outcome.text.join("\n");
}

describe("traycer data recover after a stop", () => {
  it("a forward recover after a source change points only at rollback", () => {
    const text = textOf(
      stoppedOutcome(
        stoppedWith("source-modified", SOURCE_CHANGED_MESSAGE),
        [],
      ),
    );
    expect(text).toContain("traycer data recover --rollback");
    expect(text).toContain("until this move is rolled back");
    expect(text).not.toContain("continue the move");
    expect(text).not.toMatch(/traycer data recover\s{2,}continue/u);
  });

  it("a forward recover stopped for another reason still offers continue and rollback", () => {
    const text = textOf(
      stoppedOutcome(
        stoppedWith(
          "process-using-data-folder",
          "a process is using the data folder",
        ),
        [],
      ),
    );
    expect(text).toContain("continue the move");
    expect(text).toContain("traycer data recover --rollback");
  });
});
