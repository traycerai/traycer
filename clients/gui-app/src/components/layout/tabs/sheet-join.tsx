import { use, useCallback, useState, type ReactNode } from "react";
import type { SheetJoinPane } from "./side-strip/side-tab-join";

import { JoinPaneContext, PublishJoinContext } from "./sheet-join-context";

/** The strip owns one bridge; the eligible row publishes its already-known join. */
export function SheetJoinScope(props: {
  readonly children: ReactNode;
}): ReactNode {
  const [join, setJoin] = useState<{
    owner: symbol;
    pane: SheetJoinPane;
  } | null>(null);
  const publish = useCallback((pane: SheetJoinPane) => {
    const owner = Symbol();
    setJoin({ owner, pane });
    return () => {
      setJoin((current) => (current?.owner === owner ? null : current));
    };
  }, []);
  return (
    <PublishJoinContext value={publish}>
      <JoinPaneContext value={join?.pane ?? null}>
        {props.children}
      </JoinPaneContext>
    </PublishJoinContext>
  );
}

export function SheetJoinBridge(props: {
  readonly edge: "top" | "left" | "right";
}): ReactNode {
  const pane = use(JoinPaneContext);
  return (
    <span
      aria-hidden
      data-sheet-join-bridge={props.edge}
      data-join-active={pane !== null ? "" : undefined}
      data-join-pane={pane ?? undefined}
    />
  );
}
