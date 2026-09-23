/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Activity).
 * Update that file whenever this settings surface changes.
 */
import { useState, type ReactNode } from "react";
import type { AutoJudgeRecentEntry } from "@traycer/protocol/host/auto-mode/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAutoJudgeRecentQuery } from "@/hooks/auto-mode/use-auto-judge-recent-query";
import {
  useVisibleChats,
  type VisibleChat,
} from "@/hooks/chats/use-visible-chats";
import {
  AUTO_JUDGE_ALLOW_FROM_NOW_ON_LABEL,
  autoModeRuleDisplayName,
  autoModeRuleDraftAction,
  autoModeRuleDraftText,
  type AutoModeRuleDraftWorkspace,
} from "@/lib/auto-mode/auto-mode-rule-copy";
import {
  isJudgeUnavailableReason,
  judgeCouldNotRunSentence,
  judgeUnavailableHumanLine,
  JUDGE_NO_VERDICT_HUMAN_LINE,
  JUDGE_OUT_OF_TIME_HUMAN_LINE,
} from "@/components/chat/segments/approval-card-disclosure";
import { autoJudgeUnattendedDenialText } from "@/components/chat/segments/auto-judge-unattended-denial-display";
import {
  AutoModeHostGate,
  AutoModeUnsupportedLine,
} from "@/components/settings/panels/permissions/auto-mode-host-gate";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type { SettingsRuleDraft } from "@/stores/tabs/system-overlay-types";

/**
 * The four outcome families, one per row and exhaustive: a `block` that asked
 * nobody (`unattended`) is not "Asked you", so it is a family of its own.
 */
type ActivityFamily = "allowed" | "asked" | "refused" | "undecided";

type ActivityFilter = "all" | ActivityFamily;

const FAMILY_LABELS: Readonly<Record<ActivityFamily, string>> = {
  allowed: "Allowed",
  asked: "Asked you",
  refused: "Refused",
  undecided: "Couldn't decide",
};

const FILTERS: ReadonlyArray<{
  readonly value: ActivityFilter;
  readonly label: string;
}> = [
  { value: "all", label: "All" },
  { value: "allowed", label: FAMILY_LABELS.allowed },
  { value: "asked", label: FAMILY_LABELS.asked },
  { value: "refused", label: FAMILY_LABELS.refused },
  { value: "undecided", label: FAMILY_LABELS.undecided },
];

function familyOf(entry: AutoJudgeRecentEntry): ActivityFamily {
  switch (entry.outcome) {
    case "allow":
      return "allowed";
    case "block":
      return entry.unattended ? "refused" : "asked";
    case "unavailable":
      return "undecided";
  }
}

/**
 * The host's failure kinds a setting on the Judge tab fixes: no judge chosen,
 * one that cannot run, one whose adapter failed, a record that cannot be read.
 * A judge that ran and could not decide, or ran out of time, is not a setting.
 */
const JUDGE_AVAILABILITY_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "no-judge-configured",
  "judge-unavailable",
  "adapter-failed",
  "selection-unreadable",
]);

const OUT_OF_TIME_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "stage-timeout",
  "stage2-cap",
]);

const NO_VERDICT_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "unparseable-verdict",
  "conflicting-block",
  "blank-verdict-field",
  "no-verdict",
]);

/**
 * The card's own sentence for a decision no judge made, and whether "Fix in
 * Judge" follows it. The entry's reason is the card's machine string when the
 * host recorded one, so it gets the card's exact line; otherwise the failure
 * kind picks the family. The fix link keys on the kind when there is one,
 * because a kind names the cause precisely where a string only suggests it.
 */
function undecidedLine(entry: AutoJudgeRecentEntry): {
  readonly sentence: string;
  readonly fixInJudge: boolean;
} {
  const kind = entry.failureKind;
  const human =
    entry.reason !== null && isJudgeUnavailableReason(entry.reason)
      ? judgeUnavailableHumanLine(entry.reason)
      : null;
  const fixInJudge =
    kind === null
      ? (human?.fixInJudgeSettings ?? false)
      : JUDGE_AVAILABILITY_FAILURE_KINDS.has(kind);
  if (human !== null) return { sentence: human.sentence, fixInJudge };
  if (kind !== null && OUT_OF_TIME_FAILURE_KINDS.has(kind)) {
    return { sentence: JUDGE_OUT_OF_TIME_HUMAN_LINE, fixInJudge };
  }
  if (kind !== null && NO_VERDICT_FAILURE_KINDS.has(kind)) {
    return { sentence: JUDGE_NO_VERDICT_HUMAN_LINE, fixInJudge };
  }
  return { sentence: judgeCouldNotRunSentence(null), fixInJudge };
}

