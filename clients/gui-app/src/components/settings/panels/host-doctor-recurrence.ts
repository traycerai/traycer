/**
 * Recurrence-guard state for the Host Doctor card. Exported as its own
 * module (separate from `host-doctor-card.tsx`) so a parent component
 * - e.g. the Settings → Host panel's `DoctorSheet`, which conditionally
 * mounts the card - can persist this state across the card's mount
 * lifecycle and pass it back in via props.
 *
 * Living in its own file keeps the doctor card module pure-component
 * exports, which keeps Vite's React Fast Refresh boundary intact.
 */
export interface RecurrenceState {
  readonly failures: ReadonlyArray<{
    readonly at: number;
    readonly code: string;
  }>;
  readonly locked: boolean;
}

export const INITIAL_RECURRENCE_STATE: RecurrenceState = {
  failures: [],
  locked: false,
};
