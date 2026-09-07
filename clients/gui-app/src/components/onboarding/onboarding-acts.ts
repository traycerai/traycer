import { isMobileApp } from "@/lib/mobile-app";

/** The acts the desktop tour can play - and the only ids the desktop diorama can draw, which is why it is a
 * type of its own rather than the whole act union. */
export type DesktopOnboardingActId =
  | "task-tabs"
  | "navigation"
  | "task-context"
  | "providers"
  | "login-import"
  | "agent-guide"
  | "command-theme"
  | "session-import";

/** The acts the mobile tour plays. */
export type MobileOnboardingActId =
  | "mobile-tasks"
  | "mobile-switcher"
  | "task-context"
  | "providers"
  | "agent-guide";

export type OnboardingActId = DesktopOnboardingActId | MobileOnboardingActId;

export interface OnboardingAct {
  readonly id: OnboardingActId;
  /** The half of the eyebrow after the act number. The number itself is the act's place in the tour being shown,
   * so it cannot live in this data - see `actEyebrow`. */
  readonly eyebrowLabel: string;
  readonly title: string;
  readonly body: string;
  /** `agent-guide` is the mobile tour's own: the real editor moves into the rail there, because a modal inside a
   * phone-sized miniature is not something a thumb can type into. */
  readonly addon:
    | "agents"
    | "session-import"
    | "login-import"
    | "theme"
    | "agent-guide"
    | null;
}

/** Named here rather than spelled out at each of the page's checks, so adding another full-height act cannot
 * half-land. (Desktop acts never carry the `agent-guide` addon, so the second arm changes nothing there.) */
export function actUsesSoloStage(act: OnboardingAct): boolean {
  return act.addon === "agents" || act.addon === "agent-guide";
}

/** The number counts the tour the user is actually being walked through, not this catalog: a host that drops an
 * act would otherwise leave the survivors numbered 04, 06, 07. */
export function actEyebrow(act: OnboardingAct, index: number): string {
  return `ACT ${String(index + 1).padStart(2, "0")} - ${act.eyebrowLabel}`;
}

// The three acts both tours play. Shared by reference, not copied, so their copy has exactly one home.
const TASK_CONTEXT_ACT: OnboardingAct = {
  id: "task-context",
  eyebrowLabel: "HANDOFF",
  title: "Agents that talk\nto each other",
  body: "Your agents coordinate inside one Task: delegate work, report back, and stay in sync without you acting as the relay.",
  addon: null,
};

const PROVIDERS_ACT: OnboardingAct = {
  id: "providers",
  eyebrowLabel: "PROVIDERS",
  title: "Bring your\nsubscriptions with you",
  body: "Connect the coding agents you already use.",
  addon: "agents",
};

const AGENT_GUIDE_ACT: OnboardingAct = {
  id: "agent-guide",
  eyebrowLabel: "DELEGATION",
  title: "Tell Traycer\nhow to choose",
  body: "Set the rules once. Traycer follows them every time it spawns a child agent, so you're not re-deciding per task.",
  addon: null,
};

/** The desktop catalog. */
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
  TASK_CONTEXT_ACT,
  PROVIDERS_ACT,
  {
    id: "login-import",
    eyebrowLabel: "YOUR LOGINS",
    title: "Stay signed in\neverywhere",
    body: "Bring the logins from the browser you already use into Traycer's browser. Agents then work on those sites as you.",
    addon: "login-import",
  },
  AGENT_GUIDE_ACT,
  {
    id: "command-theme",
    eyebrowLabel: "FLOW",
    title: "Move fast.\nMake it yours.",
    body: "Use Cmd+K to create, jump, launch, and switch without breaking flow. Pick a theme; terminals and app surfaces follow it together.",
    addon: "theme",
  },
  // Last on purpose: the wizard's Import button is the only thing that starts an import, and the tour's own
  // forward control ends the tour.
  {
    id: "session-import",
    eyebrowLabel: "YOUR WORK",
    title: "Bring your\nwork with you",
    body: "Bring over existing work you started in Claude Code, Codex, or OpenCode into Traycer.",
    addon: "session-import",
  },
];

/** Acts 1 and 2 replace the desktop lessons that teach chrome a phone does not have (tab strip, drag-to-split
 * canvas) with the two things a phone user must actually find: the drawer and the switcher sheet. */
const MOBILE_ONBOARDING_ACTS: ReadonlyArray<OnboardingAct> = [
  {
    id: "mobile-tasks",
    eyebrowLabel: "TASKS",
    title: "Your work lives\nin Tasks",
    body: "Each Task holds one initiative: agents, artifacts, terminals, and context stay together. The menu, top left, holds your recent Tasks, a new one, and Settings.",
    addon: null,
  },
  {
    id: "mobile-switcher",
    eyebrowLabel: "LAYOUT",
    title: "One tap opens\neverything",
    body: "The stack icon, top right, is the whole Task: chats, terminals, artifacts, diffs. Pick one; it fills the screen.",
    addon: null,
  },
  TASK_CONTEXT_ACT,
  PROVIDERS_ACT,
  // The one shared act that differs: same id and copy, but the editor rides in
  // the copy rail instead of a modal inside the miniature.
  { ...AGENT_GUIDE_ACT, addon: "agent-guide" },
];

/** What this shell can do, of the things the desktop tour has an act for. */
export interface OnboardingTourCapabilities {
  readonly sessionImportAvailable: boolean;
  readonly loginImportAvailable: boolean;
}

// Precomputed per capability pair on first use, so the accessor hands back a stable reference per (platform,
// capabilities) rather than filtering into a fresh array on every call.
const DESKTOP_TOURS = new Map<string, ReadonlyArray<OnboardingAct>>();

function desktopTourFor(
  capabilities: OnboardingTourCapabilities,
): ReadonlyArray<OnboardingAct> {
  if (
    capabilities.sessionImportAvailable &&
    capabilities.loginImportAvailable
  ) {
    return ONBOARDING_ACTS;
  }
  const key = `${String(capabilities.sessionImportAvailable)}:${String(capabilities.loginImportAvailable)}`;
  const cached = DESKTOP_TOURS.get(key);
  if (cached !== undefined) return cached;
  const tour = ONBOARDING_ACTS.filter(
    (act) =>
      (act.id !== "session-import" || capabilities.sessionImportAvailable) &&
      (act.id !== "login-import" || capabilities.loginImportAvailable),
  );
  DESKTOP_TOURS.set(key, tour);
  return tour;
}

/** Leaving the act in would strand the user on copy inviting them to pick sessions that a host which cannot
 * scan will never produce, so the act is dropped from the tour instead. */
export function onboardingActsFor(
  capabilities: OnboardingTourCapabilities,
): ReadonlyArray<OnboardingAct> {
  if (isMobileApp()) return MOBILE_ONBOARDING_ACTS;
  return desktopTourFor(capabilities);
}
