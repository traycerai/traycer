import { v4 as uuidv4 } from "uuid";
import { create } from "zustand";

interface SandboxFailedRowRetryState {
  readonly byAccountAndRow: Readonly<Partial<Record<string, string>>>;
  readonly getOrCreate: (accountAndRow: string | null) => string;
  readonly clear: (accountAndRow: string | null, requestKey: string) => void;
}

/**
 * An unresolved Retry key belongs to the account and the failed row, so
 * Settings and a chat can resume the same create after a remount or sign-in.
 * Keys live in memory for this app session and are lost on restart.
 */
export const useSandboxFailedRowRetryStore = create<SandboxFailedRowRetryState>()(
  (set, get) => ({
    byAccountAndRow: {},
    getOrCreate: (accountAndRow) => {
      if (accountAndRow === null) return uuidv4();
      const existing = get().byAccountAndRow[accountAndRow];
      if (existing !== undefined) return existing;
      const requestKey = uuidv4();
      set((state) => ({
        byAccountAndRow: {
          ...state.byAccountAndRow,
          [accountAndRow]: requestKey,
        },
      }));
      return requestKey;
    },
    clear: (accountAndRow, requestKey) => {
      if (accountAndRow === null) return;
      set((state) => {
        if (state.byAccountAndRow[accountAndRow] !== requestKey) return state;
        const next = { ...state.byAccountAndRow };
        delete next[accountAndRow];
        return { byAccountAndRow: next };
      });
    },
  }),
);
