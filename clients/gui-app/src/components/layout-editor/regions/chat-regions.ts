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
import {
  alwaysLive,
  disabledBy,
  INDEPENDENT,
  LIVE,
  liveWithNote,
  type RegionRule,
} from "@/components/layout-editor/regions/row-availability";
import { CONTEXT_USAGE_ROW_KEYS } from "@/lib/context-usage-rows";
import {
  alwaysAvailable,
  isDesktopLayoutRowAvailable,
} from "@/lib/settings/settings-availability";

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
  shellGate: alwaysAvailable,
  availability: alwaysLive,
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
  shellGate: alwaysAvailable,
  availability: alwaysLive,
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
  shellGate: alwaysAvailable,
  availability: alwaysLive,
  quickVerbs: SHOW_HIDE_VERBS,
  stateWord: shownStateWord,
};

/**
 * The minimap is an edge rail for a pointer that can hover, which the phone
 * layout never draws: its Minimap is the tile bar's drawer, and that ignores
 * the region (`shouldMountChatTurnMinimap`). So it is nothing at all in the
 * installed app (its shell gate) and a note in a narrow browser tab, where
 * widening the window brings the rail back (C5). The Side row under it says
 * nothing of its own: the note is said once, on the region's row.
 */
const minimapRule: RegionRule = (context) =>
  context.shell.phoneLayout
    ? liveWithNote("Shows on wider windows with a mouse.")
    : LIVE;

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
      depends: INDEPENDENT,
    },
  ],
  shellGate: isDesktopLayoutRowAvailable,
  availability: minimapRule,
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
  // Pin breakdown decides which of the two below it applies (C1): the pinned
  // strip never reads the chip's style, and the chip never draws the
  // breakdown rows. Chip style is declared first because the breakdown ships
  // unpinned, so the live one sits right under the switch by default.
  rows: [
    {
      kind: "fine-tune",
      rows: [
        {
          id: "pinBreakdown",
          label: "Pin breakdown",
          description: "Keep the context breakdown open above the indicator.",
          pinsTransient: true,
          depends: INDEPENDENT,
          control: { kind: "switch", key: "pinBreakdown" },
        },
      ],
    },
    {
      kind: "style",
      key: "style",
      label: "Chip style",
      description: null,
      labelPlacement: "end",
      examples: CONTEXT_USAGE_EXAMPLES,
      depends: {
        under: "pinBreakdown",
        availability: (context) =>
          context.values.contextUsage.pinBreakdown
            ? disabledBy("Turn off Pin breakdown to use this.", null)
            : LIVE,
      },
    },
    {
      kind: "fine-tune",
      rows: [
        {
          id: "pinnedFields",
          label: "Breakdown rows",
          description: "Drag to set their order. At least one row stays.",
          pinsTransient: true,
          depends: {
            under: "pinBreakdown",
            availability: (context) =>
              context.values.contextUsage.pinBreakdown
                ? LIVE
                : disabledBy("Turn on Pin breakdown to use this.", null),
          },
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
          // Which harness can compact is the turn's fact, not the form's.
          depends: {
            under: null,
            availability: () =>
              liveWithNote("Only for harnesses that can compact."),
          },
          control: {
            kind: "segment",
            key: "compactButton",
            options: SHOWN_HIDDEN_OPTIONS,
          },
        },
      ],
    },
  ],
  shellGate: alwaysAvailable,
  availability: alwaysLive,
  quickVerbs: SHOW_HIDE_VERBS,
  stateWord: contextUsageStateWord,
};
