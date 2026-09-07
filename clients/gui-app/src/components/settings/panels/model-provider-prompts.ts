import type {
  ModelProviderAuthInputs,
  ModelProviderPrompt,
  ModelProviderPromptCondition,
} from "@traycer/protocol/host/provider-native-schemas";

/** Upstream advertises the fields an auth method asks for and evaluates nothing. */
export type ModelProviderPromptAnswers = ReadonlyMap<string, string>;

/** That is deliberate rather than symmetric-looking: the only way a key goes unanswered here is that it names a
 * prompt this method does not have, or one that is itself hidden. */
export function modelProviderPromptConditionSatisfied(
  condition: ModelProviderPromptCondition,
  answers: ModelProviderPromptAnswers,
): boolean {
  const answer = answers.get(condition.key);
  if (answer === undefined) return false;
  return condition.op === "eq"
    ? answer === condition.value
    : answer !== condition.value;
}

/** A form is a CLI prompt loop rendered all at once: a question that was never asked has no answer, so a field
 * predicated on it must not appear either. */
export function visibleModelProviderPrompts(
  prompts: readonly ModelProviderPrompt[],
  answers: ModelProviderPromptAnswers,
): readonly ModelProviderPrompt[] {
  const visible: ModelProviderPrompt[] = [];
  const asked = new Map<string, string>();
  for (const prompt of prompts) {
    if (
      prompt.when !== null &&
      !modelProviderPromptConditionSatisfied(prompt.when, asked)
    ) {
      continue;
    }
    visible.push(prompt);
    const answer = answers.get(prompt.key);
    if (answer !== undefined) asked.set(prompt.key, answer);
  }
  return visible;
}

/** A `select` starts on its first option because a closed choice always has a current value. */
export function defaultModelProviderPromptAnswers(
  prompts: readonly ModelProviderPrompt[],
): ReadonlyMap<string, string> {
  const answers = new Map<string, string>();
  for (const prompt of prompts) {
    if (prompt.type === "select") {
      const first = prompt.options.at(0);
      answers.set(prompt.key, first === undefined ? "" : first.value);
      continue;
    }
    answers.set(prompt.key, "");
  }
  return answers;
}

/** The consequence is that the submit button stays disabled rather than the host storing an empty string as a
 * deliberate-looking answer. */
export function unansweredModelProviderPrompts(
  prompts: readonly ModelProviderPrompt[],
  answers: ModelProviderPromptAnswers,
): readonly ModelProviderPrompt[] {
  return visibleModelProviderPrompts(prompts, answers).filter(
    (prompt) => (answers.get(prompt.key) ?? "").trim().length === 0,
  );
}

/** Hidden prompts contribute nothing - a field the user never saw is not an answer, and sending its seeded
 * default would be a client bug dressed as data. */
export function modelProviderPromptInputs(
  prompts: readonly ModelProviderPrompt[],
  answers: ModelProviderPromptAnswers,
): ModelProviderAuthInputs {
  const inputs: Record<string, string> = {};
  for (const prompt of visibleModelProviderPrompts(prompts, answers)) {
    inputs[prompt.key] = (answers.get(prompt.key) ?? "").trim();
  }
  return inputs;
}
