import {
  Brain,
  CircleGauge,
  Clock,
  Map as MapIcon,
  Wrench,
} from "lucide-react";
import { CONTEXT_USAGE_ROW_LABELS } from "@/components/chat/context-usage";
import {
  SHOW_HIDE_VERBS,
  SHOWN_HIDDEN_OPTIONS,
  SIZE_ONLY_VERBS,
  SIZED_VERBS,
  type LayoutRegion,
  type StyleExample,
} from "@/components/layout-editor/regions/region-grammar";
import {
  contextUsageStateWord,
  shownStateWord,
  sideStateWord,
  thinkingStateWord,
  toolActivityStateWord,
} from "@/components/layout-editor/regions/region-state-words";
import { CONTEXT_USAGE_ROW_KEYS } from "@/lib/context-usage-rows";

/**
 * The transcript's own three regions (customization audit R1, R3). Each is the
 * DEFAULT a new row opens in: a row the user has opened or closed in a chat
 * keeps that choice, so the setting never folds what someone is reading.
 */
export const TOOL_ACTIVITY_REGION: LayoutRegion<"toolActivity"> = {
  id: "toolActivity",
  name: "Tool activity",
  surface: "chat",
  icon: Wrench,
  where: "Chat - the rows that list an agent's tool calls",
  whereByHost: null,
  hint: null,
  keywords: [
    "tools",
    "tool calls",
    "activity",
    "commands",
    "open",
    "closed",
    "expanded",
    "collapsed",
    "cards",
    "transcript",
  ],
  rows: [],
  quickVerbs: SIZE_ONLY_VERBS,
  stateWord: toolActivityStateWord,
};

export const THINKING_REGION: LayoutRegion<"thinking"> = {
  id: "thinking",
  name: "Thinking",
  surface: "chat",
  icon: Brain,
  where: "Chat - the agent's reasoning in each turn",
  whereByHost: null,
  hint: null,
  keywords: [
    "thinking",
    "reasoning",
    "thought",
    "trace",
    "open",
    "closed",
    "expanded",
    "collapsed",
    "transcript",
  ],
  rows: [],
  quickVerbs: SIZED_VERBS,
  stateWord: thinkingStateWord,
};

export const TIMESTAMPS_REGION: LayoutRegion<"timestamps"> = {
  id: "timestamps",
  name: "Timestamps",
  surface: "chat",
  icon: Clock,
  where: "Chat - under each of your messages",
  whereByHost: null,
  hint: null,
  keywords: ["timestamps", "time", "date", "sent", "messages", "transcript"],
  rows: [],
  quickVerbs: SHOW_HIDE_VERBS,
  stateWord: shownStateWord,
};

export const MINIMAP_REGION: LayoutRegion<"minimap"> = {
  id: "minimap",
  name: "Minimap",
  surface: "chat",
  icon: MapIcon,
  where: "Chat and artifacts - edge of the transcript or document",
  whereByHost: null,
  hint: null,
  keywords: [
    "minimap",
    "overview",
    "scrollbar",
    "map",
    "transcript",
    "artifact",
    "headings",
    "outline",
  ],
  rows: [
    {
      kind: "position-side",
      description: "Which edge of the transcript and artifact it sits on.",
    },
  ],
  quickVerbs: SHOW_HIDE_VERBS,
  stateWord: (values, arrangement) =>
    sideStateWord(values, arrangement.minimapSide),
};

const CONTEXT_USAGE_EXAMPLES: ReadonlyArray<StyleExample<"contextUsage">> = [
  { id: "text", label: "Text", patch: { style: "text" } },
  { id: "ring", label: "Ring and number", patch: { style: "ring" } },
  { id: "ringOnly", label: "Ring only", patch: { style: "ring-only" } },
];

export const CONTEXT_USAGE_REGION: LayoutRegion<"contextUsage"> = {
  id: "contextUsage",
  name: "Context usage",
  surface: "chat",
  icon: CircleGauge,
  where: "Chat - bottom right of the composer",
  whereByHost: null,
  hint: null,
  keywords: [
    "context",
    "usage",
    "tokens",
    "window",
    "percent",
    "ring",
    "breakdown",
  ],
  rows: [
    {
      kind: "style",
      key: "style",
      label: "Style",
      examples: CONTEXT_USAGE_EXAMPLES,
    },
    {
      kind: "fine-tune",
      rows: [
        {
          id: "pinBreakdown",
          label: "Pin breakdown",
          description: "Keep the context breakdown open above the indicator.",
          pinsTransient: true,
          liveWhileHidden: null,
          requires: null,
          control: { kind: "switch", key: "pinBreakdown" },
        },
        {
          id: "pinnedFields",
          label: "Breakdown rows",
          description: null,
          pinsTransient: true,
          liveWhileHidden: null,
          requires: "pinBreakdown",
          control: {
            kind: "field-checks",
            key: "pinnedFields",
            options: CONTEXT_USAGE_ROW_KEYS.map((key) => ({
              value: key,
              label: CONTEXT_USAGE_ROW_LABELS[key],
            })),
          },
        },
        {
          id: "compactButton",
          label: "Compact conversation button",
          description: null,
          pinsTransient: false,
          liveWhileHidden: null,
          requires: null,
          control: {
            kind: "segment",
            key: "compactButton",
            options: SHOWN_HIDDEN_OPTIONS,
          },
        },
      ],
    },
  ],
  quickVerbs: SHOW_HIDE_VERBS,
  stateWord: contextUsageStateWord,
};
