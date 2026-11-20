export type FormattableHarnessModelSummary = {
  readonly id: string;
  readonly resolvedModel: string | null;
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
  const legend = `Each line is: model-name [resolvesTo: id] [reasoningEffort: values] [serviceTier: ids] [fastMode]
reasoningEffort, serviceTier and fastMode are optional create params. They are valid only when shown for the selected model. An explicit serviceTier takes precedence over fastMode.
Pass model-name as the model. resolvesTo is the id reported by the provider catalogue for that name; it can change, may come from a retained catalogue, and is shown only when it differs.`;
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
  const resolved =
    model.resolvedModel === null || model.resolvedModel === model.id
      ? ""
      : ` [resolvesTo: ${model.resolvedModel}]`;
  const reasoning =
    model.reasoningEfforts.length === 0
      ? ""
      : ` [reasoningEffort: ${model.reasoningEfforts.join("|")}]`;
  const fastMode = model.fastModeAvailable ? " [fastMode]" : "";
  const tiers =
    model.serviceTiers.length === 0
      ? ""
      : ` [serviceTier: ${model.serviceTiers.join("|")}]`;
  return `${model.id}${resolved}${reasoning}${tiers}${fastMode}`;
}
