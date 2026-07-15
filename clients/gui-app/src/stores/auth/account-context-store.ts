import type { AccountContext } from "@traycer/protocol/common/schemas";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * Global, persisted "whose subscription am I looking at" selector. Mirrors the
 * `AccountContext` pattern from the VS Code extension (PERSONAL / ORG / TEAM),
 * minus ORG - this app only exposes the signed-in user and the teams they
 * belong to (`teamSubscriptions`). Drives which subscription the Settings →
 * Providers → Traycer panel shows AND, stamped onto `chatRunSettings`, which
 * account a Traycer run bills.
 *
 * The shape is the canonical `AccountContext` from `@traycer/protocol`, so the
 * UI selector and the run-billing wire field can never drift.
 */
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

/**
 * Resolves a (possibly stale) stored context against the teams currently on the
 * authed user. Falls back to Personal when the persisted team is gone - the
 * brief's default - so a left team never leaves the panel pointing at nothing.
 */
export function resolveAccountContext(
  stored: AccountContext,
  availableTeamIds: ReadonlySet<string>,
): AccountContext {
  if (stored.type === "TEAM" && !availableTeamIds.has(stored.teamId)) {
    return { type: "PERSONAL" };
  }
  return stored;
}
