import { describe, expect, it } from "vitest";
import { AnalyticsEvent, sanitizeAnalyticsProperties } from "@/lib/analytics";

describe("visualization analytics events (D31)", () => {
  it.each(["approved", "denied", "refused"])(
    "passes mcp_app_call %s through unchanged",
    (outcome) => {
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.McpAppCall, { outcome }),
      ).toEqual({ outcome });
    },
  );

  it("drops an mcp_app_call whose value is outside the allowed set", () => {
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.McpAppCall, {
        outcome: "delete_row",
      }),
    ).toBeNull();
  });

  it("strips content a caller attaches next to the allowed property", () => {
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.McpAppCall, {
        outcome: "approved",
        tool: "delete",
        server: "acme",
      }),
    ).toEqual({ outcome: "approved" });
  });
});
