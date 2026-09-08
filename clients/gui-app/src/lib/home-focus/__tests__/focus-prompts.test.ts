import { describe, expect, it } from "vitest";
import {
  buildFocusPrompts,
  countPendingPromptRows,
  focusPromptEpicIds,
  pendingPromptEpicIds,
} from "@/lib/home-focus/focus-prompts";
import {
  makeApprovalPayload,
  makeBrowserSessionPayload,
  makeInterviewPayload,
  makeMergedNotificationRow,
} from "@/lib/home-focus/__tests__/fixtures";

describe("buildFocusPrompts", () => {
  it("only promotes rows whose hostKind is a pending-prompt kind; an agent.stopped failure row is excluded", () => {
    const approvalRow = makeMergedNotificationRow({
      feedId: "host:approval-1",
      hostKind: "approval.requested",
      severity: "needs_action",
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });
    const interviewRow = makeMergedNotificationRow({
      feedId: "host:interview-1",
      hostKind: "interview.requested",
      severity: "needs_action",
      payload: makeInterviewPayload("epic-2", "chat-2"),
    });
    const browserRow = makeMergedNotificationRow({
      feedId: "host:browser-1",
      hostKind: "browser.human.needed",
      severity: "needs_action",
      payload: makeBrowserSessionPayload("epic-3", "session-1", "tab-1"),
    });
    const agentStoppedRow = makeMergedNotificationRow({
      feedId: "host:stopped-1",
      hostKind: "agent.stopped",
      severity: "failure",
    });

    const prompts = buildFocusPrompts(
      [approvalRow, interviewRow, browserRow, agentStoppedRow],
      new Map(),
      [],
    );

    expect(prompts.map((prompt) => prompt.key).sort()).toEqual([
      "host:approval-1",
      "host:browser-1",
      "host:interview-1",
    ]);
  });

  it("excludes a row with resolvedAt !== null", () => {
    const resolved = makeMergedNotificationRow({
      feedId: "host:approval-resolved",
      hostKind: "approval.requested",
      severity: "needs_action",
      resolvedAt: 123,
      readAt: null,
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });

    expect(buildFocusPrompts([resolved], new Map(), [])).toHaveLength(0);
  });

  it("excludes a row with readAt !== null (the lifecycle classifier reads it as recent)", () => {
    const read = makeMergedNotificationRow({
      feedId: "host:approval-read",
      hostKind: "approval.requested",
      severity: "needs_action",
      resolvedAt: null,
      readAt: 50,
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });

    expect(buildFocusPrompts([read], new Map(), [])).toHaveLength(0);
  });

  it("orders blocking before failure, newest createdAt first within a tier, ascending feedId as the tie-break", () => {
    const blockingOld = makeMergedNotificationRow({
      feedId: "host:blocking-old",
      hostKind: "approval.requested",
      severity: "needs_action",
      createdAt: 10,
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });
    const blockingNew = makeMergedNotificationRow({
      feedId: "host:blocking-new",
      hostKind: "interview.requested",
      severity: "needs_action",
      createdAt: 500,
      payload: makeInterviewPayload("epic-2", "chat-2"),
    });
    const blockingTieA = makeMergedNotificationRow({
      feedId: "host:tie-aaa",
      hostKind: "approval.requested",
      severity: "needs_action",
      createdAt: 500,
      payload: makeApprovalPayload("epic-3", "chat-3"),
    });
    const blockingTieB = makeMergedNotificationRow({
      feedId: "host:tie-zzz",
      hostKind: "approval.requested",
      severity: "needs_action",
      createdAt: 500,
      payload: makeApprovalPayload("epic-4", "chat-4"),
    });
    // Deliberately a "failure"-severity row on a pending-prompt hostKind: the
    // ordering rule is about the attention TIER the classifier assigns, and
    // only `needs_action`/unread `failure` rows ever reach the candidate set.
    const failureNewest = makeMergedNotificationRow({
      feedId: "host:failure-newest",
      hostKind: "browser.human.needed",
      severity: "failure",
      createdAt: 100_000,
      payload: makeBrowserSessionPayload("epic-5", "session-1", "tab-1"),
    });

    const prompts = buildFocusPrompts(
      [failureNewest, blockingOld, blockingTieB, blockingNew, blockingTieA],
      new Map(),
      [],
    );

    expect(prompts.map((prompt) => prompt.key)).toEqual([
      "host:blocking-new",
      "host:tie-aaa",
      "host:tie-zzz",
      "host:blocking-old",
      "host:failure-newest",
    ]);
  });

  it("maps kind and target ids from the payload for all three host kinds", () => {
    const approvalRow = makeMergedNotificationRow({
      feedId: "host:approval",
      hostKind: "approval.requested",
      severity: "needs_action",
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });
    const interviewRow = makeMergedNotificationRow({
      feedId: "host:interview",
      hostKind: "interview.requested",
      severity: "needs_action",
      payload: makeInterviewPayload("epic-2", "chat-2"),
    });
    const browserRow = makeMergedNotificationRow({
      feedId: "host:browser",
      hostKind: "browser.human.needed",
      severity: "needs_action",
      payload: makeBrowserSessionPayload("epic-3", "session-1", "tab-1"),
    });
    const nullPayloadRow = makeMergedNotificationRow({
      feedId: "host:null-payload",
      hostKind: "approval.requested",
      severity: "needs_action",
      payload: null,
    });

    const prompts = buildFocusPrompts(
      [approvalRow, interviewRow, browserRow, nullPayloadRow],
      new Map(),
      [],
    );
    const byKey = new Map(prompts.map((prompt) => [prompt.key, prompt]));

    expect(byKey.get("host:approval")).toMatchObject({
      kind: "approval",
      epicId: "epic-1",
      chatId: "chat-1",
    });
    expect(byKey.get("host:interview")).toMatchObject({
      kind: "interview",
      epicId: "epic-2",
      chatId: "chat-2",
    });
    expect(byKey.get("host:browser")).toMatchObject({
      kind: "browser",
      epicId: "epic-3",
      chatId: null,
    });
    expect(byKey.get("host:null-payload")).toMatchObject({
      kind: "approval",
      epicId: null,
      chatId: null,
    });
  });

  it("looks up taskTitle from the passed map, null when absent", () => {
    const withTitle = makeMergedNotificationRow({
      feedId: "host:a",
      hostKind: "approval.requested",
      severity: "needs_action",
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });
    const withoutTitle = makeMergedNotificationRow({
      feedId: "host:b",
      hostKind: "approval.requested",
      severity: "needs_action",
      payload: makeApprovalPayload("epic-2", "chat-2"),
    });
    const titles = new Map([["epic-1", "Epic One"]]);

    const prompts = buildFocusPrompts([withTitle, withoutTitle], titles, []);
    const byKey = new Map(prompts.map((prompt) => [prompt.key, prompt]));

    expect(byKey.get("host:a")?.taskTitle).toBe("Epic One");
    expect(byKey.get("host:b")?.taskTitle).toBeNull();
  });

  it("keeps activation as the original MergedNotificationRow object", () => {
    const row = makeMergedNotificationRow({
      feedId: "host:a",
      hostKind: "approval.requested",
      severity: "needs_action",
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });

    const [prompt] = buildFocusPrompts([row], new Map(), []);

    expect(prompt.activation).toBe(row);
  });

  it("returns the same array reference when rebuilt from unchanged content", () => {
    const row = makeMergedNotificationRow({
      feedId: "host:a",
      hostKind: "approval.requested",
      severity: "needs_action",
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });

    const first = buildFocusPrompts([row], new Map(), []);
    const second = buildFocusPrompts([row], new Map(), first);

    expect(second).toBe(first);
  });

  describe("row identity uses feedId, not activation reference", () => {
    it("reuses the previous row - and its ORIGINAL activation - when rebuilt from a fresh array of content-equal rows", () => {
      const original = makeMergedNotificationRow({
        feedId: "host:a",
        hostKind: "approval.requested",
        severity: "needs_action",
        title: "Approve the plan",
        body: "Body text",
        createdAt: 42,
        payload: makeApprovalPayload("epic-1", "chat-1"),
      });
      const first = buildFocusPrompts([original], new Map(), []);

      // A FRESH object, same feedId/title/body/createdAt - the store re-mints
      // rows like this on any unrelated notification frame.
      const freshEqual = makeMergedNotificationRow({
        feedId: "host:a",
        hostKind: "approval.requested",
        severity: "needs_action",
        title: "Approve the plan",
        body: "Body text",
        createdAt: 42,
        payload: makeApprovalPayload("epic-1", "chat-1"),
      });
      expect(freshEqual).not.toBe(original);

      const second = buildFocusPrompts([freshEqual], new Map(), first);

      expect(second).toBe(first);
      expect(second[0]?.activation).toBe(original);
      expect(second[0]?.activation).not.toBe(freshEqual);
    });

    it("mints a new row when a genuine content change (a new title) lands under the same feedId", () => {
      const original = makeMergedNotificationRow({
        feedId: "host:a",
        hostKind: "approval.requested",
        severity: "needs_action",
        title: "Approve the plan",
        payload: makeApprovalPayload("epic-1", "chat-1"),
      });
      const first = buildFocusPrompts([original], new Map(), []);

      const retitled = makeMergedNotificationRow({
        feedId: "host:a",
        hostKind: "approval.requested",
        severity: "needs_action",
        title: "Approve the REVISED plan",
        payload: makeApprovalPayload("epic-1", "chat-1"),
      });
      const second = buildFocusPrompts([retitled], new Map(), first);

      expect(second).not.toBe(first);
      expect(second[0]?.title).toBe("Approve the REVISED plan");
      expect(second[0]?.activation).toBe(retitled);
    });
  });

  it("countPendingPromptRows(rows) equals buildFocusPrompts(rows, new Map(), []).length across a mixed fixture", () => {
    const eligible = makeMergedNotificationRow({
      feedId: "host:approval-1",
      hostKind: "approval.requested",
      severity: "needs_action",
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });
    const wrongKind = makeMergedNotificationRow({
      feedId: "host:stopped-1",
      hostKind: "agent.stopped",
      severity: "failure",
    });
    const resolved = makeMergedNotificationRow({
      feedId: "host:approval-resolved",
      hostKind: "approval.requested",
      severity: "needs_action",
      resolvedAt: 999,
      payload: makeApprovalPayload("epic-2", "chat-2"),
    });
    const alreadyRead = makeMergedNotificationRow({
      feedId: "host:approval-read",
      hostKind: "approval.requested",
      severity: "needs_action",
      readAt: 10,
      payload: makeApprovalPayload("epic-3", "chat-3"),
    });
    const anotherEligible = makeMergedNotificationRow({
      feedId: "host:browser-1",
      hostKind: "browser.human.needed",
      severity: "needs_action",
      payload: makeBrowserSessionPayload("epic-4", "session-1", "tab-1"),
    });
    const rows = [eligible, wrongKind, resolved, alreadyRead, anotherEligible];

    expect(countPendingPromptRows(rows)).toBe(
      buildFocusPrompts(rows, new Map(), []).length,
    );
    expect(countPendingPromptRows(rows)).toBe(2);
  });

  it("pendingPromptEpicIds agrees with focusPromptEpicIds(buildFocusPrompts(...))", () => {
    const approvalRow = makeMergedNotificationRow({
      feedId: "host:approval-1",
      hostKind: "approval.requested",
      severity: "needs_action",
      payload: makeApprovalPayload("epic-1", "chat-1"),
    });
    const interviewRow = makeMergedNotificationRow({
      feedId: "host:interview-1",
      hostKind: "interview.requested",
      severity: "needs_action",
      payload: makeInterviewPayload("epic-2", "chat-2"),
    });
    const agentStoppedRow = makeMergedNotificationRow({
      feedId: "host:stopped-1",
      hostKind: "agent.stopped",
      severity: "failure",
    });
    const rows = [approvalRow, interviewRow, agentStoppedRow];

    const prompts = buildFocusPrompts(rows, new Map(), []);

    expect(pendingPromptEpicIds(rows)).toEqual(focusPromptEpicIds(prompts));
    expect(pendingPromptEpicIds(rows)).toEqual(new Set(["epic-1", "epic-2"]));
  });
});
