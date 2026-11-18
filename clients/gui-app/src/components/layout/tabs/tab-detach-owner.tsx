/**
 * Owns the tear-off "open in new window" flow and publishes it for
 * `RootDndProvider` to use at drag end.
 *
 * MOUNT THIS IN THE ROUTE TREE, never inside `RootDndProvider` or `AppShell`.
 * The whole point is that this component cannot exist without a router: it
 * reaches `useRouterState`, which throws where `useNavigate` only warns. Placing
 * it under a route component means the router requirement is satisfied by
 * WHERE it renders rather than by a runtime check - and a component rendered by
 * the provider would mount wherever the provider mounts, which is exactly the
 * provider-light case the move exists to fix.
 *
 * It also renders the confirmation dialog, because the instance that initiates
 * a move must be the instance that renders its dialog: `useEpicOpenInNewWindowFlow`
 * holds real state (`pendingMove`, `queuedMove`), so a second instance rendering
 * the dialog would be watching state the first one owns.
 */
import { useEffect } from "react";
import { UnsyncedEpicMoveDialog } from "@/components/layout/dialogs/unsynced-epic-move-dialog";
import { publishTabDetachHandler } from "@/components/layout/tabs/tab-detach-channel";
import { useTabOpenInNewWindowFlow } from "@/components/layout/tabs/use-tab-open-in-new-window";

export function TabDetachOwner() {
  const flow = useTabOpenInNewWindowFlow();
  const { isAvailable, requestOpen } = flow;

  useEffect(
    () => publishTabDetachHandler({ isAvailable, requestOpen }),
    [isAvailable, requestOpen],
  );

  return <UnsyncedEpicMoveDialog flow={flow.epicFlow} />;
}
