import { use, useCallback, useState, type ReactNode } from "react";
import type { SheetJoinPane } from "./side-strip/side-tab-join";

import { JoinPaneContext, PublishJoinContext } from "./sheet-join-context";

/** The bridge follows the latest remaining eligible row or drag overlay. */
export function SheetJoinScope(props: {
  readonly children: ReactNode;
}): ReactNode {
  const [joins, setJoins] = useState<{ owner: symbol; pane: SheetJoinPane }[]>(
    [],
  );
  const publish = useCallback((pane: SheetJoinPane) => {
    const owner = Symbol();
    setJoins((current) => [...current, { owner, pane }]);
    return () => {
      setJoins((current) => current.filter((join) => join.owner !== owner));
    };
  }, []);
  return (
    <PublishJoinContext value={publish}>
      <JoinPaneContext value={joins.at(-1)?.pane ?? null}>
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
