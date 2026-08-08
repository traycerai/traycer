import { describe, expect, it } from "vitest";
import { classifyCloudStreamClose } from "@/lib/comm-graph/comm-graph-cloud-stream-opener";

describe("classifyCloudStreamClose", () => {
  it("treats a remote stream compatibility failure as unsupported", () => {
    expect(
      classifyCloudStreamClose("unknown", {
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "method is not compatible",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      }),
    ).toBe("unsupported");
  });

  it("keeps a remote transport failure unreachable", () => {
    expect(
      classifyCloudStreamClose("unknown", {
        kind: "fatalError",
        details: {
          code: "UNAUTHORIZED",
          reason: "authorization failed",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      }),
    ).toBe("unreachable");
  });
});
