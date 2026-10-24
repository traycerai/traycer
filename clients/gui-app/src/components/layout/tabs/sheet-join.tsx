import {
  use,
  useCallback,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  JoinContext,
  PublishJoinContext,
  type SheetJoin,
} from "./sheet-join-context";
import { useJoinGlowStore } from "./join-glow";
import { useBackdropDimStore } from "@/stores/layout/backdrop-dim-store";

/** The bridge follows the latest remaining eligible row or drag overlay. */
export function SheetJoinScope(props: {
  readonly children: ReactNode;
}): ReactNode {
  const [joins, setJoins] = useState<{ owner: symbol; join: SheetJoin }[]>([]);
  const publish = useCallback((join: SheetJoin) => {
    const owner = Symbol();
    setJoins((current) => [...current, { owner, join }]);
    return () => {
      setJoins((current) => current.filter((entry) => entry.owner !== owner));
    };
  }, []);
  return (
    <PublishJoinContext value={publish}>
      {/* The published object itself, not a copy: it is created once per
          publish, so the value stays referentially stable between renders. */}
      <JoinContext value={joins.at(-1)?.join ?? null}>
        {props.children}
      </JoinContext>
    </PublishJoinContext>
  );
}

/**
 * The joined top tab's share of a modal's dim. In the desktop window a
 * modal's backdrop starts under the title band (`window-chrome.css`), and the
 * joined tab is in that band, so it stayed bright over the page it joins.
 * One layer per open backdrop, in the order they opened, each its backdrop's
 * strength and fading with it, so stacked modals darken the tab as their
 * backdrops darken the page. `window-chrome.css` anchors the layers like the
 * bridge and shows them only in the desktop window.
 */
export function JoinedTabDim(): ReactNode {
  const join = use(JoinContext);
  const backdrops = useBackdropDimStore((state) => state.backdrops);
  if (join === null || backdrops.length === 0) return null;
  return (
    <span aria-hidden data-joined-tab-dim="">
      {backdrops.map((backdrop) => (
        <span
          key={backdrop.id}
          data-dim-layer={backdrop.strength}
          data-state={backdrop.closing ? "closed" : "open"}
        />
      ))}
    </span>
  );
}

export function SheetJoinBridge(props: {
  readonly edge: "top" | "left" | "right";
}): ReactNode {
  const join = use(JoinContext);
  // The reopen glow belongs to the top strip's tab; the bridge wears it too
  // so the tinted outline runs through the concave feet (`join-glow.ts`).
  const glowing = useJoinGlowStore(
    (state) => state.glowing && props.edge === "top",
  );
  return (
    <span
      aria-hidden
      data-sheet-join-bridge={props.edge}
      data-join-active={join !== null ? "" : undefined}
      data-join-pane={join?.pane ?? undefined}
      data-join-glow={glowing ? "" : undefined}
      // `--join-outline` (index.css) colours the bridge's sides and feet; left
      // unset, they fall back to the sheets' border.
      style={{ "--join-outline": join?.outline ?? undefined } as CSSProperties}
    />
  );
}
