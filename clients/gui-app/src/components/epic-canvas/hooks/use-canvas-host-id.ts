import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";

/**
 * The host currently serving the canvas: the Epic SESSION's host, falling back
 * to the window's effective host where there is no session.
 *
 * This used to be `useEffectiveHostId()` outright, on the reasoning that the
 * canvas "follows the window" - true of the WINDOW, and false of the canvas the
 * moment the two disagree. `EpicSessionProvider` keeps the previous handle
 * registered and RENDERED while its replacement establishes and after one
 * fails, and `epic-shell.tsx` makes only the tile subtree inert for that
 * window. So consumers were mixing host A's projected Epic data with B-bound
 * operations: the PR panel subscribing on B with A's Epic context, and
 * same-Epic Markdown references stamping nodes projected from A with B's host
 * id - a binding a tile then carries for life.
 *
 * ONE HOOK RATHER THAN ONE FIX PER CONSUMER, deliberately. Every caller of this
 * hook wants the same thing ("which machine is this canvas's Epic on"), so the
 * answer belongs here; correcting the call sites individually would leave the
 * next one to be written wrong again, and the reviewer to find it.
 *
 * The fallback is NOT a fail-open. `useEpicSessionHostId()` reads a context, so
 * `null` means "no surrounding Epic session" - a Markdown reference rendered
 * outside a canvas, say - and there the effective host is the only answer there
 * has ever been and remains correct. Inside a session the fallback is
 * unreachable: the handle carries a construction host stamp or the provider
 * throws.
 *
 * Not `useTabHostId()`: that is a per-TILE binding, and this hook answers for
 * surfaces that sit above the tiles (the sidebar rail, the PR panel, the status
 * row). A tile that needs its own host still uses `useTabHostId()`.
 */
export function useCanvasHostId(): string | null {
  const sessionHostId = useEpicSessionHostId();
  const effectiveHostId = useEffectiveHostId();
  return sessionHostId ?? effectiveHostId;
}
