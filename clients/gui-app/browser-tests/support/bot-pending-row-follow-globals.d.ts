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
  readonly anchorId: string | null;
  readonly anchorTop: number | null;
}

interface BotPendingRowDriver {
  readonly ready: boolean;
  readonly appendPending: () => void;
  readonly storeBeforeLateRow: () => void;
  readonly probe: () => BotPendingRowProbe;
}

interface Window {
  __pendingDriver?: BotPendingRowDriver;
}
