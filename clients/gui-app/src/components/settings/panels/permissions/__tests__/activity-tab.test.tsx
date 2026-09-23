import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoJudgeRecentEntry } from "@traycer/protocol/host/auto-mode/contracts";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { ActivityTab } from "@/components/settings/panels/permissions/activity-tab";
import type { VisibleChat } from "@/hooks/chats/use-visible-chats";
import {
  AUTO_JUDGE_ALLOW_FROM_NOW_ON_LABEL,
  autoModeRuleDisplayName,
  autoModeRuleDraftAction,
  autoModeRuleDraftText,
} from "@/lib/auto-mode/auto-mode-rule-copy";
import type { SettingsRuleDraft } from "@/stores/tabs/system-overlay-types";

// ---- host boundary --------------------------------------------------------

vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () =>
    hostScopeFixture({ status: "following", hostId: "host-a" }),
}));
vi.mock("@/components/settings/host-scope/use-scoped-host-binding", () => ({
  useScopedHostBinding: () => ({ hostId: "host-a" }),
}));
vi.mock("@/hooks/host/use-host-capability-probe", () => ({
  useHostCapabilityProbe: (args: {
    readonly client: unknown;
    readonly stale: boolean;
    readonly incarnation: ReadonlyArray<unknown>;
  }): void => {
    void args;
  },
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "viewer-a",
}));
const support = vi.hoisted((): { listRecent: boolean | null } => ({
  listRecent: true,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "autoJudge.listRecent" ? support.listRecent : null,
  useHostSupportsMethod: () => false,
}));

// ---- data -----------------------------------------------------------------

const recent = vi.hoisted(
  (): {
    entries: ReadonlyArray<AutoJudgeRecentEntry> | undefined;
    isError: boolean;
  } => ({ entries: [], isError: false }),
);
vi.mock("@/hooks/auto-mode/use-auto-judge-recent-query", () => ({
  useAutoJudgeRecentQuery: () => ({
    data:
      recent.entries === undefined ? undefined : { entries: recent.entries },
    isError: recent.isError,
  }),
}));

const visibleChats = vi.hoisted(
  (): { current: ReadonlyMap<string, VisibleChat> } => ({
    current: new Map(),
  }),
);
vi.mock("@/hooks/chats/use-visible-chats", () => ({
  useVisibleChats: () => visibleChats.current,
}));

// ---- fixtures -------------------------------------------------------------

function entry(overrides: Partial<AutoJudgeRecentEntry>): AutoJudgeRecentEntry {
  return {
    id: "entry-1",
    at: new Date().toISOString(),
    chatId: "chat-1",
    chatTitle: "Fix the build",
    toolName: "Bash",
    inputSummary: "git push --force origin main",
    outcome: "allow",
    stage: "fast",
    rule: null,
    reason: null,
    tier: null,
    judge: { harnessId: "traycer", model: "haiku" },
    judgeKind: "traycer",
    judgeSource: "default",
    unattended: false,
    failureKind: null,
    ...overrides,
  };
}

const ALLOWED = entry({ id: "a", outcome: "allow" });
const ASKED = entry({
  id: "b",
  outcome: "block",
  unattended: false,
  rule: "Force Push",
  tier: "soft",
  reason: "Pushes over remote history",
});
const REFUSED = entry({
  id: "c",
  outcome: "block",
  unattended: true,
  rule: "Force Push",
  tier: "soft",
  reason: "Pushes over remote history",
});
const UNDECIDED = entry({
  id: "d",
  outcome: "unavailable",
  stage: null,
  judge: null,
  failureKind: "stage-timeout",
});

const noop = (): void => undefined;

function renderTab(handlers: {
  readonly onAllowFromNowOn: (draft: SettingsRuleDraft) => void;
  readonly onFixInJudge: () => void;
}) {
  return render(<ActivityTab {...handlers} />);
}

function defaultTab() {
  return renderTab({ onAllowFromNowOn: noop, onFixInJudge: noop });
}

beforeEach(() => {
  support.listRecent = true;
  recent.entries = [ALLOWED, ASKED, REFUSED, UNDECIDED];
  recent.isError = false;
  visibleChats.current = new Map();
});

afterEach(cleanup);

