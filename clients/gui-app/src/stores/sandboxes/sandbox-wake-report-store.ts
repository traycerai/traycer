import { create } from "zustand";

interface SandboxWakeReportState {
  /**
   * The wake each sandbox's host last answered this device in, by sandbox id:
   * that wake's `lastTransitionAt`. What tells a host that connected and then
   * stopped from one that has not reported yet.
   */
  readonly answeredWakes: Readonly<Record<string, number>>;
  readonly recordAnswer: (sandboxId: string, wake: number) => void;
}

export const useSandboxWakeReportStore = create<SandboxWakeReportState>(
  (set) => ({
    answeredWakes: {},
    recordAnswer: (sandboxId, wake) => {
      set((state) =>
        state.answeredWakes[sandboxId] === wake
          ? state
          : { answeredWakes: { ...state.answeredWakes, [sandboxId]: wake } },
      );
    },
  }),
);
