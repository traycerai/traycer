export type FormattableHarnessModelSummary = {
  readonly id: string;
  readonly reasoningEfforts: readonly string[];
  readonly fastModeAvailable: boolean;
  readonly serviceTiers: readonly string[];
};

export type FormattableListHarnessModelsResponse = {
  readonly harnessId: string;
  readonly models: readonly FormattableHarnessModelSummary[];
};

export function formatListHarnessModelsResponse(
  response: FormattableListHarnessModelsResponse,
): string {
  const legend = `Each line is: model-name [reasoningEffort: values] [serviceTier: ids] [fastMode]
reasoningEffort, serviceTier and fastMode are optional create params. They are valid only when shown for the selected model. An explicit serviceTier takes precedence over fastMode.`;
  if (response.models.length === 0) {
    return `${legend}

No models found for harness '${response.harnessId}'.`;
  }
  return `${legend}

${response.models.map(formatHarnessModelSummary).join("\n")}`;
}

function formatHarnessModelSummary(
  model: FormattableHarnessModelSummary,
): string {
  const reasoning =
    model.reasoningEfforts.length === 0
      ? ""
      : ` [reasoningEffort: ${model.reasoningEfforts.join("|")}]`;
  const fastMode = model.fastModeAvailable ? " [fastMode]" : "";
  const tiers =
    model.serviceTiers.length === 0
      ? ""
      : ` [serviceTier: ${model.serviceTiers.join("|")}]`;
  return `${model.id}${reasoning}${tiers}${fastMode}`;
}
