import { describe, expect, it } from "vitest";
import { stopCleanup } from "@/components/settings/move/stop-cleanup";
import {
  environmentStatusFixture,
  itemStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";

const STOPPED_AT = Date.UTC(2026, 9, 1);

describe("stopCleanup", () => {
  it.each([
    ["permission_denied", "LOG_LEVEL couldn't be removed: permission denied."],
    ["some_future_code", "LOG_LEVEL couldn't be removed."],
    ["constructor", "LOG_LEVEL couldn't be removed."],
  ])("a removal that failed with code %s reads: %s", (code, text) => {
    const cleanup = stopCleanup(
      environmentStatusFixture({
        stoppedAt: STOPPED_AT,
        items: [
          itemStatusFixture({
            kind: "variable",
            key: "LOG_LEVEL",
            status: "failed",
            code,
          }),
        ],
      }),
    );
    expect(cleanup?.failedLines).toEqual([
      { id: JSON.stringify(["variable", "LOG_LEVEL"]), text },
    ]);
  });
});
