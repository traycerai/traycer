import { describe, expect, it } from "vitest";
import { agentMemoryWriteProgress } from "@/components/settings/panels/agent-memories-write-progress";

describe("agentMemoryWriteProgress for a local_only answer", () => {
  const unreadConfiguration = {
    enabled: false,
    revision: null,
    environmentId: null,
  };

  it.each([true, false])(
    "settles when the answer is the value asked for (%s)",
    (asked) => {
      expect(
        agentMemoryWriteProgress({
          answer: { state: "local_only", enabled: asked },
          asked,
          read: unreadConfiguration,
          queue: undefined,
        }),
      ).toEqual({ kind: "settled" });
    },
  );

  it("is unconfirmed when the answer is not the value asked for", () => {
    expect(
      agentMemoryWriteProgress({
        answer: { state: "local_only", enabled: false },
        asked: true,
        read: unreadConfiguration,
        queue: undefined,
      }),
    ).toEqual({ kind: "unconfirmed" });
  });
});
