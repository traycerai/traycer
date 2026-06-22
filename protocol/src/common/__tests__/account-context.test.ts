import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_CONTEXT,
  parseAccountContext,
  serializeAccountContext,
  type AccountContext,
} from "../schemas";

describe("account-context wire codec", () => {
  it("round-trips PERSONAL and TEAM", () => {
    const cases: AccountContext[] = [
      { type: "PERSONAL" },
      { type: "TEAM", teamId: "team-123" },
    ];
    for (const ctx of cases) {
      expect(parseAccountContext(serializeAccountContext(ctx))).toEqual(ctx);
    }
  });

  it("falls back to PERSONAL for missing/empty/garbage/empty-teamId", () => {
    expect(parseAccountContext(undefined)).toEqual(DEFAULT_ACCOUNT_CONTEXT);
    expect(parseAccountContext("")).toEqual(DEFAULT_ACCOUNT_CONTEXT);
    expect(parseAccountContext("nonsense")).toEqual(DEFAULT_ACCOUNT_CONTEXT);
    expect(parseAccountContext("TEAM:")).toEqual(DEFAULT_ACCOUNT_CONTEXT);
  });
});
