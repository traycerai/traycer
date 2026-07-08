export interface LowerScrollBudgetInput {
  readonly pinnedStackVisible: boolean;
  readonly queueVisible: boolean;
  readonly backgroundVisible: boolean;
  readonly activeAgentsVisible: boolean;
  readonly approvalVisible: boolean;
}

export function lowerScrollRegionMaxHeightClass(
  input: LowerScrollBudgetInput,
): string {
  const scrollRegions =
    Number(input.pinnedStackVisible) +
    Number(input.queueVisible) +
    Number(input.backgroundVisible) +
    Number(input.activeAgentsVisible);
  const pressure = scrollRegions + Number(input.approvalVisible);

  if (pressure >= 3) {
    return "max-h-[min(18dvh,11rem)]";
  }
  if (pressure >= 2) {
    return "max-h-[min(24dvh,14rem)]";
  }
  if (scrollRegions === 1) {
    return "max-h-[min(40dvh,24rem)]";
  }
  return "max-h-[min(40dvh,24rem)]";
}
