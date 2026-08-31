import { isMobileApp } from "@/lib/mobile-app";

/**
 * The acts the desktop tour plays - and the only ids the desktop diorama can
 * draw, which is why it is a type of its own rather than the whole act union.
 */
export type DesktopOnboardingActId =
  | "task-tabs"
  | "navigation"
  | "task-context"
  | "providers"
  | "agent-guide"
  | "command-theme";

/**
 * The acts the mobile tour plays. Three ids are shared with desktop on purpose:
 * those acts teach the same platform-neutral lesson, so keeping the id keeps
 * their analytics comparable across platforms.
 */
export type MobileOnboardingActId =
  | "mobile-tasks"
  | "mobile-switcher"
  | "task-context"
  | "providers"
  | "agent-guide"
  | "mobile-flow";

export type OnboardingActId = DesktopOnboardingActId | MobileOnboardingActId;

export interface OnboardingAct {
  readonly id: OnboardingActId;
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  /**
   * What the copy rail carries under the body. `agent-guide` is the mobile
   * tour's own: the real editor moves into the rail there, because a modal
   * inside a phone-sized miniature is not something a thumb can type into.
   */
  readonly addon: "agents" | "theme" | "agent-guide" | null;
}

// The three acts both tours play. Shared by REFERENCE, not copied, so their
// copy has exactly one home.
const TASK_CONTEXT_ACT: OnboardingAct = {
  id: "task-context",
  eyebrow: "ACT 03 - HANDOFF",
  title: "Agents that talk\nto each other",
  body: "Your agents coordinate inside one Task: delegate work, report back, and stay in sync without you acting as the relay.",
  addon: null,
};

const PROVIDERS_ACT: OnboardingAct = {
  id: "providers",
  eyebrow: "ACT 04 - PROVIDERS",
  title: "Bring your\nsubscriptions with you",
  body: "Connect the coding agents you already use.",
  addon: "agents",
};

const AGENT_GUIDE_ACT: OnboardingAct = {
  id: "agent-guide",
  eyebrow: "ACT 05 - DELEGATION",
  title: "Tell Traycer\nhow to choose",
  body: "Set the rules once. Traycer follows them every time it spawns a child agent, so you're not re-deciding per task.",
  addon: null,
};

/**
 * Copy and per-act extras mirror the Figma onboarding frames.
 */
const DESKTOP_ONBOARDING_ACTS: ReadonlyArray<OnboardingAct> = [
  {
    id: "task-tabs",
    eyebrow: "ACT 01 - TASKS",
    title: "Your work lives\nin Task tabs",
    body: "Each Task tab holds one initiative: agents, artifacts, terminals, and context stay together. Switch away, come back later, nothing scatters.",
    addon: null,
  },
  {
    id: "navigation",
    eyebrow: "ACT 02 - LAYOUT",
    title: "Find it on the left.\nOpen it on the canvas.",
    body: "The left lists are your map: agents and artifacts. The canvas is where selected work opens, splits, and stays beside the conversation.",
    addon: null,
  },
  TASK_CONTEXT_ACT,
  PROVIDERS_ACT,
  AGENT_GUIDE_ACT,
  {
    id: "command-theme",
    eyebrow: "ACT 06 - FLOW",
    title: "Move fast.\nMake it yours.",
    body: "Use Cmd+K to create, jump, launch, and switch without breaking flow. Pick a theme before you enter; terminals and app surfaces follow it together.",
    addon: "theme",
  },
];

/**
 * The phone tour. Acts 1, 2 and 6 replace the desktop lessons that teach chrome
 * a phone does not have (tab strip, drag-to-split canvas, Cmd+K) with the three
 * things a phone user must actually find: the drawer, the switcher sheet, and
 * the edge-swipe gestures.
 */
const MOBILE_ONBOARDING_ACTS: ReadonlyArray<OnboardingAct> = [
  {
    id: "mobile-tasks",
    eyebrow: "ACT 01 - TASKS",
    title: "Your work lives\nin Tasks",
    body: "Each Task holds one initiative: agents, artifacts, terminals, and context stay together. The menu, top left, holds your recent Tasks, a new one, and Settings.",
    addon: null,
  },
  {
    id: "mobile-switcher",
    eyebrow: "ACT 02 - LAYOUT",
    title: "One tap opens\neverything",
    body: "The stack icon, top right, is the whole Task: chats, terminals, artifacts, diffs. Pick one; it fills the screen.",
    addon: null,
  },
  TASK_CONTEXT_ACT,
  PROVIDERS_ACT,
  // The one shared act that differs: same id and copy, but the editor rides in
  // the copy rail instead of a modal inside the miniature.
  { ...AGENT_GUIDE_ACT, addon: "agent-guide" },
  {
    id: "mobile-flow",
    eyebrow: "ACT 06 - FLOW",
    title: "Move with a swipe.\nMake it yours.",
    body: "Swipe from the left edge to go back, the right edge to go forward. Pick a theme before you enter; terminals and app surfaces follow it together.",
    addon: "theme",
  },
];

/**
 * The tour the current shell plays. This is ONE of the tour's two platform
 * reads (the other is the page's miniature branch); every other consumer - the
 * store's step clamp, the progress rail, the copy rail, the page's step math -
 * follows from here.
 *
 * Resolved per CALL rather than into a module constant: `setMobileApp()` runs
 * in the Capacitor entry's `bootstrap()`, which is after this module has
 * already been evaluated as part of gui-app's static graph. A constant would
 * therefore pin the desktop list on a phone. Each branch returns the same array
 * instance, so callers still get a stable reference.
 */
export function onboardingActs(): ReadonlyArray<OnboardingAct> {
  return isMobileApp() ? MOBILE_ONBOARDING_ACTS : DESKTOP_ONBOARDING_ACTS;
}
