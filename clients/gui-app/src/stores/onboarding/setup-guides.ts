/**
 * The optional setup guides, as data.
 *
 * React-free and leaf on purpose: the store owns progress, the settings
 * surface draws the coachmark, and the product code a step waits on (the
 * browser switch, the login import) reports an EVENT. None of them names a
 * guide id, so a guide's rules live here and nowhere else. It may read the
 * settings definitions for their anchors - those are React-free too.
 *
 * A step names the settings section its target lives on, so a guide is free to
 * cross sections mid-run: Continue navigates to the next step's section, Back
 * to the previous one's, and the guide draws only while the mounted section is
 * the one the current step points at.
 */
import type { SettingsSectionId } from "@/lib/settings-sections";
import { APPEARANCE } from "@/components/settings/panels/appearance-settings.definitions";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";

/**
 * Something the product did that a guide is waiting for. The call site reports
 * what happened; this table decides which guide, if any, cares.
 */
export type SetupGuideEvent =
  | "browser-save-enabled"
  | "browser-logins-imported";

export interface SetupGuideStep {
  readonly section: SettingsSectionId;
  readonly selector: string;
  readonly title: string;
  readonly content: string;
  /** The event that moves past this step, in place of pressing Continue. */
  readonly advanceOn?: SetupGuideEvent;
  /**
   * The event that finishes the whole guide from this step. A step with one is
   * the user's to perform: the card offers no Continue and waits here, and
   * walking off it is refused, so the guide can only end with the real thing
   * having happened.
   */
  readonly completesOn?: SetupGuideEvent;
  /**
   * Whether the real chrome around Settings takes the layout editor's lit
   * treatment while this step is up (L-50) - the canvas signal shown rather
   * than entered. Closing the step ends the effect; nothing is entered and
   * nothing is written.
   */
  readonly litChrome?: true;
  /**
   * The step points at the layout editor's door, so it is left out wherever
   * the editor can never open (`isLayoutEditorAvailable`). Only a guide's LAST
   * step may carry it: the step before it becomes the last, and Done there
   * completes the guide, so the stored progress keeps one meaning in every
   * shell.
   */
  readonly requiresLayoutEditor?: true;
}

export interface SetupGuide {
  readonly steps: ReadonlyArray<SetupGuideStep>;
  /** Offered only where the desktop browser bridge exists. */
  readonly requiresBrowserView?: true;
}

const SETUP_GUIDES = {
  agents: {
    steps: [
      {
        section: "agents",
        selector: "[data-agent-selection-guide-editor-shell]",
        title: "How Traycer picks agents",
        content:
          "These instructions decide the harness, model, and effort for every delegated task.",
      },
      {
        section: "agents",
        selector: '[role="tablist"][aria-label="Editor view"]',
        title: "Write it in Markdown",
        content: "Edit freely. Changes save as you type, per host.",
      },
      {
        section: "agents",
        selector: '[data-testid="agents-selection-guide-revert"]',
        title: "Reset any time",
        content:
          "Revert rebuilds the defaults from the providers on this host.",
      },
    ],
  },
  appearance: {
    steps: [
      {
        section: "appearance",
        selector: `[data-settings-anchor="${APPEARANCE.definitions.themeMode.anchor}"] [role="group"]`,
        title: "Pick a theme",
        content: "Light, dark, or follow the system. Changes apply instantly.",
      },
      {
        section: "appearance",
        selector: `[data-settings-anchor="${APPEARANCE.definitions.wallpaper.anchor}"] button`,
        title: "Make the start page yours",
        content:
          "Choose a wallpaper. Greeting and recent tasks sit just below.",
      },
      {
        section: "appearance",
        selector: `[data-settings-anchor="${APPEARANCE.definitions.uiFont.anchor}"] button`,
        title: "Set your type",
        content: "Interface font and size. Code and prompt fonts are below.",
      },
      {
        section: "layout",
        selector: `[data-settings-anchor="${LAYOUT.definitions.presets.anchor}"]`,
        title: "Choose a density",
        content:
          "Compact trims the chrome, Detailed shows everything. Each card shows the layout it gives you.",
      },
      {
        section: "layout",
        // The areas and the picked one together rather than one area's card:
        // only the picked area is on screen, and the list says where the
        // rest live.
        selector: "[data-layout-areas]",
        title: "Every piece has a row",
        content:
          "Pick where it sits, then find one row per piece of chrome there: show it, hide it, or move it. Each sidebar row carries the button it moves.",
      },
      // The guide ends by SHOWING the editor rather than entering it (L-50):
      // the chrome around Settings dims the way it does on the canvas, so the
      // signal is understood before the door is ever opened. Closing the card
      // ends the effect and completes the guide.
      {
        section: "layout",
        selector: `[data-settings-anchor="${LAYOUT.definitions.customizeEntry.anchor}"]`,
        title: "Or point at the chrome itself",
        content:
          "The app dims around what you can change. The editor opens on a sample workspace, so your own task is left alone.",
        litChrome: true,
        requiresLayoutEditor: true,
      },
    ],
  },
  cookies: {
    requiresBrowserView: true,
    steps: [
      {
        section: "browser",
        selector: '[aria-label="Save website sessions on this computer"]',
        title: "Keep sites signed in",
        content: "Turn this on so logins survive between tasks.",
        // The switch IS the step, so there is nothing left to confirm.
        advanceOn: "browser-save-enabled",
      },
      {
        section: "browser",
        selector: '[data-testid="settings-import-logins-trigger"]',
        title: "Bring in your sign-ins",
        content: "Pick a browser, review the sites, then import.",
        completesOn: "browser-logins-imported",
      },
    ],
  },
} satisfies Record<string, SetupGuide>;

