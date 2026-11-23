import { v4 as uuidv4 } from "uuid";
import { create } from "zustand";

interface SandboxFailedRowRetry {
  readonly key: string;
  readonly inFlight: boolean;
}

interface SandboxFailedRowRetryState {
  readonly byAccountAndRow: Readonly<
    Partial<Record<string, SandboxFailedRowRetry>>
  >;
  readonly claim: (accountAndRow: string | null) => string | null;
  readonly settle: (
    accountAndRow: string | null,
    requestKey: string,
    clearKey: boolean,
  ) => void;
}

/**
 * An unresolved Retry key belongs to the account and the failed row, so
 * Settings and a chat can resume the same create after a remount or sign-in.
 * This store is per window (renderer); not shared across windows or
 * persisted across a restart.
 */
export const useSandboxFailedRowRetryStore = create<SandboxFailedRowRetryState>()(
  (set, get) => ({
    byAccountAndRow: {},
    claim: (accountAndRow) => {
      if (accountAndRow === null) return uuidv4();
      const existing = get().byAccountAndRow[accountAndRow];
      if (existing?.inFlight === true) return null;
      const requestKey = existing?.key ?? uuidv4();
      set((state) => ({
        byAccountAndRow: {
          ...state.byAccountAndRow,
          [accountAndRow]: { key: requestKey, inFlight: true },
        },
      }));
      return requestKey;
    },
    settle: (accountAndRow, requestKey, clearKey) => {
      if (accountAndRow === null) return;
      set((state) => {
        if (state.byAccountAndRow[accountAndRow]?.key !== requestKey)
          return state;
        const next = { ...state.byAccountAndRow };
        if (clearKey) delete next[accountAndRow];
        else next[accountAndRow] = { key: requestKey, inFlight: false };
        return { byAccountAndRow: next };
      });
    },
  }),
);
