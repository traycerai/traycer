import type {
  ModelProviderAuthInputs,
  ModelProviderPrompt,
  ModelProviderPromptCondition,
} from "@traycer/protocol/host/provider-native-schemas";

/**
 * The prompts DSL, evaluated. Upstream advertises the fields an auth method
 * asks for and evaluates NOTHING - the renderer is what decides which of them
 * are on screen right now, so the rule lives here as plain functions rather
 * than inside the dialog, where it could only be exercised by driving a form.
 */
export type ModelProviderPromptAnswers = ReadonlyMap<string, string>;

/**
 * A prompt with no `when` is always shown. One WITH a `when` is shown only
 * while the named answer satisfies it.
 *
 * An UNANSWERED key fails both operators, `neq` included. That is deliberate
 * rather than symmetric-looking: the only way a key goes unanswered here is
 * that it names a prompt this method does not have, or one that is itself
 * hidden - and a field whose predicate cannot be evaluated is a field we cannot
 * honestly ask for. Showing it on `neq` would surface a question whose
 * precondition never actually held.
 */
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

/**
 * The prompts on screen, in order.
 *
 * Visibility is resolved SEQUENTIALLY, and only a visible prompt's answer feeds
 * a later condition. A form is a CLI prompt loop rendered all at once: a
 * question that was never asked has no answer, so a field predicated on it must
 * not appear either. Evaluating against the whole answer map instead would let
 * a hidden select's default value reveal a field two rows down that the user
 * never had the chance to influence.
 */
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

/**
 * Starting answers for a method's prompts.
 *
 * A `select` starts on its first option because a closed choice always has a
 * current value - that is what makes it a select rather than a text field, and
 * it is what a conditional field further down is written against. A `text`
 * prompt starts empty.
 */
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

/**
 * Visible prompts that have not been answered.
 *
 * Every visible prompt counts: upstream carries no "optional" flag, and the CLI
 * this surface replaces will not move past a prompt until it has a value. The
 * consequence is that the submit button stays disabled rather than the host
 * storing an empty string as a deliberate-looking answer.
 */
export function unansweredModelProviderPrompts(
  prompts: readonly ModelProviderPrompt[],
  answers: ModelProviderPromptAnswers,
): readonly ModelProviderPrompt[] {
  return visibleModelProviderPrompts(prompts, answers).filter(
    (prompt) => (answers.get(prompt.key) ?? "").trim().length === 0,
  );
}

/**
 * The wire payload for a method's prompted fields, keyed by prompt key. HIDDEN
 * prompts contribute nothing - a field the user never saw is not an answer, and
 * sending its seeded default would be a client bug dressed as data.
 *
 * Answers are TRIMMED, matching the predicate that decides whether a prompt
 * counts as answered. Without that, `"  acct-123  "` passes the
 * whitespace-trimming check and then reaches upstream with the padding intact -
 * the submit button says the form is complete and the provider is handed
 * something subtly different from what the field displayed. The credential
 * itself is already trimmed at its own call site.
 */
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
