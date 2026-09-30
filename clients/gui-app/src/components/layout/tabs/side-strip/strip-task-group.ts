import { useMemo, useState } from "react";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import { SAMPLE_LIVE_AGENTS } from "@/components/sample-workspace/sample-workspace-scene";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import {
  needsYouItemChatId,
  type NeedsYouItem,
} from "@/stores/notifications/needs-you-items";
import type { HeaderTab } from "@/stores/tabs/types";
import { useStripAgentsMode } from "./strip-agents-mode";
import { useStripTaskExpanded } from "./strip-disclosure";
import { useStripTaskNeedsYou } from "./strip-needs-you-context";
import type { StripTaskRow } from "./strip-sections";
import { useStripTaskAgents, type StripAgent } from "./strip-task-agents";

/** One nested row: an agent, and the notification behind it for a needs-you row. */
export interface StripGroupRow {
  readonly agent: StripAgent;
  /** Set on a cold task's needs-you row, whose click is the notification's activation. */
  readonly notification: MergedNotificationRow | null;
  /**
   * The waiting prompt of a named agent's row. Opening the agent goes through
   * its activation, which lands on the pending card.
   */
  readonly prompt: MergedNotificationRow | null;
}

/** The chevron's state and its toggle, on a warm task with agents. */
export interface StripTaskDisclosure {
  readonly expanded: boolean;
  /** Whether the chevron and the rows ease; a keyboard toggle does not. */
  readonly animate: boolean;
  readonly toggle: (viaPointer: boolean) => void;
}

/** What the strip draws under one task's row. */
export interface StripTaskGroup {
  readonly tabId: string;
  /** The task, or `null` for the layout editor's sample tab. */
  readonly epicId: string | null;
  /** The row is the task in front, so a click opens in its own canvas. */
  readonly active: boolean;
  /** Ghosted: the layout editor pointing at Side tab view in Tabs only. */
  readonly ghost: boolean;
  readonly rows: ReadonlyArray<StripGroupRow>;
  /** `null` for a task that cannot expand: a cold one, and the sample. */
  readonly disclosure: StripTaskDisclosure | null;
}

/** The task row's DOM id, which its group is labelled by. */
export function stripTaskRowId(tabId: string): string {
  return `side-tab-row-${tabId}`;
}

/** The group's DOM id, which the task row's `aria-controls` names. */
export function stripAgentGroupId(tabId: string): string {
  return `side-tab-agents-${tabId}`;
}

/**
 * What the strip nests under `tab`'s row, or `null` for nothing.
 *
 * A warm task nests its named agents and can expand: expanded shows them all,
 * collapsed only those waiting on the person. Either way it also nests each
 * prompt of the task that no waiting agent accounts for, so a prompt is never
 * left without a row. A cold task has no names, so it nests its needs-you rows
 * alone and cannot expand. A task in the Activity view's Needs you section
 * (`row`) names its requests on its own second line, so it nests none: expanded
 * it shows all its agents, waiting ones first, and collapsed nothing. The
 * layout editor's sample tab nests the sample agents, and under the sample
 * scene no real task nests anything.
 */
export function useStripTaskGroup(
  tab: HeaderTab | null,
  active: boolean,
  row: StripTaskRow | null,
): StripTaskGroup | null {
  const mode = useStripAgentsMode();
  const sample = useSampleScene();
  const epicId = tab?.kind === "epic" ? tab.epicId : null;
  const { warm, agents } = useStripTaskAgents(epicId);
  const needsYou = useStripTaskNeedsYou(epicId);
  const [expandedChoice, setExpanded] = useStripTaskExpanded(epicId, active);
  const [viaPointer, setViaPointer] = useState(false);
  const motionEnabled = useMotionEnabled();
  const namedOnRow = row?.section === "needs-you";
  const expandable = warm && agents.length > 0;
  const expanded = expandable && expandedChoice;
  const animate = viaPointer && motionEnabled;
  const rows = useMemo((): ReadonlyArray<StripGroupRow> => {
    const promptRow = (item: NeedsYouItem): StripGroupRow => ({
      agent: {
        id: item.row.feedId,
        title: item.agentTitle,
        status: "waiting",
        kind: item.reason === "approval" ? "approval" : "interview",
        since: item.createdAt,
      },
      notification: item.row,
      prompt: null,
    });
    if (!warm) return namedOnRow ? [] : needsYou.map(promptRow);
    const promptOfChat = new Map<string, MergedNotificationRow>();
    for (const item of needsYou) {
      const chatId = needsYouItemChatId(item);
      if (chatId !== null && !promptOfChat.has(chatId)) {
        promptOfChat.set(chatId, item.row);
      }
    }
    const agentRow = (agent: StripAgent): StripGroupRow => ({
      agent,
      notification: null,
      prompt:
        agent.status === "waiting"
          ? (promptOfChat.get(agent.id) ?? null)
          : null,
    });
    // `agents` is in the strip's order, waiting ones first.
    if (namedOnRow) return expanded ? agents.map(agentRow) : [];
    const waiting = agents.filter((a) => a.status === "waiting");
    const waitingIds = new Set(waiting.map((a) => a.id));
    // Every prompt of a task with a row shows under it: one no waiting agent
    // above accounts for nests as a needs-you row, as a cold task's does.
    const unmatched = needsYou.filter((item) => {
      const chatId = needsYouItemChatId(item);
      return chatId === null || !waitingIds.has(chatId);
    });
    return [
      ...waiting.map(agentRow),
      ...unmatched.map(promptRow),
      ...(expanded ? agents.filter((a) => a.status !== "waiting") : []).map(
        agentRow,
      ),
    ];
  }, [warm, namedOnRow, expanded, agents, needsYou]);
  return useMemo((): StripTaskGroup | null => {
    if (tab === null || mode === null) return null;
    if (tab.kind === "sample-workspace") {
      return {
        tabId: tab.id,
        epicId: null,
        active,
        ghost: mode === "preview",
        rows: SAMPLE_LIVE_AGENTS.map((agent) => ({
          agent,
          notification: null,
          prompt: null,
        })),
        disclosure: null,
      };
    }
    if (epicId === null || mode !== "live" || sample) return null;
    if (rows.length === 0 && !expandable) return null;
    return {
      tabId: tab.id,
      epicId,
      active,
      ghost: false,
      rows,
      disclosure: expandable
        ? {
            expanded,
            animate,
            toggle: (pointer) => {
              setViaPointer(pointer);
              setExpanded(!expanded);
            },
          }
        : null,
    };
  }, [
    tab,
    mode,
    sample,
    epicId,
    active,
    rows,
    expandable,
    expanded,
    animate,
    setExpanded,
  ]);
}
