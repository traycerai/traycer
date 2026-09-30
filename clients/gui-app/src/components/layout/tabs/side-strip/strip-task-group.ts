import { useMemo, useState } from "react";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import { SAMPLE_LIVE_AGENTS } from "@/components/sample-workspace/sample-workspace-scene";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import type { HeaderTab } from "@/stores/tabs/types";
import { useStripAgentsMode } from "./strip-agents-mode";
import { useStripTaskExpanded } from "./strip-disclosure";
import { useStripTaskNeedsYou } from "./strip-needs-you-context";
import { useStripTaskAgents, type StripAgent } from "./strip-task-agents";

/** One nested row: an agent, and the notification behind it for a needs-you row. */
export interface StripGroupRow {
  readonly agent: StripAgent;
  /** Set on a cold task's needs-you row, whose click is the notification's activation. */
  readonly notification: MergedNotificationRow | null;
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
 * collapsed only those waiting on the person. A cold task has no names, so it
 * nests its needs-you rows alone and cannot expand. The layout editor's sample
 * tab nests the sample agents, and under the sample scene no real task nests
 * anything.
 */
export function useStripTaskGroup(
  tab: HeaderTab | null,
  active: boolean,
): StripTaskGroup | null {
  const mode = useStripAgentsMode();
  const sample = useSampleScene();
  const epicId = tab?.kind === "epic" ? tab.epicId : null;
  const { warm, agents } = useStripTaskAgents(epicId);
  const needsYou = useStripTaskNeedsYou(epicId);
  const [expandedChoice, setExpanded] = useStripTaskExpanded(epicId, active);
  const [viaPointer, setViaPointer] = useState(false);
  const motionEnabled = useMotionEnabled();
  const expandable = warm && agents.length > 0;
  const expanded = expandable && expandedChoice;
  const animate = viaPointer && motionEnabled;
  const rows = useMemo((): ReadonlyArray<StripGroupRow> => {
    if (warm) {
      return (
        expanded ? agents : agents.filter((a) => a.status === "waiting")
      ).map((agent) => ({ agent, notification: null }));
    }
    return needsYou.map((item) => ({
      agent: {
        id: item.row.feedId,
        title: item.agentTitle,
        status: "waiting",
        since: item.createdAt,
      },
      notification: item.row,
    }));
  }, [warm, expanded, agents, needsYou]);
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
