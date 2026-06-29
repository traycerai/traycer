import posthog from "posthog-js";

type EventProperties = Record<string, unknown> | null;

export enum AnalyticsEvent {
  TaskCreated = "task_created",
  TaskOpened = "task_opened",
  TaskShared = "task_shared",
  ChatMessageSent = "chat_message_sent",
  CommandPaletteOpened = "command_palette_opened",
  TerminalOpened = "terminal_opened",
  HarnessChanged = "harness_changed",
  HistoryNavigationUsed = "history_navigation_used",
}

export class Analytics {
  private static instance: Analytics | null = null;
  private readonly enabled: boolean;
  private readonly key: string | undefined;
  private readonly apiHost: string = "https://us.i.posthog.com";

  private constructor() {
    this.key = import.meta.env.VITE_POSTHOG_KEY;
    this.enabled = !!this.key && import.meta.env.MODE !== "test";

    if (!this.enabled || this.key === undefined) return;

    posthog.init(this.key, { api_host: this.apiHost });
    posthog.register({
      app: "gui-app",
      app_version: import.meta.env.VITE_APP_VERSION ?? null,
    });
  }

  static getInstance(): Analytics {
    if (Analytics.instance === null) Analytics.instance = new Analytics();
    return Analytics.instance;
  }

  identify(userId: string, properties: EventProperties): void {
    if (!this.enabled) return;
    posthog.identify(userId, properties ?? undefined);
  }

  reset(): void {
    if (!this.enabled) return;
    posthog.reset();
  }

  track(event: AnalyticsEvent, properties: EventProperties): void {
    if (!this.enabled) return;
    posthog.capture(event, properties ?? undefined);
  }
}
