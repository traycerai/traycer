import { describe, expect, it } from "vitest";
import {
  inviteSentBody,
  pendingRemovalLabel,
} from "@/components/settings/members/copy";

describe("pendingRemovalLabel", () => {
  it.each([
    [null, "removing"],
    [0, "removing"],
    [1, "removing · waiting for 1 host"],
    [3, "removing · waiting for 3 hosts"],
  ])("words %s hosts as %s", (hostCount, label) => {
    expect(pendingRemovalLabel(hostCount)).toBe(label);
  });
});

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