describe("ActivityTab", () => {
  describe("outcome families", () => {
    it("maps allow, block, unattended block and unavailable to Allowed, Asked you, Refused and Couldn't decide", () => {
      defaultTab();

      const expected = [
        ["allowed", "Allowed"],
        ["asked", "Asked you"],
        ["refused", "Refused"],
        ["undecided", "Couldn't decide"],
      ] as const;
      for (const [family, label] of expected) {
        const row = screen.getByTestId(`auto-judge-activity-row-${family}`);
        expect(within(row).getByText(label)).not.toBeNull();
      }
    });

    it("says a refusal asked nobody, in its Why", () => {
      defaultTab();

      const row = screen.getByTestId("auto-judge-activity-row-refused");
      expect(
        within(row).getByText(
          "Refused without asking. This chat was running for another agent, so there was nobody to ask.",
        ),
      ).not.toBeNull();
      const asked = screen.getByTestId("auto-judge-activity-row-asked");
      expect(within(asked).queryByText(/Refused without asking/)).toBeNull();
    });

    it("names the rule and reason in an ordinary Why", () => {
      defaultTab();

      const row = screen.getByTestId("auto-judge-activity-row-asked");
      expect(within(row).getByText("Force push")).not.toBeNull();
      expect(
        within(row).getByText("Pushes over remote history"),
      ).not.toBeNull();
    });
  });

  describe("filters", () => {
    it("starts on All, with every row showing", () => {
      defaultTab();

      expect(
        screen
          .getByTestId("auto-judge-activity-filter-all")
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(screen.getAllByTestId(/^auto-judge-activity-row-/)).toHaveLength(
        4,
      );
    });

    it.each([
      ["allowed", "auto-judge-activity-row-allowed"],
      ["asked", "auto-judge-activity-row-asked"],
      ["refused", "auto-judge-activity-row-refused"],
      ["undecided", "auto-judge-activity-row-undecided"],
    ] as const)("%s narrows to that family alone", (filter, rowTestId) => {
      defaultTab();

      fireEvent.click(
        screen.getByTestId(`auto-judge-activity-filter-${filter}`),
      );

      expect(
        screen
          .getByTestId(`auto-judge-activity-filter-${filter}`)
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        screen
          .getByTestId("auto-judge-activity-filter-all")
          .getAttribute("aria-pressed"),
      ).toBe("false");
      const rows = screen.getAllByTestId(/^auto-judge-activity-row-/);
      expect(rows).toHaveLength(1);
      expect(rows[0].getAttribute("data-testid")).toBe(rowTestId);
    });

    it("returns to every row on All", () => {
      defaultTab();
      fireEvent.click(screen.getByTestId("auto-judge-activity-filter-refused"));

      fireEvent.click(screen.getByTestId("auto-judge-activity-filter-all"));

      expect(screen.getAllByTestId(/^auto-judge-activity-row-/)).toHaveLength(
        4,
      );
    });
  });

  describe("Allow from now on…", () => {
    it("is offered for a soft-tier block with a rule, and hands the drafted line over", () => {
      const onAllowFromNowOn = vi.fn<(draft: SettingsRuleDraft) => void>();
      renderTab({ onAllowFromNowOn, onFixInJudge: noop });

      const row = screen.getByTestId("auto-judge-activity-row-asked");
      const link = within(row).getByTestId(
        "auto-judge-activity-allow-from-now-on",
      );
      expect(link.textContent).toBe(AUTO_JUDGE_ALLOW_FROM_NOW_ON_LABEL);
      fireEvent.click(link);

      const action = autoModeRuleDraftAction({
        inputSummary: ASKED.inputSummary,
        toolName: ASKED.toolName,
      });
      if (action === null) throw new Error("expected a draft action");
      expect(onAllowFromNowOn).toHaveBeenCalledTimes(1);
      expect(onAllowFromNowOn).toHaveBeenCalledWith({
        section: "allow",
        text: autoModeRuleDraftText({
          workspace: { remote: null, branch: null },
          ruleName: autoModeRuleDisplayName("Force Push"),
          action,
        }),
      });
    });

    it("narrows the draft by the workspace of a chat this window has open", () => {
      const onAllowFromNowOn = vi.fn<(draft: SettingsRuleDraft) => void>();
      visibleChats.current = new Map([
        [
          "chat-1",
          {
            title: "Live title",
            hostId: "host-a",
            workspace: { remote: "acme/web", branch: "feature-x" },
          },
        ],
      ]);
      renderTab({ onAllowFromNowOn, onFixInJudge: noop });

      fireEvent.click(
        within(screen.getByTestId("auto-judge-activity-row-asked")).getByTestId(
          "auto-judge-activity-allow-from-now-on",
        ),
      );

      const text = onAllowFromNowOn.mock.calls[0][0].text;
      expect(text).toContain("In acme/web:");
      expect(text).toContain("on branch feature-x");
    });

    it("is not offered for an allow, a hard-tier block, or a block with no rule", () => {
      recent.entries = [
        ALLOWED,
        entry({ id: "h", outcome: "block", tier: "hard", rule: "Wipe Disk" }),
        entry({ id: "n", outcome: "block", tier: "soft", rule: null }),
      ];
      defaultTab();

      expect(
        screen.queryByTestId("auto-judge-activity-allow-from-now-on"),
      ).toBeNull();
    });

    it("is not offered when there is neither an input summary nor a tool name to narrow by", () => {
      recent.entries = [askedWith({ inputSummary: "   ", toolName: "  " })];
      defaultTab();

      expect(
        screen.queryByTestId("auto-judge-activity-allow-from-now-on"),
      ).toBeNull();
    });

    it("falls back to the tool name when the input summary is blank", () => {
      const onAllowFromNowOn = vi.fn<(draft: SettingsRuleDraft) => void>();
      recent.entries = [
        askedWith({ inputSummary: "", toolName: "Run the migration" }),
      ];
      renderTab({ onAllowFromNowOn, onFixInJudge: noop });

      fireEvent.click(
        screen.getByTestId("auto-judge-activity-allow-from-now-on"),
      );

      expect(onAllowFromNowOn.mock.calls[0][0].text).toContain(
        "`Run the migration`",
      );
    });
  });

  describe("Fix in Judge", () => {
    it("is offered when no judge is configured, and calls onFixInJudge", () => {
      const onFixInJudge = vi.fn<() => void>();
      recent.entries = [
        entry({
          id: "u",
          outcome: "unavailable",
          stage: null,
          judge: null,
          failureKind: "no-judge-configured",
        }),
      ];
      renderTab({ onAllowFromNowOn: noop, onFixInJudge });

      fireEvent.click(screen.getByTestId("auto-judge-activity-fix-in-judge"));

      expect(onFixInJudge).toHaveBeenCalledTimes(1);
    });

    it("is not offered when the judge ran out of time", () => {
      recent.entries = [UNDECIDED];
      defaultTab();

      expect(
        screen.queryByTestId("auto-judge-activity-fix-in-judge"),
      ).toBeNull();
      expect(
        screen.getByText(
          "The judge didn't finish in time, so it's asking you instead.",
        ),
      ).not.toBeNull();
    });
  });

  describe("titles", () => {
    it("prefers the live title of a chat this window has open", () => {
      visibleChats.current = new Map([
        [
          "chat-1",
          {
            title: "Live title",
            hostId: null,
            workspace: { remote: null, branch: null },
          },
        ],
      ]);
      recent.entries = [ALLOWED];
      defaultTab();

      expect(screen.getByText("Live title")).not.toBeNull();
      expect(screen.queryByText("Fix the build")).toBeNull();
    });

    it("uses the recorded title when the chat is not open here", () => {
      recent.entries = [ALLOWED];
      defaultTab();

      expect(screen.getByText("Fix the build")).not.toBeNull();
    });

    it("falls back to Untitled conversation when neither knows a title", () => {
      recent.entries = [entry({ chatTitle: null })];
      defaultTab();

      expect(screen.getByText("Untitled conversation")).not.toBeNull();
    });
  });

  describe("empty and unsupported", () => {
    it("shows the empty state, and no filters, when there are no decisions", () => {
      recent.entries = [];
      defaultTab();

      expect(screen.getByTestId("auto-judge-activity-empty").textContent).toBe(
        "No Auto mode decisions on this machine yet.",
      );
      expect(screen.queryByTestId("auto-judge-activity-filter-all")).toBeNull();
    });

    it("says the host doesn't record decisions when it lacks the method", () => {
      support.listRecent = false;
      defaultTab();

      expect(screen.getByTestId("auto-mode-unsupported").textContent).toContain(
        "doesn't record Auto mode decisions",
      );
      expect(screen.queryByTestId("auto-judge-activity-empty")).toBeNull();
    });

    it("says nothing while support is still unknown", () => {
      support.listRecent = null;
      defaultTab();

      expect(screen.queryByTestId("auto-mode-unsupported")).toBeNull();
    });

    it("says it could not read the log when the query failed", () => {
      recent.entries = undefined;
      recent.isError = true;
      defaultTab();

      expect(
        screen.getByText(/Couldn't read this machine's recent decisions/),
      ).not.toBeNull();
    });
  });
});

function askedWith(
  overrides: Partial<AutoJudgeRecentEntry>,
): AutoJudgeRecentEntry {
  return { ...ASKED, ...overrides };
}
