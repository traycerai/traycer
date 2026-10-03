import { Cpu, Gauge } from "lucide-react";
import type {
  LayoutRegion,
  SegmentOption,
  StyleExample,
} from "@/components/layout-editor/regions/region-grammar";
import { barPlacementStateWord } from "@/components/layout-editor/regions/region-state-words";

/**
 * How much a reading says. The row's description, which names what Auto is at
 * the reading's current spot, is composed by the form (`densityDescription`).
 */
const READING_DENSITY_OPTIONS: ReadonlyArray<SegmentOption> = [
  { value: "auto", label: "Auto" },
  { value: "compact", label: "Compact" },
  { value: "detailed", label: "Detailed" },
];

/**
 * What a calm profile shows in the status bar's Detailed form. Everything is
 * the full reading on every profile, not only on one that needs attention.
 */
const READING_STYLE_EXAMPLES: ReadonlyArray<StyleExample<"usageLimits">> = [
  { id: "bar", label: "Bar", patch: { readingStyle: "bar" } },
  { id: "percent", label: "Percent", patch: { readingStyle: "percent" } },
  { id: "both", label: "Bar and percent", patch: { readingStyle: "both" } },
  { id: "full", label: "Everything", patch: { readingStyle: "full" } },
];

/**
 * One of the two regions whose home is itself a setting - a bar and an end of
 * it, picked for this region alone (L-156) - plus its per-provider level.
 */
export const USAGE_LIMITS_REGION: LayoutRegion<"usageLimits"> = {
  id: "usageLimits",
  name: "Usage limits",
  surface: "statusBar",
  icon: Gauge,
  where: "Status bar - left side",
  whereByHost: { "status-bar": "Status bar", header: "Tab strip" },
  hint: null,
  keywords: [
    "usage",
    "limits",
    "quota",
    "plan",
    "percent",
    "used",
    "left",
    "timer",
    "reset",
    "providers",
    "profiles",
    "density",
    "compact",
    "detailed",
    "bar",
    "reading style",
    "everything",
    // Where it can LIVE, not only what it says: the page's own "Show these
    // in" row carried these words and is gone with L-156, and a search entry
    // is generated from this list (L-126).
    "header",
    "top bar",
    "status bar",
    "tab strip",
    "location",
    "move",
  ],
  rows: [
    { kind: "position-host" },
    {
      kind: "fine-tune",
      rows: [
        {
          id: "density",
          label: "Density",
          description: null,
          pinsTransient: false,
          liveWhileHidden: null,
          requires: null,
          control: {
            kind: "segment",
            key: "density",
            options: READING_DENSITY_OPTIONS,
          },
        },
      ],
    },
    {
      kind: "style",
      key: "readingStyle",
      label: "Reading style",
      description:
        "What a calm profile shows. A profile running low or at its limit always shows its name and percent.",
      labelPlacement: "above",
      examples: READING_STYLE_EXAMPLES,
    },
    {
      kind: "fine-tune",
      rows: [
        {
          id: "amount",
          label: "Percent shows",
          description: null,
          pinsTransient: false,
          liveWhileHidden: null,
          requires: null,
          control: {
            kind: "segment",
            key: "amount",
            options: [
              { value: "used", label: "Used" },
              { value: "remaining", label: "Remaining" },
            ],
          },
        },
        {
          id: "reset",
          label: "Reset time",
          description: "Shows each profile's time until reset.",
          pinsTransient: false,
          liveWhileHidden: null,
          requires: null,
          control: { kind: "switch", key: "reset" },
        },
      ],
    },
    { kind: "children", level: "usage-providers" },
  ],
  // The section header's Show switch replaces the Show and Hide verbs.
  quickVerbs: [],
  stateWord: (values, arrangement) =>
    barPlacementStateWord(values, arrangement, "usageLimits"),
};

export const RESOURCE_MONITOR_REGION: LayoutRegion<"resourceMonitor"> = {
  id: "resourceMonitor",
  name: "Resource monitor",
  surface: "statusBar",
  icon: Cpu,
  where: "Status bar - right side",
  whereByHost: { "status-bar": "Status bar", header: "Tab strip" },
  hint: null,
  keywords: [
    "cpu",
    "memory",
    "procs",
    "processes",
    "ram",
    "resource",
    "monitor",
    "density",
    "compact",
    "detailed",
    // The same four as the usage cluster's: since L-156 this reading picks
    // its own bar, so "header" and "move" have to find it too.
    "header",
    "top bar",
    "status bar",
    "tab strip",
    "location",
    "move",
  ],
  rows: [
    { kind: "position-host" },
    {
      kind: "fine-tune",
      rows: [
        {
          id: "density",
          label: "Density",
          description: null,
          pinsTransient: false,
          liveWhileHidden: null,
          requires: null,
          control: {
            kind: "segment",
            key: "density",
            options: READING_DENSITY_OPTIONS,
          },
        },
        {
          id: "metrics",
          label: "Metrics",
          description:
            "What the monitor reports. Readings on agent rows use the same choice.",
          pinsTransient: false,
          // The rows' only metric control, so it stays editable while they
          // print, even with the monitor itself Hidden (L-174).
          liveWhileHidden: "agentRows",
          requires: null,
          control: {
            kind: "checks",
            options: [
              { key: "cpu", label: "CPU" },
              { key: "memory", label: "Memory" },
              { key: "processes", label: "Processes" },
              { key: "ramShare", label: "RAM share" },
            ],
          },
        },
      ],
    },
  ],
  quickVerbs: [],
  stateWord: (values, arrangement) =>
    barPlacementStateWord(values, arrangement, "resourceMonitor"),
};
