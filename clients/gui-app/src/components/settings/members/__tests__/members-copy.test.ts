import { describe, expect, it } from "vitest";
import {
  MEMBER_REMOVED_TOAST,
  demotionConfirmBody,
  demotionConfirmLabel,
  demotionConfirmTitle,
  inviteSentBody,
  isRoleDemotion,
  legacyRoleNotice,
  memberDetailLine,
  memberRemovedToastBody,
  memberRowTitle,
  removePreviewTitle,
  viewerCanSeeLine,
} from "@/components/settings/members/copy";
import type { MembersListMember } from "@/components/settings/members/types";

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

function member(overrides: Partial<MembersListMember>): MembersListMember {
  return {
    userId: "u-1",
    displayName: "Priya Rao",
    email: "priya@acme.test",
    effectiveRole: "editor",
    linkedPlan: false,
    inviteState: "accepted",
    invitedAddress: null,
    removalState: "none",
    ...overrides,
  };
}

/** NEW-154-2: the row, the preview and the toast call one person one name. */
describe("one name everywhere", () => {
  it("names the row by name with the email on its sub-line", () => {
    const row = member({});
    expect(memberRowTitle(row, false)).toBe("Priya Rao");
    expect(
      memberDetailLine(row, {
        isSelf: false,
        isLastAdmin: false,
        viewerIsAdmin: true,
      }),
    ).toBe("priya@acme.test");
  });

  it("lets the email stand in as the name only when the person has none", () => {
    const row = member({ displayName: null });
    expect(memberRowTitle(row, false)).toBe("priya@acme.test");
    expect(
      memberDetailLine(row, {
        isSelf: false,
        isLastAdmin: false,
        viewerIsAdmin: true,
      }),
    ).toBe("");
    expect(
      removePreviewTitle("priya@acme.test", "priya@acme.test", "Acme"),
    ).toBe("Remove priya@acme.test from Acme");
  });

  it("names the preview by name with the email beside it", () => {
    expect(removePreviewTitle("Priya Rao", "priya@acme.test", "Acme")).toBe(
      "Remove Priya Rao (priya@acme.test) from Acme",
    );
  });

  it("names the toast by the same name", () => {
    expect(MEMBER_REMOVED_TOAST).toBe("Member removed");
    expect(memberRemovedToastBody("Priya Rao", "Acme")).toBe(
      "Priya Rao is no longer in Acme.",
    );
  });
});

/** NEW-154-26: the roles notice says whether anyone's access actually changed. */
describe("legacyRoleNotice", () => {
  it("says every member already could edit when nobody gained editing", () => {
    expect(legacyRoleNotice("Acme", [])).toBe(
      "With this update every existing member can edit Acme's settings, as each one already could. Set a role beside each name to change that.",
    );
  });

  it("names the one person who gained editing", () => {
    expect(legacyRoleNotice("Acme", ["Priya"])).toBe(
      "With this update every existing member can edit Acme's settings. Priya can now edit. Set a role beside each name to change that.",
    );
  });

  it("joins two and three names who gained editing", () => {
    expect(legacyRoleNotice("Acme", ["Priya", "Grace"])).toContain(
      "Priya and Grace can now edit.",
    );
    expect(legacyRoleNotice("Acme", ["Priya", "Grace", "Ada"])).toContain(
      "Priya, Grace and Ada can now edit.",
    );
  });
});

/** NEW-154-23: a confirm on every demotion, and none on a promotion. */
describe("role changes that need a confirm", () => {
  it.each([
    ["admin", "editor"],
    ["admin", "viewer"],
    ["editor", "viewer"],
  ] as const)("treats %s to %s as a demotion", (from, to) => {
    expect(isRoleDemotion(from, to)).toBe(true);
  });

  it.each([
    ["viewer", "editor"],
    ["viewer", "admin"],
    ["editor", "admin"],
    ["editor", "editor"],
  ] as const)("treats %s to %s as no demotion", (from, to) => {
    expect(isRoleDemotion(from, to)).toBe(false);
  });

  it("asks the question with the role being given", () => {
    expect(demotionConfirmTitle("Priya", "Acme", "editor")).toBe(
      "Change Priya's role in Acme to editor?",
    );
    expect(demotionConfirmTitle("Priya", "Acme", "viewer")).toBe(
      "Change Priya's role in Acme to viewer?",
    );
  });

  it("says what an admin loses, what an editor loses, and both for admin to viewer", () => {
    expect(demotionConfirmBody("Priya", "Acme", "admin", "editor")).toBe(
      "Priya can no longer invite people, change roles or edit the approval policy.",
    );
    expect(demotionConfirmBody("Priya", "Acme", "editor", "viewer")).toBe(
      "Priya can no longer change Acme's settings. They can still see them.",
    );
    expect(demotionConfirmBody("Priya", "Acme", "admin", "viewer")).toBe(
      "Priya can no longer invite people, change roles or edit the approval policy. Priya can no longer change Acme's settings. They can still see them.",
    );
  });

  it("names the role on the button", () => {
    expect(demotionConfirmLabel("editor")).toBe("Change to editor");
    expect(demotionConfirmLabel("viewer")).toBe("Change to viewer");
  });
});

/** NEW-154-24: one standing line for a viewer, on every page. */
describe("viewerCanSeeLine", () => {
  it("says what a viewer can and cannot do", () => {
    expect(viewerCanSeeLine("Acme")).toBe(
      "You can see Acme's settings but not change them.",
    );
  });
});