const UNATTENDED_REFUSAL_SENTENCE = autoJudgeUnattendedDenialText({
  rule: null,
  reason: null,
});

const UNKNOWN_WORKSPACE: AutoModeRuleDraftWorkspace = {
  remote: null,
  branch: null,
};

/**
 * Settings ▸ Permissions ▸ Activity: the judge's recent decisions on this
 * machine, from the host's bounded log, newest first.
 */
export function ActivityTab(props: {
  /** "Allow from now on…": hand a narrowing draft to the Rules tab. */
  readonly onAllowFromNowOn: (draft: SettingsRuleDraft) => void;
  /** "Fix in Judge": show the Judge tab. */
  readonly onFixInJudge: () => void;
}): ReactNode {
  return (
    <AutoModeHostGate
      method="autoJudge.listRecent"
      unsupported={
        <AutoModeUnsupportedLine>
          This machine&apos;s host doesn&apos;t record Auto mode decisions yet.
          Update it to see them.
        </AutoModeUnsupportedLine>
      }
    >
      {() => (
        <ActivityList
          onAllowFromNowOn={props.onAllowFromNowOn}
          onFixInJudge={props.onFixInJudge}
        />
      )}
    </AutoModeHostGate>
  );
}

const ROW_GRID =
  "sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto_minmax(0,1.5fr)_auto] sm:gap-x-4";

