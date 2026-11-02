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
 * it; `failure` is what the call answered, for the places that branch on it.
 */
export class BotSlackAppError extends Error {
  readonly failure: SlackAppFailure;

  constructor(failure: SlackAppFailure, fallback: string) {
    super(slackAppFailureLine(failure, fallback));
    this.name = "BotSlackAppError";
    this.failure = failure;
  }
}

/**
 * The line that replaces the group when no bot can be connected to Slack
 * from here: this server has no Slack, or this build cannot reach the server
 * at all. `null` for any other failure.
 */
export function slackUnavailableLine(error: Error | null): string | null {
  if (!(error instanceof BotSlackAppError)) return null;
  const failure = error.failure;
  if (failure.kind === "unavailable") return failure.reason;
  return failure.kind === "refused" &&
    failure.code === SLACK_APP_REFUSAL_NOT_CONFIGURED
    ? SLACK_NOT_AVAILABLE_LINE
    : null;
}

/**
 * Whether the person can no longer act on the bot's app at all: signed out,
 * or no longer one of the bot's members. Every control would be refused, so
 * the panel shows the refusal instead of the app it read before.
 */
export function isSlackAccessRefused(error: Error | null): boolean {
  if (!(error instanceof BotSlackAppError)) return false;
  const failure = error.failure;
  return (
    failure.kind === "unauthorized" ||
    (failure.kind === "refused" &&
      failure.code === SLACK_APP_REFUSAL_BOT_NOT_FOUND)
  );
}

function slackAppFailureLine(
  failure: SlackAppFailure,
  fallback: string,
): string {
  if (failure.kind === "unauthorized") {
    return "Sign in to change this bot's Slack app.";
  }
  if (failure.kind === "unavailable") return failure.reason;
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
