import { isMobileApp } from "@/lib/mobile-app";

export type OnboardingStepId = "task-tabs" | "providers" | "session-import";

export interface OnboardingStep {
  readonly id: OnboardingStepId;
  readonly label: string;
  readonly title: string;
  readonly body: string | null;
}

export const ONBOARDING_STEPS: ReadonlyArray<OnboardingStep> = [
  {
    id: "task-tabs",
    label: "Workspace",
    title: "A home for all your work.",
    body: null,
  },
  {
    id: "providers",
    label: "Providers",
    title: "Choose your agents.",
    body: "Keep your accounts, skills, and plugins.",
  },
  {
    id: "session-import",
    label: "Import",
    title: "Pick up where you left off.",
    body: "Import conversations from Claude Code, Codex, and OpenCode.",
  },
];

const WITHOUT_IMPORT = ONBOARDING_STEPS.slice(0, 2);
const MOBILE_STEPS: ReadonlyArray<OnboardingStep> = [
  {
    ...ONBOARDING_STEPS[0],
    body: "Find tasks in the menu. Use the tab switcher for chats, browsers, and files.",
  },
  ONBOARDING_STEPS[1],
];

export function onboardingStepsFor(
  sessionImportAvailable: boolean,
): ReadonlyArray<OnboardingStep> {
  if (isMobileApp()) return MOBILE_STEPS;
  return sessionImportAvailable ? ONBOARDING_STEPS : WITHOUT_IMPORT;
}
