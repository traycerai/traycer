import { describe, expect, it } from "vitest";
import { historyScopeToParams, parseHistoryScope } from "@/lib/history-scope";

describe("parseHistoryScope", () => {
  it("accepts the two non-default scopes", () => {
    expect(parseHistoryScope({ historyScope: "tasks" })).toBe("tasks");
    expect(parseHistoryScope({ historyScope: "messages" })).toBe("messages");
  });

  it("falls back to all for missing, explicit-default and invalid values", () => {
    expect(parseHistoryScope({})).toBe("all");
    expect(parseHistoryScope({ historyScope: "all" })).toBe("all");
    expect(parseHistoryScope({ historyScope: "chats" })).toBe("all");
    expect(parseHistoryScope({ historyScope: ["tasks"] })).toBe("all");
    expect(parseHistoryScope({ historyScope: 1 })).toBe("all");
    expect(parseHistoryScope({ historyScope: null })).toBe("all");
  });

  it("ignores unrelated history params", () => {
    expect(parseHistoryScope({ historyQuery: "tasks" })).toBe("all");
  });
});

describe("historyScopeToParams", () => {
  it("omits the default so the URL stays clean", () => {
    expect(historyScopeToParams("all")).toEqual({ historyScope: undefined });
  });

  it("serialises the non-default scopes", () => {
    expect(historyScopeToParams("tasks")).toEqual({ historyScope: "tasks" });
    expect(historyScopeToParams("messages")).toEqual({
      historyScope: "messages",
    });
  });

  it("round-trips through parse", () => {
    for (const scope of ["all", "tasks", "messages"] as const) {
      expect(parseHistoryScope(historyScopeToParams(scope))).toBe(scope);
    }
  });
});
