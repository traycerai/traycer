import type { SlackAppFailure } from "@traycer-clients/shared/host-client/slack-app";
import {
  SLACK_APP_REFUSAL_APP_NOT_FOUND,
  SLACK_APP_REFUSAL_APP_TAKEN,
  SLACK_APP_REFUSAL_BOT_NOT_FOUND,
  SLACK_APP_REFUSAL_NOT_CONFIGURED,
} from "@traycer/protocol/host/slack-app";

export const SLACK_NOT_AVAILABLE_LINE = "Slack isn't available on this server.";

/**
 * A Slack app call that did not succeed, thrown by the bot's Slack hooks so
 * the settings panel shows it in place. `message` is the person's line for
 * it; `failure` is what the server answered, for the one place that branches
 * on it (the not-configured server, which replaces the steps).
 */
export class BotSlackAppError extends Error {
  readonly failure: SlackAppFailure;

  constructor(failure: SlackAppFailure, fallback: string) {
    super(slackAppFailureLine(failure, fallback));
    this.name = "BotSlackAppError";
    this.failure = failure;
  }
}

/** Whether this server cannot connect any bot to Slack. */
export function isSlackNotConfigured(error: Error | null): boolean {
  return (
    error instanceof BotSlackAppError &&
    error.failure.kind === "refused" &&
    error.failure.code === SLACK_APP_REFUSAL_NOT_CONFIGURED
  );
}

function slackAppFailureLine(
  failure: SlackAppFailure,
  fallback: string,
): string {
  if (failure.kind === "unauthorized") {
    return "Sign in to change this bot's Slack app.";
  }
  if (failure.kind === "network-error") return fallback;
  switch (failure.code) {
    case SLACK_APP_REFUSAL_NOT_CONFIGURED:
      return SLACK_NOT_AVAILABLE_LINE;
    case SLACK_APP_REFUSAL_APP_TAKEN:
      return "This Slack app is already connected to another bot.";
    case SLACK_APP_REFUSAL_BOT_NOT_FOUND:
      return "You can't change this bot's Slack app.";
    case SLACK_APP_REFUSAL_APP_NOT_FOUND:
      return "Register the app first.";
    default:
      return fallback;
  }
}
