import { describe, expect, it } from "vitest";
import { taskSandboxEndLine } from "@/lib/sandboxes/task-sandbox-end";

describe("taskSandboxEndLine", () => {
  it("labels the UTC end time and preserves the cause-specific sentence", () => {
    expect(
      taskSandboxEndLine("e2e-sbx-stop3", {
        state: "destroyed",
        destroyedAt: Date.UTC(2026, 9, 27, 6, 21),
        cause: "resting",
        actor: null,
      }),
    ).toBe(
      "e2e-sbx-stop3 was destroyed on Oct 27 at 06:21 UTC after its resting period. Its files are gone; this chat stays readable.",
    );
  });
});
