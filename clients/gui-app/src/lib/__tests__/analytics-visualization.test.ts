import { describe, expect, it } from "vitest";
import { AnalyticsEvent, sanitizeAnalyticsProperties } from "@/lib/analytics";

describe("visualization analytics events (D31)", () => {
  it.each(["expand", "download"])(
    "passes page_action %s through unchanged",
    (action) => {
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.PageAction, { action }),
      ).toEqual({ action });
    },
  );

  it.each(["approved", "denied", "refused"])(
    "passes mcp_app_call %s through unchanged",
    (outcome) => {
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.McpAppCall, { outcome }),
      ).toEqual({ outcome });
    },
  );

  it("drops a page_action whose value is outside the allowed set", () => {
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.PageAction, {
        action: "/Users/me/secret-report.html",
      }),
    ).toBeNull();
  });

  it("drops an mcp_app_call whose value is outside the allowed set", () => {
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.McpAppCall, {
        outcome: "delete_row",
      }),
    ).toBeNull();
  });

  it("strips content a caller attaches next to the allowed property", () => {
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.PageAction, {
        action: "expand",
        title: "Q3 revenue",
        path: "pages/q3.html",
      }),
    ).toEqual({ action: "expand" });
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.McpAppCall, {
        outcome: "approved",
        tool: "delete",
        server: "acme",
      }),
    ).toEqual({ outcome: "approved" });
  });

  it("sends files_panel_opened with no properties, whatever a caller attaches", () => {
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.FilesPanelOpened, null),
    ).toEqual({});
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.FilesPanelOpened, {
        path: "a.txt",
      }),
    ).toEqual({});
  });
});
