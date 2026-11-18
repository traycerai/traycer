import { describe, expect, it } from "vitest";
import { tabWaitingReason, withWaitingIndicator } from "../tab-waiting";
import type { EpicWaitingReason } from "@/hooks/epic/use-epic-activity-status";
import {
  EMPTY_NOTIFICATION_INDICATOR_STATE,
  type NotificationIndicatorState,
} from "@/stores/notifications/notification-indicator-state";

function indicator(
  pendingInterview: boolean,
  pendingApproval: boolean,
): NotificationIndicatorState {
  return {
    ...EMPTY_NOTIFICATION_INDICATOR_STATE,
    pendingInterview,
    pendingApproval,
  };
}

interface Case {
  readonly pendingInterview: boolean;
  readonly pendingApproval: boolean;
  readonly session: EpicWaitingReason | null;
  readonly reason: EpicWaitingReason | null;
}

const CASES: readonly Case[] = [
  {
    pendingInterview: false,
    pendingApproval: false,
    session: null,
    reason: null,
  },
  {
    pendingInterview: false,
    pendingApproval: false,
    session: "approval",
    reason: "approval",
  },
  {
    pendingInterview: false,
    pendingApproval: false,
    session: "reply",
    reason: "reply",
  },
  {
    pendingInterview: false,
    pendingApproval: true,
    session: null,
    reason: "approval",
  },
  {
    pendingInterview: false,
    pendingApproval: true,
    session: "approval",
    reason: "approval",
  },
  {
    pendingInterview: false,
    pendingApproval: true,
    session: "reply",
    reason: "reply",
  },
  {
    pendingInterview: true,
    pendingApproval: false,
    session: null,
    reason: "reply",
  },
  {
    pendingInterview: true,
    pendingApproval: false,
    session: "approval",
    reason: "reply",
  },
  {
    pendingInterview: true,
    pendingApproval: false,
    session: "reply",
    reason: "reply",
  },
  {
    pendingInterview: true,
    pendingApproval: true,
    session: null,
    reason: "reply",
  },
  {
    pendingInterview: true,
    pendingApproval: true,
    session: "approval",
    reason: "reply",
  },
  {
    pendingInterview: true,
    pendingApproval: true,
    session: "reply",
    reason: "reply",
  },
];

describe("tabWaitingReason", () => {
  it.each(CASES)(
    "interview=$pendingInterview approval=$pendingApproval session=$session reads $reason",
    ({ pendingInterview, pendingApproval, session, reason }) => {
      expect(
        tabWaitingReason(indicator(pendingInterview, pendingApproval), session),
      ).toBe(reason);
    },
  );
});

interface MergeCase {
  readonly name: string;
  readonly input: NotificationIndicatorState;
  readonly reason: EpicWaitingReason | null;
  readonly pendingInterview: boolean;
  readonly pendingApproval: boolean;
  readonly sameObject: boolean;
}

const MERGE_CASES: readonly MergeCase[] = [
  {
    name: "no reason keeps the indicator as it is",
    input: indicator(false, true),
    reason: null,
    pendingInterview: false,
    pendingApproval: true,
    sameObject: true,
  },
  {
    name: "a reply lights the interview bit",
    input: indicator(false, false),
    reason: "reply",
    pendingInterview: true,
    pendingApproval: false,
    sameObject: false,
  },
  {
    name: "a reply leaves a lit approval bit lit",
    input: indicator(false, true),
    reason: "reply",
    pendingInterview: true,
    pendingApproval: true,
    sameObject: false,
  },
  {
    name: "a reply with both bits already lit is a no-op",
    input: indicator(true, true),
    reason: "reply",
    pendingInterview: true,
    pendingApproval: true,
    sameObject: true,
  },
  {
    name: "a reply over a lit interview bit is a no-op",
    input: indicator(true, false),
    reason: "reply",
    pendingInterview: true,
    pendingApproval: false,
    sameObject: true,
  },
  {
    name: "an approval lights the approval bit",
    input: indicator(false, false),
    reason: "approval",
    pendingInterview: false,
    pendingApproval: true,
    sameObject: false,
  },
  {
    name: "an approval over a lit approval bit is a no-op",
    input: indicator(false, true),
    reason: "approval",
    pendingInterview: false,
    pendingApproval: true,
    sameObject: true,
  },
  {
    name: "an approval leaves a lit interview bit lit",
    input: indicator(true, false),
    reason: "approval",
    pendingInterview: true,
    pendingApproval: true,
    sameObject: false,
  },
];

describe("withWaitingIndicator", () => {
  it.each(MERGE_CASES)(
    "$name",
    ({ input, reason, pendingInterview, pendingApproval, sameObject }) => {
      const before = { ...input };
      const merged = withWaitingIndicator(input, reason);
      expect(merged.pendingInterview).toBe(pendingInterview);
      expect(merged.pendingApproval).toBe(pendingApproval);
      // Every other field rides through untouched.
      expect({
        ...merged,
        pendingInterview: input.pendingInterview,
        pendingApproval: input.pendingApproval,
      }).toEqual(input);
      // The same object when nothing changed, so memoised readers stay put.
      expect(merged === input).toBe(sameObject);
      // Never mutates its input.
      expect(input).toEqual(before);
    },
  );
});
