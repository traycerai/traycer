import { describe, expect, it } from "vitest";
import type { TaskSandboxEnd } from "@traycer/protocol/host/task-host-summary";
import { taskSandboxEndLine } from "@/lib/sandboxes/task-sandbox-end";

// Built from local parts: the line states local time, as every row does.
const AT = new Date(2026, 9, 28, 1, 27).getTime();

function end(overrides: Partial<TaskSandboxEnd>): TaskSandboxEnd {
  return {
    state: "destroyed",
    destroyedAt: AT,
    cause: "verb",
    actor: null,
    idleMinutes: null,
    ...overrides,
  };
}

describe("taskSandboxEndLine", () => {
  it.each([
    [
      "by you",
      end({ actor: "you" }),
      "e2e-sbx-p1 was destroyed on Oct 28 at 01:27 by you. Its files are gone; this chat stays readable.",
    ],
    [
      "by a member",
      end({ actor: "Dana" }),
      "e2e-sbx-p1 was destroyed on Oct 28 at 01:27 by Dana. Its files are gone; this chat stays readable.",
    ],
    [
      "after resting",
      end({ cause: "resting" }),
      "e2e-sbx-p1 was destroyed on Oct 28 at 01:27 after resting. Its files are gone; this chat stays readable.",
    ],
    [
      "after the idle minutes the server reports",
      end({ cause: "burst-idle", idleMinutes: 12 }),
      "e2e-sbx-p1 was destroyed on Oct 28 at 01:27 after 12 idle minutes. Its files are gone; this chat stays readable.",
    ],
    [
      "after its idle period, from a server that sends no minutes",
      end({ cause: "idle" }),
      "e2e-sbx-p1 was destroyed on Oct 28 at 01:27 after its idle period. Its files are gone; this chat stays readable.",
    ],
  ])("states the end %s, in local time", (_case, ended, line) => {
    expect(taskSandboxEndLine("e2e-sbx-p1", ended, true)).toBe(line);
  });

  it("leaves the promise out where nothing shows the chat has a copy", () => {
    expect(taskSandboxEndLine("e2e-sbx-p1", end({ actor: "you" }), false)).toBe(
      "e2e-sbx-p1 was destroyed on Oct 28 at 01:27 by you. Its files are gone.",
    );
  });
});
