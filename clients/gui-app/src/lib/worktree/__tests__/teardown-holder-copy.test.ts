import { describe, expect, it } from "vitest";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import {
  canSubmitExpectedHoldersRevision,
  formatHolderSentence,
  formatStopHeading,
  formatTeardownActors,
  formatUncheckedInUseKnown,
  formatUncheckedInUseUnknown,
  formatUnknownHolderConsequence,
  holderIdOf,
  sanitizeHoldersRevision,
  UNNAMED_AGENT_FALLBACK,
} from "@/lib/worktree/teardown-holder-copy";

const REV_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const OWNER: WorktreeBusyHolder["ownerRef"] = {
  epicId: "epic-1",
  ownerKind: "chat",
  ownerId: "chat-1",
};

function holder(
  over: Partial<WorktreeBusyHolder> &
    Pick<WorktreeBusyHolder, "holdKind" | "activity" | "label">,
): WorktreeBusyHolder {
  return { ownerRef: OWNER, ...over };
}

describe("teardown holder copy", () => {
  const names = new Map<string, string>([
    ["chat:chat-1", "Fixing persistent busyness"],
  ]);

  it("composes actor sentences and never says Run directory or busy", () => {
    const sentences = [
      formatHolderSentence(
        holder({
          holdKind: "chat-turn",
          activity: "working",
          label: "ignored",
        }),
        names,
      ),
      formatHolderSentence(
        holder({
          holdKind: "terminal-agent-pty",
          activity: "idle",
          label: "Claude Code agent polite-ocelot is working",
          ownerRef: {
            epicId: "epic-1",
            ownerKind: "terminal-agent",
            ownerId: "tui-1",
          },
        }),
        new Map(),
      ),
      formatHolderSentence(
        holder({
          holdKind: "supervised-shell",
          activity: "working",
          label: "bun run dev",
        }),
        names,
      ),
      formatHolderSentence(
        holder({
          holdKind: "active-run-cwd",
          activity: "working",
          label: "Run directory",
        }),
        names,
      ),
    ];
    expect(sentences).toEqual([
      "Agent “Fixing persistent busyness” is working on a turn — will be stopped",
      "Terminal agent “Claude Code agent polite-ocelot” is idle — terminal will be closed",
      "Shell “bun run dev” is running — will be stopped",
      "Agent “Fixing persistent busyness” is still running from this worktree — will be stopped",
    ]);
    expect(sentences.join("\n")).not.toMatch(
      /Run directory|\bbusy\b|holder|PTY|\bowner\b/i,
    );
  });

  it("groups same-identity records into one actor", () => {
    const first: WorktreeBusyHolder & { readonly holderId: string } = {
      ...holder({
        holdKind: "chat-turn",
        activity: "working",
        label: "a",
      }),
      holderId: "chat:chat-1",
    };
    const second: WorktreeBusyHolder & { readonly holderId: string } = {
      ...first,
      label: "b",
    };
    const actors = formatTeardownActors([first, second], names);
    expect(actors).toHaveLength(1);
    expect(actors[0]?.holders).toHaveLength(2);
  });

  it("attributes the unknown fallback to a worktree identity", () => {
    expect(formatUnknownHolderConsequence("feat-octopus")).toBe(
      "This host reports background work in feat-octopus, but cannot identify it. That work will be stopped before sweeping.",
    );
    expect(formatUncheckedInUseUnknown()).toContain("cannot identify it");
    expect(formatUncheckedInUseKnown(2)).toBe(
      "In use by 2 processes · Select individually to review",
    );
  });

  it("echoes a holdersRevision only when it is a 64-hex digest", () => {
    const withId = {
      ...holder({
        holdKind: "chat-turn",
        activity: "working",
        label: "a",
      }),
      holderId: "epic-1:chat:chat-1",
    };
    expect(holderIdOf(withId)).toBe("epic-1:chat:chat-1");
    expect(canSubmitExpectedHoldersRevision(REV_A)).toBe(true);
    expect(canSubmitExpectedHoldersRevision(undefined)).toBe(false);
    expect(canSubmitExpectedHoldersRevision("")).toBe(false);
    expect(canSubmitExpectedHoldersRevision("rev-1")).toBe(false);
    expect(sanitizeHoldersRevision(REV_A)).toBe(REV_A);
    expect(sanitizeHoldersRevision("rev-abc")).toBeUndefined();
  });

  it("never uses Run directory as a name when the map is empty", () => {
    const sentence = formatHolderSentence(
      holder({
        holdKind: "active-run-cwd",
        activity: "working",
        label: "Run directory",
      }),
      new Map(),
    );
    expect(sentence).toBe(
      `Agent “${UNNAMED_AGENT_FALLBACK}” is still running from this worktree — will be stopped`,
    );
    expect(sentence).not.toMatch(/Run directory/i);
  });

  it("formats mixed hold kinds for one actor from the working record and keeps evidence", () => {
    const idleChat: WorktreeBusyHolder & { readonly holderId: string } = {
      ...holder({
        holdKind: "chat-turn",
        activity: "idle",
        label: "a",
      }),
      holderId: "epic-1:chat:chat-1",
    };
    const workingRun: WorktreeBusyHolder & { readonly holderId: string } = {
      ...holder({
        holdKind: "active-run-cwd",
        activity: "working",
        label: "Run directory",
      }),
      holderId: "epic-1:chat:chat-1",
    };
    const actors = formatTeardownActors([idleChat, workingRun], names);
    expect(actors).toHaveLength(1);
    expect(actors[0]?.tone).toBe("working");
    expect(actors[0]?.sentence).toContain("still running from this worktree");
    expect(
      actors[0]?.evidence.some((line) => line.includes("idle session")),
    ).toBe(true);
  });

  it("does not claim an exact process count when unknown inventories are mixed in", () => {
    expect(formatStopHeading({ knownActors: 1, unknownRows: 1 })).toBe(
      "1 process will be stopped, and unidentified background work",
    );
    expect(formatStopHeading({ knownActors: 0, unknownRows: 2 })).toBe(
      "Unidentified background work will be stopped",
    );
  });
});
