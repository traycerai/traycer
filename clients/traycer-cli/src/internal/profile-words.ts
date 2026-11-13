import type {
  ProviderId,
  ProviderProfilePersonNotice,
} from "@traycer/protocol/host/provider-schemas";
import { GUI_HARNESS_BY_PROVIDER_ID } from "../../../shared/providers/provider-harness-ids";
import { printable } from "./profile-target";

/**
 * The words the `traycer profile` commands print for an account's person
 * state, its Terminal login and its open name question: the app's words, so
 * the CLI and the app tell one story. Every such string is here.
 */

/** Printed in place of the raw sign-in word when the computer sets a notice. */
export const PERSON_NOTICE_WORDS: Record<ProviderProfilePersonNotice, string> =
  {
    "needs-sign-in": "Needs a sign-in",
    waiting: "Waiting for Traycer",
  };

/**
 * Under a row whose account is also this computer's Terminal login. The CLI
 * only ever reaches the host on its own computer.
 */
export const TERMINAL_ACCOUNT_LINE = "Terminal account on this computer";

export const NAME_QUESTION = "Which name should this account use?";

/** `"A"`, `"A" or "B"`, `"A", "B" or "C"`. */
function quotedChoices(choices: readonly string[]): string {
  const quoted = choices.map((choice) => `"${printable(choice)}"`);
  const last = quoted.pop();
  if (last === undefined) return "";
  return quoted.length === 0 ? last : `${quoted.join(", ")} or ${last}`;
}

/** The question with its choices on one line, as the list shows it. */
export function nameQuestionLine(choices: readonly string[]): string {
  return choices.length === 0
    ? NAME_QUESTION
    : `${NAME_QUESTION} ${quotedChoices(choices)}`;
}

/** The prompt shown on a terminal, without the line the answer is typed on. */
export function nameQuestionPrompt(choices: readonly string[]): string {
  return [
    NAME_QUESTION,
    ...choices.map(
      (choice, index) => `  ${String(index + 1)}. ${printable(choice)}`,
    ),
  ].join("\n");
}

export const NAME_ANSWER_PROMPT =
  "Type a number or another name, or press Enter to skip:";

export const NAME_TOO_LONG = "A name is 1 to 64 characters.";

function renameCommand(providerId: ProviderId, profileId: string): string {
  return `traycer profile rename ${GUI_HARNESS_BY_PROVIDER_ID[providerId]} ${printable(profileId)} <name>`;
}

export function nameAppliedLine(label: string): string {
  return `This account now uses the name "${printable(label)}".`;
}

export function nameConflictLine(label: string): string {
  return `This account's name was already chosen: "${printable(label)}".`;
}

export function nameSkippedLine(
  providerId: ProviderId,
  profileId: string,
): string {
  return `No name chosen. To choose one later: ${renameCommand(providerId, profileId)}`;
}

/** A sign-in with no terminal to ask on. */
export function nameNeedsChoiceLine(
  choices: readonly string[],
  providerId: ProviderId,
  profileId: string,
): string {
  return `${nameQuestionLine(choices)}. Choose with: ${renameCommand(providerId, profileId)}`;
}

export function renameConflictLine(label: string): string {
  return `Not renamed: this account's name was already chosen: "${printable(label)}".`;
}
