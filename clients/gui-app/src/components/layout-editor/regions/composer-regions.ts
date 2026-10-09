import {
  Bot,
  FileDiff,
  History,
  ImagePlus,
  ListChecks,
  Mic,
  Shield,
  SlidersHorizontal,
} from "lucide-react";
import {
  SHOW_HIDE_VERBS,
  SIZE_ONLY_VERBS,
  SIZED_VERBS,
  type LayoutRegion,
  type StyleExample,
} from "@/components/layout-editor/regions/region-grammar";
import {
  accessStateWord,
  micStateWord,
  modelStateWord,
  shownStateWord,
  sizedStateWord,
} from "@/components/layout-editor/regions/region-state-words";
import {
  alwaysLive,
  disabledBy,
  LIVE,
  liveWithNote,
  strictest,
  wideLayoutRow,
  type RegionRule,
} from "@/components/layout-editor/regions/row-availability";
import { GENERAL } from "@/components/settings/panels/general-settings.definitions";
import {
  alwaysAvailable,
  isVoiceInputRowAvailable,
} from "@/lib/settings/settings-availability";

/** Where General > Voice input is, which the microphone's reason links to. */
const VOICE_INPUT_ANCHOR = GENERAL.definitions.voiceInput.anchor;

/**
 * The composer's eight regions: the four dock rows above the message box, and
 * the four toolbar elements below it.
 *
 * They share two row shapes, which is why they share a file: a dock row's
 * order and a toolbar cluster's order. A dock row's Full row / Chip / Hidden
 * and Access's Icon and label / Icon only are each ONE display control, drawn
 * from the value shape rather than declared as a row (L-128 overturned).
 *
 * Todo is a dock row like the other three (L-139, L-142) and so its entry is a
 * copy of `BACKGROUND_REGION` down to the row list. The Message queue is not a
 * region at all (G1-G2): it is never a pill, never hidden and never reordered.
 */

const DOCK_ORDER_ROW = { kind: "position-order", group: "dock" } as const;

const TOOLBAR_LEFT_ORDER_ROW = {
  kind: "position-order",
  group: "toolbarLeft",
} as const;

const TOOLBAR_RIGHT_ORDER_ROW = {
  kind: "position-order",
  group: "toolbarRight",
} as const;

const MODEL_EXAMPLES: ReadonlyArray<StyleExample<"model">> = [
  { id: "text", label: "Text", patch: { style: "text" } },
  { id: "bars", label: "Bars", patch: { style: "bars" } },
  { id: "barsText", label: "Bars and text", patch: { style: "bars-text" } },
];

const REASONING_CONTROL_EXAMPLES: ReadonlyArray<StyleExample<"model">> = [
  { id: "slider", label: "Slider", patch: { reasoningControl: "slider" } },
  { id: "list", label: "List", patch: { reasoningControl: "list" } },
];

/**
 * Flat first: it is the shipped default (L-88 overturned). Drawn by the
 * Composer area's Toolbar style row.
 */
export const TOOLBAR_STYLE_EXAMPLES: ReadonlyArray<StyleExample<"model">> = [
  { id: "flat", label: "Flat", patch: { toolbarStyle: "flat" } },
  { id: "bordered", label: "Bordered", patch: { toolbarStyle: "bordered" } },
];

export const RUNNING_AGENTS_REGION: LayoutRegion<"runningAgents"> = {
  id: "runningAgents",
  name: "Running agents",
  surface: "composer",
  icon: Bot,
  where: "Composer - above the message box",
  whereByHost: null,
  hint: null,
  keywords: ["agents", "running", "active", "work"],
  rows: [DOCK_ORDER_ROW],
  shellGate: alwaysAvailable,
  availability: alwaysLive,
  quickVerbs: SIZED_VERBS,
  stateWord: sizedStateWord,
};

export const CHANGED_FILES_REGION: LayoutRegion<"changedFiles"> = {
  id: "changedFiles",
  name: "Changed files",
  surface: "composer",
  icon: FileDiff,
  where: "Composer - above the message box",
  whereByHost: null,
  hint: null,
  keywords: ["changed", "files", "diff", "edits", "added", "removed"],
  rows: [DOCK_ORDER_ROW],
  shellGate: alwaysAvailable,
  availability: alwaysLive,
  quickVerbs: SIZED_VERBS,
  stateWord: sizedStateWord,
};

export const BACKGROUND_REGION: LayoutRegion<"background"> = {
  id: "background",
  name: "Background tasks",
  surface: "composer",
  icon: History,
  where: "Composer - above the message box",
  whereByHost: null,
  hint: null,
  keywords: ["background", "shell", "tasks", "running"],
  rows: [DOCK_ORDER_ROW],
  shellGate: alwaysAvailable,
  availability: alwaysLive,
  quickVerbs: SIZED_VERBS,
  stateWord: sizedStateWord,
};

