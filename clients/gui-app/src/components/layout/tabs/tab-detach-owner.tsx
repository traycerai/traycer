/** The whole point is that this component cannot exist without a router: it reaches `useRouterState`, which
 * throws where `useNavigate` only warns. */
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
