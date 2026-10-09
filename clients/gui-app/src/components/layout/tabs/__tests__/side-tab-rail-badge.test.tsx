import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SideTabRailBadge } from "../side-strip/side-tab-rail-badge";
import {
  railBadgeOf,
  worstRailBadge,
  type RailBadgeKind,
} from "../side-strip/rail-badge-kind";
import { SIDE_TAB_BADGE_CLASS } from "../side-strip/side-strip-tokens";
import {
  EMPTY_NOTIFICATION_INDICATOR_STATE,
  type NotificationIndicatorState,
} from "@/stores/notifications/notification-indicator-state";

afterEach(() => cleanup());

type Flag = "interview" | "approval" | "failure" | "done";

function indicator(flags: ReadonlyArray<Flag>): NotificationIndicatorState {
  return {
    ...EMPTY_NOTIFICATION_INDICATOR_STATE,
    pendingInterview: flags.includes("interview"),
    pendingApproval: flags.includes("approval"),
    unreadFailure: flags.includes("failure"),
    unreadNonTerminalFailure: flags.includes("failure"),
    unreadDone: flags.includes("done"),
  };
}

const ALL_FLAGS: ReadonlyArray<Flag> = [
  "interview",
  "approval",
  "failure",
  "done",
];

function subsets(): ReadonlyArray<ReadonlyArray<Flag>> {
  const out: Flag[][] = [];
  for (let mask = 0; mask < 1 << ALL_FLAGS.length; mask++) {
    out.push(ALL_FLAGS.filter((_flag, index) => (mask & (1 << index)) !== 0));
  }
  return out;
}

/** Lower is stronger, written out independently of the implementation (D5). */
const STRENGTH: Readonly<Record<RailBadgeKind | "none", number>> = {
  reply: 0,
  approval: 1,
  failed: 2,
  unread: 3,
  none: 4,
};

type PrecedenceCase = readonly [ReadonlyArray<Flag>, RailBadgeKind | null];

const PRECEDENCE: ReadonlyArray<PrecedenceCase> = [
  [[], null],
  [["done"], "unread"],
  [["failure"], "failed"],
  [["failure", "done"], "failed"],
  [["interview"], "reply"],
  [["approval"], "approval"],
  [["approval", "failure"], "approval"],
  [["interview", "failure", "done"], "reply"],
  // Both waiting reasons pending: reply breaks the tie.
  [["interview", "approval"], "reply"],
];

describe("railBadgeOf", () => {
  it.each(PRECEDENCE)("%j gives %s", (flags, badge) => {
    expect(railBadgeOf(indicator(flags))).toBe(badge);
  });

  it("never gets weaker when a flag is added", () => {
    for (const flags of subsets()) {
      const base = railBadgeOf(indicator(flags)) ?? "none";
      for (const extra of ALL_FLAGS) {
        const more = railBadgeOf(indicator([...flags, extra])) ?? "none";
        expect(STRENGTH[more]).toBeLessThanOrEqual(STRENGTH[base]);
      }
    }
  });

  it("gives no badge for a pending fork alone", () => {
    const forkOnly: NotificationIndicatorState = {
      ...EMPTY_NOTIFICATION_INDICATOR_STATE,
      pendingFork: true,
    };
    expect(railBadgeOf(forkOnly)).toBeNull();
  });
});

describe("worstRailBadge", () => {
  it("returns null for no children or only quiet children", () => {
    expect(worstRailBadge([])).toBeNull();
    expect(worstRailBadge([null, null])).toBeNull();
  });

  it("picks the strongest badge across mixed children", () => {
    expect(worstRailBadge([null, "unread", "failed"])).toBe("failed");
    expect(worstRailBadge(["unread", "failed", null, "approval"])).toBe(
      "approval",
    );
    expect(worstRailBadge(["unread", "failed", "reply", "approval"])).toBe(
      "reply",
    );
    expect(worstRailBadge(["unread", null])).toBe("unread");
  });
});

describe("SideTabRailBadge", () => {
  // The names and glyphs are written out, not read from the tone table the
  // badge renders from, so a kind wired to the wrong tone fails here.
  it.each([
    ["approval", "Task waiting for your approval", "approval"],
    ["reply", "Task waiting for your interview response", "interview"],
    ["failed", "Task needs attention", "failure"],
    ["unread", "Task completed", "done"],
  ] as const)(
    "renders the %s badge as %j with its glyph",
    (kind, label, glyph) => {
      render(<SideTabRailBadge kind={kind} size="tile" testId="badge" />);
      const badge = screen.getByTestId("badge");
      expect(badge.dataset.kind).toBe(kind);
      expect(badge.getAttribute("aria-label")).toBe(label);
      expect(
        badge.querySelector(`[data-status-glyph="${glyph}"]`),
      ).not.toBeNull();
    },
  );

  it("renders on a leading-slot badge with the smaller glyph size", () => {
    render(<SideTabRailBadge kind="approval" size="leading" testId="badge" />);
    const badge = screen.getByTestId("badge");
    for (const token of SIDE_TAB_BADGE_CLASS.split(" ")) {
      expect(badge.classList.contains(token)).toBe(true);
    }
    const glyph = badge.querySelector('[data-status-glyph="approval"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.classList.contains("size-3.5")).toBe(true);
    // The wrapper already carries the accessible name; the inner glyph must
    // not double it up for assistive tech.
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
  });
});
