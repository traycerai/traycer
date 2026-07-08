export type FormattableHarnessSummary = {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly availabilityPending: boolean;
  readonly error: string | null;
};

export type FormattableListHarnessesResponse = {
  readonly harnesses: readonly FormattableHarnessSummary[];
};

export function formatListHarnessesResponse(
  response: FormattableListHarnessesResponse,
): string {
  if (response.harnesses.length === 0) {
    return "No enabled harnesses found.";
  }
  return `Each line is: harness-id - label [status]

${response.harnesses.map(formatHarnessSummary).join("\n")}`;
}

function formatHarnessSummary(harness: FormattableHarnessSummary): string {
  const status = harness.availabilityPending
    ? " [pending]"
    : harness.available
      ? ""
      : ` [unavailable${harness.error === null ? "" : `: ${harness.error}`}]`;
  return `${harness.id} - ${harness.label}${status}`;
}
