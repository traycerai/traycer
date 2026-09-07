import { isMobileApp } from "@/lib/mobile-app";

/**
 * The acts the desktop tour can play - and the only ids the desktop diorama
 * can draw, which is why it is a type of its own rather than the whole act
 * union.
 */
export type DesktopOnboardingActId =
  | "task-tabs"
  | "navigation"
  | "task-context"
  | "providers"
  | "login-import"
  | "agent-guide"
  | "command-theme"
  | "session-import";

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
  | "agent-guide";

export type OnboardingActId = DesktopOnboardingActId | MobileOnboardingActId;

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
  /**
   * What rides along with the copy - or, for `session-import` and
   * `login-import`, what the stage itself becomes. `agent-guide` is the
   * mobile tour's own: the real editor moves into the rail there, because a
   * modal inside a phone-sized miniature is not something a thumb can type
   * into.
   */
  readonly addon:
    | "agents"
    | "session-import"
    | "login-import"
    | "theme"
    | "agent-guide"
    | null;
}

/**
 * Acts whose addon owns the copy rail's full height - the providers list, and
 * the mobile tour's agent-guide editor. Named here rather than spelled out at
 * each of the page's checks, so adding another full-height act cannot
 * half-land. (Desktop acts never carry the `agent-guide` addon, so the second
 * arm changes nothing there.)
 */
export function actUsesSoloStage(act: OnboardingAct): boolean {
  return act.addon === "agents" || act.addon === "agent-guide";
}

/**
 * The eyebrow reads "ACT 05 - YOUR WORK". The number counts the tour the user
 * is actually being walked through, not this catalog: a host that drops an act
 * would otherwise leave the survivors numbered 04, 06, 07.
 */
export function actEyebrow(act: OnboardingAct, index: number): string {
  return `ACT ${String(index + 1).padStart(2, "0")} - ${act.eyebrowLabel}`;
}

// The three acts both tours play. Shared by REFERENCE, not copied, so their
// copy has exactly one home.
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

/**
 * The desktop catalog. Copy and per-act extras mirror the Figma onboarding
 * frames.
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
  // Last on purpose: the wizard's Import button is the only thing that starts
  // an import, and the tour's own forward control ends the tour. An earlier
  // placement made Continue do both, which read as importing without asking.
  // Being last also gives the scan the whole tour to fill the list in.
  {
    id: "session-import",
    eyebrowLabel: "YOUR WORK",
    title: "Bring your\nwork with you",
    body: "Bring over existing work you started in Claude Code, Codex, or OpenCode into Traycer.",
    addon: "session-import",
  },
];

/**
 * The phone tour, five acts. Acts 1 and 2 replace the desktop lessons that
 * teach chrome a phone does not have (tab strip, drag-to-split canvas) with
 * the two things a phone user must actually find: the drawer and the switcher
 * sheet. Desktop's closing flow act (Cmd+K, the theme picker) has no phone
 * counterpart at all - the tour ends on delegation instead.
 *
 * No session-import act here: its stage is the live desktop-sized wizard
 * reading the host's own disk, and the phone tour's fixed six-act arc was
 * designed without it. Where the capability exists, the wizard stays reachable
 * from Settings. No login-import act either: a phone has no browser jar of
 * its own to import into.
 */
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

/**
 * What this shell can do, of the things the desktop tour has an act for.
 * Each false drops one act; see {@link onboardingActsFor}.
 */
export interface OnboardingTourCapabilities {
  /** The bound host advertises `sessionImport.scan`. */
  readonly sessionImportAvailable: boolean;
  /** A desktop with a browser bridge and saved logins on. */
  readonly loginImportAvailable: boolean;
}

// Precomputed per capability pair on first use, so the accessor hands back a
// stable reference per (platform, capabilities) rather than filtering into a
// fresh array on every call - memoised consumers would re-render otherwise.
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

/**
 * The tour this shell will actually walk. Two facts pick it, and both are
 * resolved per CALL rather than into a module constant:
 *
 * Platform - `setMobileApp()` runs in the Capacitor entry's `bootstrap()`,
 * which is after this module has already been evaluated as part of gui-app's
 * static graph, so a constant would pin the desktop list on a phone.
 *
 * Capability - session import is optional: an older or remote host never
 * advertises `sessionImport.scan`, and Settings and the task-list prompt
 * already hide their entry points when it does not. The session-import act
 * cannot hide the same way, because its stage IS the live wizard - there is no
 * mini-app behind it. Leaving the act in would strand the user on copy
 * inviting them to pick sessions that a host which cannot scan will never
 * produce, so the act is dropped from the tour instead. Login import is the
 * same shape one act later: its stage is the live import flow, which needs a
 * desktop with a browser bridge and saved logins ON - Settings' own row is
 * disabled with saving off, so the tour must not offer what the row would
 * refuse - and the act is dropped when either is missing.
 *
 * Everything that walks the tour - the step bounds, the progress rail, the
 * diorama - reads this list rather than `ONBOARDING_ACTS`, so an act omitted
 * here is simply unreachable.
 */
export function onboardingActsFor(
  capabilities: OnboardingTourCapabilities,
): ReadonlyArray<OnboardingAct> {
  if (isMobileApp()) return MOBILE_ONBOARDING_ACTS;
  return desktopTourFor(capabilities);
}
