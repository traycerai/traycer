import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import {
  defineSettingsSection,
  type SettingsRowDefinition,
} from "@/lib/settings-search/settings-definitions";
import {
  TOUR_COPY,
  type LessonId,
} from "@/stores/onboarding/onboarding-tour-catalog";

/**
 * Settings ▸ Onboarding: the page, its progress summary, and one row per
 * lesson. Every card's label and description lives in one place - the four
 * non-tour lessons' here, the five tours' in the catalogue's `TOUR_COPY`,
 * which the tour host names them by too - and the panel renders them from
 * these definitions while the search index reads the same values, so a card
 * cannot exist without being findable.
 *
 * Every anchored member is gated on the build rather than always available:
 * the mobile app omits the section outright (every lesson teaches the
 * desktop shell), so a panel mounted there from a remembered path renders
 * no lesson surface, and the index must promise none either.
 */
export function isOnboardingLessonsAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return !context.mobileApp;
}

export const ONBOARDING = defineSettingsSection("onboarding", {
  page: {
    label: "Onboarding",
    description:
      "Guided tours and lessons for the desktop app - pick up where you left off, or replay one.",
    keywords: [
      "onboarding",
      "tour",
      "product tour",
      "welcome",
      "first run",
      "learn",
      "lessons",
      "replay",
      "walkthrough",
      "guide",
      "intro",
    ],
  },
  progress: {
    kind: "group",
    search: { anchor: "onboarding-progress" },
    label: "Your progress",
    description: null,
    breadcrumb: null,
    availableWhen: isOnboardingLessonsAvailable,
    keywords: ["progress", "completed", "tours done", "status", "resume"],
  },
  welcome: {
    kind: "row",
    group: "progress",
    search: { anchor: "onboarding-welcome" },
    label: "Welcome",
    description:
      "The first-run welcome: your coding agents, and any work to bring over.",
    availableWhen: isOnboardingLessonsAvailable,
    keywords: ["welcome modal", "show again", "first launch", "restart"],
  },
  guidedTours: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Guided tours",
    description: null,
    breadcrumb: null,
    availableWhen: isOnboardingLessonsAvailable,
    keywords: ["spotlight", "step by step"],
  },
  addFolder: {
    kind: "row",
    group: "guidedTours",
    search: { anchor: "onboarding-lesson-add-folder" },
    label: TOUR_COPY["add-folder"].title,
    description: TOUR_COPY["add-folder"].summary,
    availableWhen: isOnboardingLessonsAvailable,
    keywords: ["folder", "workspace", "project", "repository", "directory"],
  },
  terminalMode: {
    kind: "row",
    group: "guidedTours",
    search: { anchor: "onboarding-lesson-terminal-mode" },
    label: TOUR_COPY["terminal-mode"].title,
    description: TOUR_COPY["terminal-mode"].summary,
    availableWhen: isOnboardingLessonsAvailable,
    keywords: ["terminal", "cli", "claude code", "codex", "agent"],
  },
  submitPrompt: {
    kind: "row",
    group: "guidedTours",
    search: { anchor: "onboarding-lesson-submit-prompt" },
    label: TOUR_COPY["submit-prompt"].title,
    description: TOUR_COPY["submit-prompt"].summary,
    availableWhen: isOnboardingLessonsAvailable,
    keywords: ["prompt", "chat", "message", "compose", "first task"],
  },
  taskPanels: {
    kind: "row",
    group: "guidedTours",
    search: { anchor: "onboarding-lesson-task-panels" },
    label: TOUR_COPY["task-panels"].title,
    description: TOUR_COPY["task-panels"].summary,
    availableWhen: isOnboardingLessonsAvailable,
    keywords: ["panels", "sidebar", "artifacts", "diff", "canvas", "layout"],
  },
  history: {
    kind: "row",
    group: "guidedTours",
    search: { anchor: "onboarding-lesson-history" },
    label: TOUR_COPY.history.title,
    description: TOUR_COPY.history.summary,
    availableWhen: isOnboardingLessonsAvailable,
    keywords: ["history", "imported", "sessions", "bring your work"],
  },
  moreLessons: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "More to explore",
    description: null,
    breadcrumb: null,
    availableWhen: isOnboardingLessonsAvailable,
    keywords: ["demo", "lesson"],
  },
  splitScreen: {
    kind: "row",
    group: "moreLessons",
    search: { anchor: "onboarding-lesson-split-screen" },
    label: "Split screen",
    description:
      "Drag an agent from the sidebar to an edge of the canvas to open it beside your chat.",
    availableWhen: isOnboardingLessonsAvailable,
    keywords: ["split", "drag", "pane", "side by side", "drop zone"],
  },
  taskTabs: {
    kind: "row",
    group: "moreLessons",
    search: { anchor: "onboarding-lesson-task-tabs" },
    label: "Task tabs & navigation",
    description:
      "Every tab at the top is a task; switching one swaps the sidebar and the canvas with it.",
    availableWhen: isOnboardingLessonsAvailable,
    keywords: ["tabs", "switch task", "navigation", "workspace"],
  },
  agentGuide: {
    kind: "row",
    group: "moreLessons",
    search: { anchor: "onboarding-lesson-agent-guide" },
    label: "Agent selection guide",
    description:
      "The instructions Traycer follows when it picks a coding agent and model for a child agent.",
    availableWhen: isOnboardingLessonsAvailable,
    keywords: ["agent selection", "guide", "instructions", "model", "editor"],
  },
  loginImport: {
    kind: "row",
    group: "moreLessons",
    search: { anchor: "onboarding-lesson-login-import" },
    label: "Browser login import",
    description:
      "Bring the logins from the browser you already use, so agents work on those sites as you.",
    availableWhen: isOnboardingLessonsAvailable,
    keywords: ["logins", "cookies", "import", "browser", "sign in", "sites"],
  },
});

/**
 * The lesson rows keyed by `LessonId`, so the panel iterates the catalogue's
 * order and the definitions stay the one place the copy lives. Spelled out
 * rather than derived so a lesson added to the catalogue is a compile error
 * here until it has a row.
 */
export const ONBOARDING_LESSON_ROWS: Readonly<
  Record<LessonId, SettingsRowDefinition>
> = {
  "add-folder": ONBOARDING.definitions.addFolder,
  "terminal-mode": ONBOARDING.definitions.terminalMode,
  "submit-prompt": ONBOARDING.definitions.submitPrompt,
  "task-panels": ONBOARDING.definitions.taskPanels,
  history: ONBOARDING.definitions.history,
  "split-screen": ONBOARDING.definitions.splitScreen,
  "task-tabs": ONBOARDING.definitions.taskTabs,
  "agent-guide": ONBOARDING.definitions.agentGuide,
  "login-import": ONBOARDING.definitions.loginImport,
};
