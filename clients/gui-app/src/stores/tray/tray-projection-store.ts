import { create } from "zustand";
import type {
  TrayEpic,
  TrayIndicatorState,
} from "@traycer-clients/shared/platform/runner-host";

export interface OpenEpicRequest {
  readonly epicId: string;
  readonly requestedAt: number;
}

export interface TrayProjectionState {
  readonly epics: readonly TrayEpic[];
  readonly indicator: TrayIndicatorState;
  readonly openRequest: OpenEpicRequest | null;
  readonly setEpics: (epics: readonly TrayEpic[]) => void;
  readonly setIndicator: (indicator: TrayIndicatorState) => void;
  readonly requestOpenEpic: (epicId: string) => void;
  readonly reset: () => void;
}

export const useTrayProjectionStore = create<TrayProjectionState>((set) => ({
  epics: [],
  indicator: "idle",
  openRequest: null,
  setEpics: (epics) => {
    set((state) => (epicsEqual(state.epics, epics) ? state : { epics }));
  },
  setIndicator: (indicator) => {
    set((state) => (state.indicator === indicator ? state : { indicator }));
  },
  requestOpenEpic: (epicId) => {
    set({ openRequest: { epicId, requestedAt: Date.now() } });
  },
  reset: () => {
    set({ epics: [], indicator: "idle", openRequest: null });
  },
}));

function epicsEqual(a: readonly TrayEpic[], b: readonly TrayEpic[]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.epicId !== right.epicId ||
      left.title !== right.title ||
      left.subtitle !== right.subtitle
    ) {
      return false;
    }
  }
  return true;
}
