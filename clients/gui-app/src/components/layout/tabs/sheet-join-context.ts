import { createContext, use, useLayoutEffect } from "react";
import type { SheetJoinPane } from "./side-strip/side-tab-join";

type PublishJoin = (pane: SheetJoinPane) => () => void;
export const PublishJoinContext = createContext<PublishJoin | null>(null);
export const JoinPaneContext = createContext<SheetJoinPane | null>(null);

export function usePublishSheetJoin(pane: SheetJoinPane | null): void {
  const publish = use(PublishJoinContext);
  useLayoutEffect(() => {
    if (pane === null || publish === null) return;
    return publish(pane);
  }, [pane, publish]);
}
