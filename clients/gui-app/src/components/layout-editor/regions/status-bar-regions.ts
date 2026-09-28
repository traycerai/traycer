import { Cpu, Gauge } from "lucide-react";
import {
  SHOW_HIDE_VERBS,
  type LayoutRegion,
} from "@/components/layout-editor/regions/region-grammar";
import { barPlacementStateWord } from "@/components/layout-editor/regions/region-state-words";

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
    "bar",
    // Where it can LIVE, not only what it says: the page's own "Show these
    // in" row carried these words and is gone with L-156, and a search entry
    // is generated from this list (L-126).
    "header",
    "top bar",
    "status bar",
    "move",
  ],
  rows: [
    {
      kind: "position-host",
      description: "Which bar the cluster lives in.",
    },
    {
      kind: "position-side",
      description: "The start or end of its reading area.",
    },
    {
      kind: "fine-tune",
      rows: [
        {
          id: "amount",
          label: "Amount",
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
          // The five fields had a second writer in the Style examples, which
          // set the same keys as named combinations (L-10 overturned in part).
          // Each field is now said once, here.
          id: "show",
          label: "Show",
          description:
            "Amount label shows “used” or “remaining” beside the percentage.",
          pinsTransient: false,
          liveWhileHidden: null,
          requires: null,
          control: {
            kind: "checks",
            options: [
              { key: "bar", label: "Progress bar", requires: null },
              { key: "percent", label: "Percentage", requires: null },
              { key: "word", label: "Amount label", requires: "percent" },
              { key: "reset", label: "Time until reset", requires: null },
            ],
          },
        },
      ],
    },
    { kind: "children", level: "usage-providers" },
  ],
  quickVerbs: SHOW_HIDE_VERBS,
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
    // The same four as the usage cluster's: since L-156 this reading picks
    // its own bar, so "header" and "move" have to find it too.
    "header",
    "top bar",
    "status bar",
    "move",
  ],
  rows: [
    {
      kind: "position-host",
      description: "Which bar the monitor lives in.",
    },
    {
      kind: "position-side",
      description: "The start or end of its reading area.",
    },
    {
      kind: "fine-tune",
      rows: [
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
              { key: "cpu", label: "CPU", requires: null },
              { key: "memory", label: "Memory", requires: null },
              { key: "processes", label: "Processes", requires: null },
              { key: "ramShare", label: "RAM share", requires: null },
            ],
          },
        },
      ],
    },
  ],
  quickVerbs: SHOW_HIDE_VERBS,
  stateWord: (values, arrangement) =>
    barPlacementStateWord(values, arrangement, "resourceMonitor"),
};
