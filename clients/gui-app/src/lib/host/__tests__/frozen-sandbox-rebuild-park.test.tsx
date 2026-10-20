import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_VERDICT_TTL_MS } from "@/lib/host/host-messenger";
import { useFrozenSandboxRebuildPark } from "@/lib/host/frozen-sandbox-rebuild-park";

type Freeze = "frozen" | "thawed" | "gone";

interface HookProps {
  readonly freeze: Freeze;
}

function renderPark(freeze: Freeze) {
  return renderHook(
    (props: HookProps) => useFrozenSandboxRebuildPark(props.freeze),
    { initialProps: { freeze } },
  );
}

describe("useFrozenSandboxRebuildPark", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not park for any close other than SANDBOX_FROZEN", () => {
    const { result } = renderPark("frozen");

    let other = true;
    let none = true;
    act(() => {
      other = result.current.parkIfFrozen("SOME_OTHER_CODE");
      none = result.current.parkIfFrozen(null);
    });

    expect(other).toBe(false);
    expect(none).toBe(false);
    expect(result.current.releases).toBe(0);
  });

  it("releases once when a confirmed park sees the sandbox thaw", () => {
    const { result, rerender } = renderPark("frozen");

    let parked = false;
    act(() => {
      parked = result.current.parkIfFrozen("SANDBOX_FROZEN");
    });
    expect(parked).toBe(true);
    expect(result.current.releases).toBe(0);

    rerender({ freeze: "frozen" });
    expect(result.current.releases).toBe(0);

    rerender({ freeze: "thawed" });
    expect(result.current.releases).toBe(1);

    rerender({ freeze: "thawed" });
    expect(result.current.releases).toBe(1);
  });

  it("releases once when a confirmed park sees the row gone", () => {
    const { result, rerender } = renderPark("frozen");

    let parked = false;
    act(() => {
      parked = result.current.parkIfFrozen("SANDBOX_FROZEN");
    });
    expect(parked).toBe(true);
    expect(result.current.releases).toBe(0);

    rerender({ freeze: "frozen" });
    expect(result.current.releases).toBe(0);

    rerender({ freeze: "gone" });
    expect(result.current.releases).toBe(1);

    rerender({ freeze: "gone" });
    expect(result.current.releases).toBe(1);
  });

  it("does not release an unconfirmed park on a stale thawed row until the TTL", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderPark("thawed");

    let parked = false;
    act(() => {
      parked = result.current.parkIfFrozen("SANDBOX_FROZEN");
    });
    expect(parked).toBe(true);

    rerender({ freeze: "thawed" });
    expect(result.current.releases).toBe(0);

    act(() => {
      vi.advanceTimersByTime(TERMINAL_VERDICT_TTL_MS - 1);
    });
    expect(result.current.releases).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.releases).toBe(1);
  });

  it("stops the TTL timer once the list confirms the park, then releases on thaw", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderPark("thawed");

    let parked = false;
    act(() => {
      parked = result.current.parkIfFrozen("SANDBOX_FROZEN");
    });
    expect(parked).toBe(true);

    rerender({ freeze: "frozen" });
    expect(result.current.releases).toBe(0);

    act(() => {
      vi.advanceTimersByTime(TERMINAL_VERDICT_TTL_MS);
    });
    expect(result.current.releases).toBe(0);

    rerender({ freeze: "thawed" });
    expect(result.current.releases).toBe(1);
  });
});
