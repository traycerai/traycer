import type { PrimaryChangeAnnouncement } from "./use-primary-change-announcement";

/**
 * Polite live region for primary-folder changes (explicit "Set as primary"
 * and the deterministic reassignment after removing the current primary).
 * The inner span is keyed by `seq`, so every announcement - including one
 * whose text is byte-identical to the previous - remounts the text node,
 * which is the DOM mutation screen readers need to re-announce. The state
 * side lives in `use-primary-change-announcement.ts`.
 */
export function PrimaryChangeLiveRegion(props: {
  readonly announcement: PrimaryChangeAnnouncement | null;
}) {
  return (
    <span
      className="sr-only"
      role="status"
      aria-live="polite"
      data-testid="primary-change-live-region"
    >
      {props.announcement === null ? null : (
        <span key={props.announcement.seq}>{props.announcement.message}</span>
      )}
    </span>
  );
}
