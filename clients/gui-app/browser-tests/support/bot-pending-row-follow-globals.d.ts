/**
 * The page-side driver of `src/__tests__/browser/bot-pending-row-follow.tsx`,
 * read by `bot-pending-row-follow.spec.ts`.
 */
interface BotPendingRowProbe {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly distance: number;
  readonly rowsWithPendingText: number;
  readonly pendingTop: number | null;
  readonly pendingHeight: number | null;
  readonly pendingInView: boolean;
  readonly bodiesHeld: number;
  readonly rowsHanded: number;
  readonly teammateRows: number;
  readonly pendingIsLastRow: boolean;
  readonly rangeRequests: number;
  readonly anchorId: string | null;
  readonly anchorTop: number | null;
}

interface BotPendingRowDriver {
  readonly ready: boolean;
  readonly press: () => void;
  readonly indexNamesPending: () => void;
  readonly indexNamesTeammate: () => void;
  readonly answerRange: () => boolean;
  readonly probe: () => BotPendingRowProbe;
}

interface Window {
  __pendingDriver?: BotPendingRowDriver;
}
