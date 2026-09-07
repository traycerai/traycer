/** Recurrence-guard state for the Host Doctor card. */
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
