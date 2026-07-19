import { Suspense } from "react";
import { TerminalXtermHost } from "@/hooks/agent/use-terminal-tile-bootstrap";
import type { TerminalTileFindKind } from "@/components/epic-canvas/renderers/terminal-tile-find-adapter";

const dropInput = (): void => {};
const ignoreWriter = (): void => {};

/**
 * Measure-before-subscribe probe: mounts the tile's PERSISTENT xterm engine
 * into the final layout box while the tile still shows its loading state, so
 * the container's natural grid is measured with xterm's own cell metrics
 * BEFORE `terminal.create` / `terminal.subscribe` are dispatched. The first
 * fit report flows through `onMeasured` into the bootstrap's
 * `reportMeasuredGrid`, which releases the gated subscribe with the true
 * dimensions - the PTY spawns (and the reattach snapshot is serialized) at
 * the size the pane actually renders, by construction.
 *
 * Nothing is wasted: this is the SAME engine (same `instanceId` in the
 * xterm-host registry) the live host reattaches once the session handle
 * resolves, so the ~150 KB chunk load and `Terminal` construction move
 * EARLIER, overlapping the list query / prepare RPC instead of following
 * them. `effectiveCols/Rows` of 0 keep the resize-sync and host-grid
 * reconcile inert (no session exists yet); input and the writer registration
 * are dropped for the same reason. Render it inside the same
 * relatively-positioned box the live host will occupy - the engine's
 * container is `absolute inset-0`, so any other parent measures the wrong
 * box.
 */
export function TerminalGridMeasureProbe(props: {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly tileKind: TerminalTileFindKind;
  readonly chrome: "padded" | "flush";
  readonly onMeasured: (cols: number, rows: number) => void;
}) {
  return (
    <Suspense fallback={null}>
      <TerminalXtermHost
        sessionId={props.sessionId}
        tileKind={props.tileKind}
        chrome={props.chrome}
        instanceId={props.instanceId}
        effectiveCols={0}
        effectiveRows={0}
        onUserInput={dropInput}
        onContainerResize={props.onMeasured}
        onWriterReady={ignoreWriter}
        shouldFocusOnActivePane={false}
        findTargetId={null}
        // The engine must survive the probe -> live-host swap (that is the
        // point); if the tab closes before a session ever registers, the
        // release path detects the orphan and disposes it.
        keepAlive
      />
    </Suspense>
  );
}
