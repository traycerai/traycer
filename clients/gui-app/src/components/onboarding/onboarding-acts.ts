export type OnboardingActId =
  | "task-tabs"
  | "navigation"
  | "task-context"
  | "providers"
  | "session-import"
  | "agent-guide"
  | "command-theme";

export interface OnboardingAct {
  readonly id: OnboardingActId;
  /**
   * The half of the eyebrow after the act number. The number itself is the
   * act's place in the tour being shown, so it cannot live in this data - see
   * `actEyebrow`.
   */
  readonly eyebrowLabel: string;
  readonly title: string;
  readonly body: string;
  readonly addon: "agents" | "session-import" | "theme" | null;
}

/**
 * Acts whose addon IS the act - a live panel that needs the copy rail's full
 * height and drops the mini-app when the layout stacks. Named here rather than
 * spelled out at each of the page's three checks, so adding another full-bleed
 * act cannot half-land.
 */
export function actUsesSoloStage(act: OnboardingAct): boolean {
  return act.addon === "agents";
}

/**
 * The eyebrow reads "ACT 05 - YOUR WORK". The number counts the tour the user
 * is actually being walked through, not this catalog: a host that drops an act
 * would otherwise leave the survivors numbered 04, 06, 07.
 */
export function actEyebrow(act: OnboardingAct, index: number): string {
  return `ACT ${String(index + 1).padStart(2, "0")} - ${act.eyebrowLabel}`;
}

/**
 * Copy and per-act extras mirror the Figma onboarding frames.
 */
export const ONBOARDING_ACTS: ReadonlyArray<OnboardingAct> = [
  {
    id: "task-tabs",
    eyebrowLabel: "TASKS",
    title: "Your work lives\nin Task tabs",
    body: "Each Task tab holds one initiative: agents, artifacts, terminals, and context stay together. Switch away, come back later, nothing scatters.",
    addon: null,
  },
  {
    id: "navigation",
    eyebrowLabel: "LAYOUT",
    title: "Find it on the left.\nOpen it on the canvas.",
    body: "The left lists are your map: agents and artifacts. The canvas is where selected work opens, splits, and stays beside the conversation.",
    addon: null,
  },
  {
    id: "task-context",
    eyebrowLabel: "HANDOFF",
    title: "Agents that talk\nto each other",
    body: "Your agents coordinate inside one Task: delegate work, report back, and stay in sync without you acting as the relay.",
    addon: null,
  },
  {
    id: "providers",
    eyebrowLabel: "PROVIDERS",
    title: "Bring your\nsubscriptions with you",
    body: "Connect the coding agents you already use.",
    addon: "agents",
  },
  {
    id: "session-import",
    eyebrowLabel: "YOUR WORK",
    title: "Bring your\nwork with you",
    body: "Work you started in Claude Code, Codex, or OpenCode comes with you as tasks. Pick what to bring; the import runs while you carry on.",
    addon: "session-import",
  },
  {
    id: "agent-guide",
    eyebrowLabel: "DELEGATION",
    title: "Tell Traycer\nhow to choose",
    body: "Set the rules once. Traycer follows them every time it spawns a child agent, so you're not re-deciding per task.",
    addon: null,
  },
  {
    id: "command-theme",
    eyebrowLabel: "FLOW",
    title: "Move fast.\nMake it yours.",
    body: "Use Cmd+K to create, jump, launch, and switch without breaking flow. Pick a theme before you enter; terminals and app surfaces follow it together.",
    addon: "theme",
  },
];

/**
 * The acts one host can actually run, which is why the tour's length is a
 * per-host fact rather than a module constant.
 *
 * Session import is an optional host capability: an older or remote host never
 * advertises `sessionImport.scan`, and Settings and the task-list prompt
 * already hide their entry points when it does not. The session-import act
 * cannot hide the same way, because its stage IS the live wizard - there is no
 * mini-app behind it. Leaving the act in would strand the user on copy
 * inviting them to pick sessions that a host which cannot scan will never
 * produce, so the act is dropped from the tour instead.
 *
 * Everything that walks the tour - the step bounds, the progress rail, the
 * diorama - reads this list rather than `ONBOARDING_ACTS`, so an act omitted
 * here is simply unreachable.
 */
export function onboardingActsFor(
  sessionImportAvailable: boolean,
): ReadonlyArray<OnboardingAct> {
  if (sessionImportAvailable) return ONBOARDING_ACTS;
  return ONBOARDING_ACTS.filter((act) => act.id !== "session-import");
}
