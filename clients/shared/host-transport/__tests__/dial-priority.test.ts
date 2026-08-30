import { describe, expect, it } from "vitest";
import { dialPriorityForMethod } from "../dial-priority";

describe("dialPriorityForMethod", () => {
  it("classifies a method on the background list as background", () => {
    expect(dialPriorityForMethod("agent.gui.listModels")).toBe("background");
  });

  it("defaults an unlisted method to interactive, so a method nobody classified is never starved", () => {
    expect(dialPriorityForMethod("some.method.nobody.listed")).toBe(
      "interactive",
    );
  });

  it.each([
    "epic.status.subscribe",
    "epic.state.subscribe",
    "artifact.subscribe",
    "chat.subscribe",
    "terminal.subscribe",
    "epic.getWorkspaceContext",
  ])("keeps the mounted-surface method %s interactive", (method) => {
    expect(dialPriorityForMethod(method)).toBe("interactive");
  });
});