/** `ListChecks`: the glyph the Todo header prints beside its own name. */
export const TODO_REGION: LayoutRegion<"todo"> = {
  id: "todo",
  name: "Todo",
  surface: "composer",
  icon: ListChecks,
  where: "Composer - above the message box",
  whereByHost: null,
  hint: null,
  keywords: ["todo", "todos", "tasks", "checklist", "plan", "progress"],
  rows: [DOCK_ORDER_ROW],
  shellGate: alwaysAvailable,
  availability: alwaysLive,
  quickVerbs: SIZED_VERBS,
  stateWord: sizedStateWord,
};

export const ATTACH_IMAGE_REGION: LayoutRegion<"attachImage"> = {
  id: "attachImage",
  name: "Attach image",
  surface: "composer",
  icon: ImagePlus,
  where: "Composer - toolbar, left",
  whereByHost: null,
  hint: null,
  keywords: ["attach", "image", "screenshot", "paste", "upload"],
  rows: [TOOLBAR_LEFT_ORDER_ROW],
  shellGate: alwaysAvailable,
  availability: alwaysLive,
  quickVerbs: SHOW_HIDE_VERBS,
  stateWord: shownStateWord,
};

export const ACCESS_REGION: LayoutRegion<"access"> = {
  id: "access",
  name: "Access",
  surface: "composer",
  icon: Shield,
  where: "Composer - toolbar, left",
  whereByHost: null,
  hint: null,
  keywords: ["access", "supervised", "permissions", "approval"],
  rows: [TOOLBAR_LEFT_ORDER_ROW],
  shellGate: alwaysAvailable,
  availability: alwaysLive,
  // No Hide: the pill is a floor, never hidden (G6).
  quickVerbs: SIZE_ONLY_VERBS,
  stateWord: accessStateWord,
};

export const MODEL_REGION: LayoutRegion<"model"> = {
  id: "model",
  name: "Model",
  surface: "composer",
  icon: SlidersHorizontal,
  where: "Composer - toolbar, right",
  whereByHost: null,
  hint: null,
  keywords: ["model", "chip", "effort", "medium", "bars", "reasoning"],
  // Toolbar style is not here: it styles the whole toolbar row, so it is a
  // Composer area row (`area-rows.ts`, C3) even though its value is stored on
  // Model, the one toolbar region that never hides (G6).
  //
  // Whether a model has effort levels is the picked model's fact, not the
  // form's, so both rows say it rather than disable (P1). The phone layout's
  // chip has no label, so Style is a desktop-layout row; Reasoning control is
  // the same picker's on every layout.
  rows: [
    {
      kind: "style",
      key: "style",
      label: "Style",
      description: null,
      labelPlacement: "end",
      examples: MODEL_EXAMPLES,
      depends: {
        under: null,
        availability: (context) =>
          strictest([
            wideLayoutRow(context.shell),
            liveWithNote(
              "Bars show only for models with several effort levels.",
            ),
          ]),
      },
    },
    {
      kind: "style",
      key: "reasoningControl",
      label: "Reasoning control",
      description: null,
      labelPlacement: "end",
      examples: REASONING_CONTROL_EXAMPLES,
      depends: {
        under: null,
        availability: () =>
          liveWithNote("For models with several effort levels."),
      },
    },
    TOOLBAR_RIGHT_ORDER_ROW,
  ],
  shellGate: alwaysAvailable,
  availability: alwaysLive,
  // No Hide: the picker always draws (G6), so there is no verb to offer.
  quickVerbs: [],
  stateWord: modelStateWord,
};

/**
 * The microphone follows General > Voice input as well as its own Shown, so
 * while that is off the row says where to turn it on (C4). The installed app
 * refuses dictation outright, so there it is no row at all (its shell gate).
 */
const micRule: RegionRule = (context) =>
  context.facts.voiceInputEnabled
    ? LIVE
    : disabledBy("Turn on Voice input in General settings to use this.", {
        kind: "settings",
        section: "general",
        anchor: VOICE_INPUT_ANCHOR,
        label: "Open General settings",
      });

export const MIC_REGION: LayoutRegion<"mic"> = {
  id: "mic",
  name: "Microphone",
  surface: "composer",
  icon: Mic,
  where: "Composer - toolbar, right",
  whereByHost: null,
  hint: null,
  keywords: ["microphone", "mic", "voice", "dictation", "speech"],
  rows: [TOOLBAR_RIGHT_ORDER_ROW],
  shellGate: isVoiceInputRowAvailable,
  availability: micRule,
  quickVerbs: SHOW_HIDE_VERBS,
  stateWord: micStateWord,
};
