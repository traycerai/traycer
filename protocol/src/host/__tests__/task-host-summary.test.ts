import { describe, expect, it } from "vitest";
import {
  taskHostRowSchema,
  taskSandboxEndSchema,
} from "@traycer/protocol/host/task-host-summary";

const ROW = {
  hostId: "host-9",
  label: "e2e-sbx-stop3",
  principal: { kind: "team" as const, id: "team-1" },
  reach: "same_principal" as const,
};

const END = {
  state: "destroyed" as const,
  destroyedAt: Date.UTC(2026, 9, 27, 6, 21),
  cause: "resting",
  actor: null,
};

describe("TaskHostRow.sandboxEnd", () => {
  it("parses null for a row from a server that does not send the field", () => {
    expect(taskHostRowSchema.parse(ROW).sandboxEnd).toBeNull();
  });

  it("retains a destroyed end, with or without an actor", () => {
    expect(
      taskHostRowSchema.parse({ ...ROW, sandboxEnd: END }).sandboxEnd,
    ).toEqual(END);
    const byAgent = { ...END, cause: "verb", actor: "Release agent" };
    expect(
      taskHostRowSchema.parse({ ...ROW, sandboxEnd: byAgent }).sandboxEnd,
    ).toEqual(byAgent);
  });

  it("strips a field a newer server adds to the end", () => {
    const parsed = taskSandboxEndSchema.parse({ ...END, region: "us" });
    expect(Object.hasOwn(parsed, "region")).toBe(false);
    expect(parsed).toEqual(END);
  });

  it("refuses a state other than destroyed and an unusable time", () => {
    expect(
      taskSandboxEndSchema.safeParse({ ...END, state: "stopped" }).success,
    ).toBe(false);
    expect(
      taskSandboxEndSchema.safeParse({ ...END, destroyedAt: "yesterday" })
        .success,
    ).toBe(false);
  });
});
