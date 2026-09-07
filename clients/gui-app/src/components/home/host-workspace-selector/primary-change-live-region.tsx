import type { PrimaryChangeAnnouncement } from "./use-primary-change-announcement";

/** Polite live region for primary-folder changes (explicit "Set as primary" and the deterministic reassignment
 * after removing the current primary). */
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
