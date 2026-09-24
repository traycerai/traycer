import { isMobileApp } from "@/lib/mobile-app";
import { flattenStripItemRefs } from "@/stores/tabs/layout";
import { ensureHistoryTab } from "@/lib/commands/actions/open-system-tab";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * On a cold launch of the installed mobile app, move the restored selection
 * off an epic and onto History, so the epic's surface - and with it its epic
 * session, runtime worker and subscriptions - is not started until the user
 * opens it again.
 *
 * WHY THE SELECTION, not the route. `TopLevelTabHost` mounts whatever the tabs
 * store has active, and the phone boots its WebView at `/`, where the
 * navigation controller deliberately leaves a landing location alone rather
 * than clobber the restored focus. So the restored epic mounts under `/` the
 * moment the app shell does - and the shell mounts on AUTH admission, which on
 * a cold launch often lands after the router's first commit (stored tokens
 * validating). A redirect in the `/` route's `beforeLoad` would lose that
 * race: the shell renders the epic one commit before the re-run guard could
 * send it anywhere, and one commit is enough to acquire a session whose worker
 * then stays warm. The tabs store is the one input every renderer of the shell
 * reads, and it hydrates synchronously from localStorage at module evaluation,
 * so changing it before the first render is the only point that wins.
 *
 * WHY HISTORY. It is the phone's task list and the lightest full surface the
 * app has; on the phone it is the routed `/epics` page, which is exactly the
 * History tab this activates. Home is not used even where it is enabled: the
 * setting is account-scoped and not yet readable at bootstrap, and Home reads
 * cross-task streams on mount.
 *
 * EVERY TAB STAYS. The epic keeps its strip item and its canvas record; only
 * the selection moves, so the drawer and the header still reach it and opening
 * it again is an ordinary tab activation.
 *
 * PLAIN STORE ACTIONS, not a coordinator transaction. A transaction normalizes
 * the layout against the source stores, and at bootstrap the account-scoped
 * canvas store has not been retargeted onto this user's bucket yet - a
 * normalization then would read the restored epic refs as unbacked. Opening a
 * system tab and focusing a ref are pure layout edits that consult no source.
 *
 * Call once, from the mobile shell's bootstrap, before the first render. A
 * no-op off the installed app, and when the restored selection holds no epic
 * (a draft, Settings, History itself, Home).
 */
export function deferRestoredEpicOnColdBoot(): void {
  if (!isMobileApp()) return;
  const state = useTabsStore.getState();
  const active = state.items.find((item) => item.id === state.activeItemId);
  if (active === undefined) return;
  if (!flattenStripItemRefs(active).some((ref) => ref.kind === "epic")) return;
  ensureHistoryTab();
  useTabsStore.getState().focusRef({ kind: "history", id: "history" });
}
