import { describe, expect, it } from "vitest";
import { inviteSentBody } from "@/components/settings/members/copy";

describe("inviteSentBody", () => {
  it.each([
    ["admin", "an admin"],
    ["editor", "an editor"],
    ["viewer", "a viewer"],
  ] as const)("names a %s with its article", (role, phrase) => {
    expect(inviteSentBody("sam@acme.test", "Acme", role)).toBe(
      `We emailed sam@acme.test. They join Acme as ${phrase} when they accept.`,
    );
  });
});
