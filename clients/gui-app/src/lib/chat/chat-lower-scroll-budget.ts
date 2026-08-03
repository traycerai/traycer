/**
 * Whether the dock's Background section has anything to show. It lives here
 * rather than in the dock because the answer sizes the scroll region below and
 * the composer's top spacing too: the dock's frame is drawn flush against what
 * follows it, so a surface that disagrees leaves an open-bottomed box.
 *
 * Managed commands count even when the harness session reports no background
 * work of its own - they reach the section by a client-side join on the epic's
 * command list.
 */
export function chatBackgroundSectionVisible(input: {
  readonly backgroundItemCount: number;
  readonly runningManagedCommandCount: number;
}): boolean {
  return input.backgroundItemCount > 0 || input.runningManagedCommandCount > 0;
}

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
