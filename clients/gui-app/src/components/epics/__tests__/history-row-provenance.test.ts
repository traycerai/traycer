import { describe, expect, it } from "vitest";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import {
  historyRowProvenance,
  historyRowProvenanceTitle,
} from "@/components/epics/history-row-provenance";

function historyItem(overrides: Partial<HistoryItem>): HistoryItem {
  return {
    id: "history-epic-1",
    epicId: "epic-from-history",
    taskType: "epic",
    title: "Open from landing",
    initialUserPrompt: "",
    updatedAtMs: 1_700_000_000_000,
    updatedLabel: "about 2 hours ago",
    updatedBucket: "today",
    linkedRepos: [],
    linkedWorkspaces: [],
    chatHostIds: null,
    pullRequestNumbers: [],
    worktreeBranches: [],
    worktreePaths: [],
    ownership: "mine",
    permissionRole: "owner",
    isPinned: false,
    ...overrides,
  };
}

describe("historyRowProvenance", () => {
  it("is null for a phase even when both markers are set", () => {
    const item = historyItem({
      taskType: "phase",
      isPreservedOrphan: true,
      isLocalHome: true,
    });

    expect(historyRowProvenance(item)).toBeNull();
  });

  it("reads a preserved orphan as preserved-orphan even when isLocalHome is also true", () => {
    const item = historyItem({
      isPreservedOrphan: true,
      isLocalHome: true,
    });

    expect(historyRowProvenance(item)).toBe("preserved-orphan");
  });

  it("reads a local-home row as local-only", () => {
    const item = historyItem({ isLocalHome: true });

    expect(historyRowProvenance(item)).toBe("local-only");
  });

  it("is null for a plain epic carrying neither marker", () => {
    const item = historyItem({});

    expect(historyRowProvenance(item)).toBeNull();
  });
});

describe("historyRowProvenanceTitle", () => {
  it("never names the cloud or the device in any of the three sentences", () => {
    const titles = [
      historyRowProvenanceTitle("preserved-orphan", true),
      historyRowProvenanceTitle("local-only", true),
      historyRowProvenanceTitle("local-only", false),
    ];

    for (const title of titles) {
      expect(title).not.toMatch(/cloud/i);
      expect(title).not.toMatch(/device/i);
    }
  });

  it("tells a preserved-orphan viewer to export their edits", () => {
    expect(historyRowProvenanceTitle("preserved-orphan", true)).toMatch(
      /export/i,
    );
    expect(historyRowProvenanceTitle("preserved-orphan", false)).toMatch(
      /export/i,
    );
  });

  it("tells an authorized local-only viewer to open the task to sync", () => {
    expect(historyRowProvenanceTitle("local-only", true)).toMatch(
      /open this task/i,
    );
  });

  it("tells an unauthorized local-only viewer to sign in again", () => {
    expect(historyRowProvenanceTitle("local-only", false)).toMatch(/sign in/i);
  });
});