export type SetupGuideId = keyof typeof SETUP_GUIDES;

function isSetupGuideId(key: string): key is SetupGuideId {
  return key in SETUP_GUIDES;
}

export const SETUP_GUIDE_IDS: ReadonlyArray<SetupGuideId> =
  Object.keys(SETUP_GUIDES).filter(isSetupGuideId);

/**
 * The widening accessor. The table is written as literals so its sections and
 * events are checked where they are typed; reading a step's optional flags
 * needs the declared shape rather than the literal one.
 */
export function setupGuide(id: SetupGuideId): SetupGuide {
  return SETUP_GUIDES[id];
}

/** How many steps a guide has - also the progress value that means complete. */
export function setupGuideLength(id: SetupGuideId): number {
  return setupGuide(id).steps.length;
}

/**
 * The steps a shell actually walks: a step that points at the layout editor's
 * door is left out where the editor can never open. The one place that rule is
 * written - the guide card and the checklist's "Step n of total" both read it.
 */
export function setupGuideStepsFor(
  id: SetupGuideId,
  shell: { readonly layoutEditor: boolean },
): ReadonlyArray<SetupGuideStep> {
  return setupGuide(id).steps.filter(
    (step) => shell.layoutEditor || step.requiresLayoutEditor !== true,
  );
}

/** Where a guide's step lives, so a resume lands on the right section. */
export function setupGuideStepSection(
  id: SetupGuideId,
  step: number,
): SettingsSectionId {
  const steps = setupGuide(id).steps;
  return steps[Math.min(Math.max(step, 0), steps.length - 1)].section;
}

/** The guide this event finishes, if any - whether or not it is running. */
export function setupGuideCompletedBy(
  event: SetupGuideEvent,
): SetupGuideId | null {
  return (
    SETUP_GUIDE_IDS.find((id) =>
      setupGuide(id).steps.some((step) => step.completesOn === event),
    ) ?? null
  );
}

/** What this shell can offer a guide. */
export interface SetupGuideShell {
  readonly browserView: boolean;
}

/**
 * Whether a guide can be completed here at all. A guide that cannot is left
 * out of the checklist's totals: counting a step nobody can take leaves the
 * panel one short forever and keeps the "you're all set" nudge alive.
 */
export function isSetupGuideAvailable(
  id: SetupGuideId,
  shell: SetupGuideShell,
): boolean {
  return setupGuide(id).requiresBrowserView !== true || shell.browserView;
}

export function availableSetupGuideIds(
  shell: SetupGuideShell,
): ReadonlyArray<SetupGuideId> {
  return SETUP_GUIDE_IDS.filter((id) => isSetupGuideAvailable(id, shell));
}
