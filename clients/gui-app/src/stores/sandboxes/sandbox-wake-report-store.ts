import { create } from "zustand";

interface SandboxWakeReportState {
  /**
   * The wake each sandbox's host last answered this device in, by sandbox id.
   * What tells a host that connected and then stopped from one that has not
   * reported yet.
   */
  readonly answeredWakes: Readonly<Record<string, number>>;
  readonly recordAnswer: (sandboxId: string, wake: number) => void;
  /** Setup lines showing Stop now, by sandbox id: one Stop on screen. */
  readonly setupStops: Readonly<Record<string, number>>;
  /** Holds the sandbox's Stop for a setup line; returns the release. */
  readonly claimSetupStop: (sandboxId: string) => () => void;
}

export const useSandboxWakeReportStore = create<SandboxWakeReportState>(
  (set) => ({
    answeredWakes: {},
    setupStops: {},
    claimSetupStop: (sandboxId) => {
      const move = (by: number): void => {
        set((state) => ({
          setupStops: {
            ...state.setupStops,
            [sandboxId]: (state.setupStops[sandboxId] ?? 0) + by,
          },
        }));
      };
      move(1);
      return () => {
        move(-1);
      };
    },
    recordAnswer: (sandboxId, wake) => {
      set((state) =>
        state.answeredWakes[sandboxId] === wake
          ? state
          : { answeredWakes: { ...state.answeredWakes, [sandboxId]: wake } },
      );
    },
  }),
);