function ActivityList(props: {
  readonly onAllowFromNowOn: (draft: SettingsRuleDraft) => void;
  readonly onFixInJudge: () => void;
}): ReactNode {
  // The capability gate above is this read's `enabled`: it only mounts once
  // the host has advertised the method.
  const query = useAutoJudgeRecentQuery(true);
  const visibleChats = useVisibleChats();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const entries = query.data?.entries;
  if (entries === undefined) {
    return query.isError ? (
      <p className="px-1 text-ui-sm text-warning-foreground">
        Couldn&apos;t read this machine&apos;s recent decisions. Reopen Settings
        to try again.
      </p>
    ) : null;
  }
  const shown =
    filter === "all"
      ? entries
      : entries.filter((entry) => familyOf(entry) === filter);
  return (
    <div className="flex flex-col gap-4">
      {entries.length === 0 ? (
        <p
          className="px-1 text-ui-sm text-muted-foreground"
          data-testid="auto-judge-activity-empty"
        >
          No Auto mode decisions on this machine yet.
        </p>
      ) : (
        <>
          <div
            role="group"
            aria-label="Show"
            className="flex flex-wrap gap-1.5"
          >
            {FILTERS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant="muted-outline"
                size="xs"
                aria-pressed={filter === option.value}
                onClick={() => setFilter(option.value)}
                data-testid={`auto-judge-activity-filter-${option.value}`}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <div
            role="table"
            aria-label="Recent Auto mode decisions"
            className="overflow-clip rounded-lg border border-border/60 bg-card/40"
          >
            <div
              role="row"
              className={cn(
                "hidden border-b border-border/60 px-4 py-2 text-ui-xs text-muted-foreground",
                ROW_GRID,
              )}
            >
              <span role="columnheader">When</span>
              <span role="columnheader">Action</span>
              <span role="columnheader">Outcome</span>
              <span role="columnheader">Why</span>
              <span role="columnheader">
                <span className="sr-only">Actions</span>
              </span>
            </div>
            {shown.map((entry) => (
              <ActivityRow
                key={entry.id}
                entry={entry}
                visible={visibleChats.get(entry.chatId) ?? null}
                onAllowFromNowOn={props.onAllowFromNowOn}
                onFixInJudge={props.onFixInJudge}
              />
            ))}
          </div>
        </>
      )}
      <p className="px-1 text-ui-xs text-muted-foreground">
        Conversations reviewed by a provider&apos;s built-in classifier show
        what it allowed; what it refused reaches you as an ordinary approval and
        isn&apos;t listed here.
      </p>
    </div>
  );
}

/** The status recipe per family: success, warning, and the neutral tag. */
const FAMILY_BADGE_VARIANTS: Readonly<
  Record<ActivityFamily, "success" | "warning" | "muted">
> = {
  allowed: "success",
  asked: "warning",
  refused: "warning",
  undecided: "muted",
};

function ActivityRow(props: {
  readonly entry: AutoJudgeRecentEntry;
  readonly visible: VisibleChat | null;
  readonly onAllowFromNowOn: (draft: SettingsRuleDraft) => void;
  readonly onFixInJudge: () => void;
}): ReactNode {
  const { entry, visible } = props;
  const family = familyOf(entry);
  const title = visible?.title ?? entry.chatTitle;
  const ruleName =
    entry.rule === null ? null : autoModeRuleDisplayName(entry.rule);
  // The card's rule: a draft names an action, so an entry with neither an
  // input nor a tool name to narrow by offers no draft at all.
  const action = autoModeRuleDraftAction({
    inputSummary: entry.inputSummary,
    toolName: entry.toolName,
  });
  const allowDraft =
    entry.outcome === "block" &&
    entry.tier === "soft" &&
    ruleName !== null &&
    action !== null
      ? autoModeRuleDraftText({
          workspace: visible?.workspace ?? UNKNOWN_WORKSPACE,
          ruleName,
          action,
        })
      : null;
  return (
    <div
      role="row"
      className={cn(
        "flex flex-col gap-1.5 border-b border-border/40 px-4 py-3 last:border-b-0",
        ROW_GRID,
      )}
      data-testid={`auto-judge-activity-row-${family}`}
    >
      <div role="cell" className="min-w-0 text-ui-xs text-muted-foreground">
        <DecisionTime at={entry.at} />
        <div className="truncate">{title ?? "Untitled conversation"}</div>
      </div>
      <div role="cell" className="min-w-0">
        <div className="text-ui-xs text-muted-foreground">{entry.toolName}</div>
        {entry.inputSummary.length > 0 ? (
          <code className="font-mono text-ui-xs break-all text-foreground">
            {entry.inputSummary}
          </code>
        ) : null}
      </div>
      <div role="cell">
        <Badge variant={FAMILY_BADGE_VARIANTS[family]} size="xs">
          {FAMILY_LABELS[family]}
        </Badge>
      </div>
      <div role="cell" className="min-w-0 text-ui-sm">
        <DecisionWhy
          entry={entry}
          family={family}
          ruleName={ruleName}
          onFixInJudge={props.onFixInJudge}
        />
      </div>
      <div role="cell">
        {allowDraft !== null ? (
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            data-testid="auto-judge-activity-allow-from-now-on"
            onClick={() =>
              props.onAllowFromNowOn({ section: "allow", text: allowDraft })
            }
          >
            {AUTO_JUDGE_ALLOW_FROM_NOW_ON_LABEL}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function DecisionTime(props: { readonly at: string }): ReactNode {
  const at = Date.parse(props.at);
  if (Number.isNaN(at)) return null;
  return <RelativeTime at={at} />;
}

function RelativeTime(props: { readonly at: number }): ReactNode {
  // The shared 60s tick, so "2 minutes ago" ages without a refetch.
  return <div>{useRelativeTimestamp(props.at)}</div>;
}

function DecisionWhy(props: {
  readonly entry: AutoJudgeRecentEntry;
  readonly family: ActivityFamily;
  readonly ruleName: string | null;
  readonly onFixInJudge: () => void;
}): ReactNode {
  const { entry, family, ruleName } = props;
  if (family === "undecided") {
    const line = undecidedLine(entry);
    return (
      <p className="text-ui-xs text-muted-foreground">
        {line.sentence}
        {line.fixInJudge ? (
          <>
            {" "}
            <Button
              type="button"
              variant="link"
              size="inline-xs"
              data-testid="auto-judge-activity-fix-in-judge"
              onClick={props.onFixInJudge}
            >
              Fix in Judge
            </Button>
          </>
        ) : null}
      </p>
    );
  }
  return (
    <>
      {ruleName === null ? null : (
        <div className="text-foreground">{ruleName}</div>
      )}
      {entry.reason === null ? null : (
        <p className="text-ui-xs text-muted-foreground">{entry.reason}</p>
      )}
      {family === "refused" ? (
        <p className="text-ui-xs text-muted-foreground">
          {UNATTENDED_REFUSAL_SENTENCE}
        </p>
      ) : null}
    </>
  );
}
