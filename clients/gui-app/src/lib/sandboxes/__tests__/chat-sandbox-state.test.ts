import { describe, expect, it } from "vitest";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  movingSandboxLine,
  type SandboxMovingState,
} from "@/lib/sandboxes/chat-sandbox-state";

describe("movingSandboxLine", () => {
  it.each([
    ["creating", "Starting e2e-sbx-p1 · pending"],
    ["starting", "Starting e2e-sbx-p1 · pending"],
    ["resuming", "Resuming e2e-sbx-p1 · pending"],
    ["suspending", "Suspending e2e-sbx-p1 · pending"],
    ["stopping", "Stopping e2e-sbx-p1 · pending"],
    ["destroying", "Destroying e2e-sbx-p1 · pending"],
  ] as const satisfies ReadonlyArray<readonly [SandboxMovingState, string]>)(
    "says a %s sandbox as its row does, by name",
    (state, line) => {
      const sandbox = sandboxSummaryFixture({
        displayName: "e2e-sbx-p1",
        state,
      });

      expect(movingSandboxLine({ kind: "moving", sandbox, state })).toBe(line);
    },
  );
});
