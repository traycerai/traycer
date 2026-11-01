/**
 * Query and mutation keys for a bot's Slack app (traycer-server
 * `/api/slack/apps/*`), read through `AuthService` like the sandbox control
 * plane. Keyed to the live AuthService and signed-in user for the reason
 * `authQueryKeys.registeredHosts` gives, then to the bot.
 */
export const botSlackQueryKeys = {
  app: (
    authService: object,
    userId: string | null,
    botId: string,
  ): readonly unknown[] => [
    "auth",
    "bot-slack-app",
    authService,
    userId,
    botId,
  ],
  manifest: (
    authService: object,
    userId: string | null,
    botId: string,
  ): readonly unknown[] => [
    "auth",
    "bot-slack-manifest",
    authService,
    userId,
    botId,
  ],
  missing: (): readonly unknown[] => ["auth", "bot-slack-app", "missing"],
};

export const botSlackMutationKeys = {
  register: (botId: string) => ["bot.slack.register", botId] as const,
  installUrl: (botId: string) => ["bot.slack.installUrl", botId] as const,
  disconnect: (botId: string) => ["bot.slack.disconnect", botId] as const,
};
