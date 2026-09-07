import type { AccountContext } from "@traycer/protocol/common/schemas";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/** Global, persisted "whose subscription am I looking at" selector. */
export type { AccountContext } from "@traycer/protocol/common/schemas";

const ACCOUNT_CONTEXT_PERSIST_KEY = "traycer-gui-app:account-context:v1";

interface AccountContextStoreState {
  readonly accountContext: AccountContext;
  readonly setAccountContext: (context: AccountContext) => void;
}

function accountContextsEqual(a: AccountContext, b: AccountContext): boolean {
  if (a.type !== b.type) return false;
  return a.type === "TEAM" && b.type === "TEAM" ? a.teamId === b.teamId : true;
}

export const useAccountContextStore = create<AccountContextStoreState>()(
  persist(
    (set, get) => ({
      accountContext: { type: "PERSONAL" },
      setAccountContext: (accountContext) => {
        if (accountContextsEqual(get().accountContext, accountContext)) return;
        Analytics.getInstance().track(AnalyticsEvent.AccountContextChanged, {
          context: accountContext.type === "TEAM" ? "team" : "personal",
        });
        set({ accountContext });
      },
    }),
    {
      name: ACCOUNT_CONTEXT_PERSIST_KEY,
      storage: createJSONStorage(() => localStorage),
      // Persist only the selection; actions come from the initializer on rehydrate.
      partialize: (state) => ({ accountContext: state.accountContext }),
    },
  ),
);

/** Resolves a (possibly stale) stored context against the teams currently on the authed user. */
export function resolveAccountContext(
  stored: AccountContext,
  availableTeamIds: ReadonlySet<string>,
): AccountContext {
  if (stored.type === "TEAM" && !availableTeamIds.has(stored.teamId)) {
    return { type: "PERSONAL" };
  }
  return stored;
}
