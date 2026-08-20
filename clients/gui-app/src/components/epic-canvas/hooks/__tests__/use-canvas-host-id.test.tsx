import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * THE CANVAS FOLLOWS ITS EPIC, NOT ITS WINDOW.
 *
 * `useCanvasHostId` used to be `useEffectiveHostId()` outright, on the
 * reasoning that the canvas follows the window. That is true of the WINDOW and
 * false of the canvas the moment the two disagree - which they do for a bounded
 * but entirely reachable window: `EpicSessionProvider` keeps the previous
 * handle registered and RENDERED while its replacement establishes and after
 * one fails, and `epic-shell.tsx` makes only the tile subtree inert for it.
 *
 * Its consumers were therefore mixing host A's projected Epic data with B-bound
 * operations - the PR panel subscribing on B with A's Epic context, and
 * same-Epic Markdown references stamping nodes projected from A with B's host
 * id, a binding an opened tile then carries for life.
 *
 * Tested at the HOOK rather than through one consumer, because the fix is the
 * hook: every caller asks the same question, so correcting them one at a time
 * would leave the next one to be written wrong again.
 */
interface CanvasHostFixture {
  session: string | null;
  effective: string | null;
}

// Typed through `vi.hoisted`'s parameter rather than with an inline assertion:
// eslint's `--fix` strips an assertion it reads as redundant on the literal,
// and the `null` cases below then fail to compile.
const hosts = vi.hoisted<CanvasHostFixture>(() => ({
  session: "host-session",
  effective: "host-effective",
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => hosts.session,
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => hosts.effective,
}));

import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";

describe("useCanvasHostId", () => {
  it("answers the Epic session's host while it differs from the effective one", () => {
    hosts.session = "host-session";
    hosts.effective = "host-effective";

    const { result } = renderHook(() => useCanvasHostId());

    expect(result.current).toBe("host-session");
  });

  it("falls back to the effective host where there is no Epic session", () => {
    // NOT a fail-open. `useEpicSessionHostId` reads a context, so `null` means
    // "no surrounding session" - a Markdown reference rendered outside a
    // canvas, say - and there the effective host is the only answer there has
    // ever been. Inside a session this arm is unreachable: the handle carries a
    // construction host stamp or the provider throws.
    hosts.session = null;
    hosts.effective = "host-effective";

    const { result } = renderHook(() => useCanvasHostId());

    expect(result.current).toBe("host-effective");
  });
});
