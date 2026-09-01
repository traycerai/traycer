import { describe, expect, it } from "vitest";
import { draftRequiresClaim } from "@/lib/drafts/draft-authority";

describe("draftRequiresClaim", () => {
  it("is false for an own draft on this tab's host", () => {
    expect(draftRequiresClaim("host-a", "own", "host-a")).toBe(false);
  });

  it("is true for a replica or a foreign owner", () => {
    expect(draftRequiresClaim("host-a", "replica", "host-a")).toBe(true);
    expect(draftRequiresClaim("host-a", "own", "host-b")).toBe(true);
  });
});
