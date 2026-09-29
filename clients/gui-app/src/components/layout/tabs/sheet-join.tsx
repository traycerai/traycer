import { use, useCallback, useState, type ReactNode } from "react";
import type { SheetJoinPane } from "./side-strip/side-tab-join";

import { JoinPaneContext, PublishJoinContext } from "./sheet-join-context";
import { useJoinGlowStore } from "./join-glow";

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
  // The reopen glow belongs to the top strip's tab; the bridge wears it too
  // so the tinted outline runs through the concave feet (`join-glow.ts`).
  const glowing = useJoinGlowStore(
    (state) => state.glowing && props.edge === "top",
  );
  return (
    <span
      aria-hidden
      data-sheet-join-bridge={props.edge}
      data-join-active={pane !== null ? "" : undefined}
      data-join-pane={pane ?? undefined}
      data-join-glow={glowing ? "" : undefined}
    />
  );
}
