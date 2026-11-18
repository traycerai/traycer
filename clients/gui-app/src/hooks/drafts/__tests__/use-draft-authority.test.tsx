import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDraftAuthorityControl } from "@/hooks/drafts/use-draft-authority";

/**
 * The fork rule, surface-agnostic: `noteEdit` forks iff `isForeign()` reads
 * true AT THE CALL, and is otherwise a no-op. Surface-specific derivations
 * of `isForeign` (chat composer, landing) are covered by their own hooks'
 * tests.
 */
describe("useDraftAuthorityControl: fork rule", () => {
  it("does not fork when isForeign() is false", () => {
    const isForeign = vi.fn(() => false);
    const fork = vi.fn();
    const view = renderHook(() =>
      useDraftAuthorityControl({ isForeign, fork }),
    );

    act(() => {
      view.result.current.noteEdit();
    });

    expect(isForeign).toHaveBeenCalledTimes(1);
    expect(fork).not.toHaveBeenCalled();
  });

  it("forks when isForeign() is true", () => {
    const isForeign = vi.fn(() => true);
    const fork = vi.fn();
    const view = renderHook(() =>
      useDraftAuthorityControl({ isForeign, fork }),
    );

    act(() => {
      view.result.current.noteEdit();
    });

    expect(fork).toHaveBeenCalledTimes(1);
  });

  it("forks exactly once per edit", () => {
    const isForeign = vi.fn(() => true);
    const fork = vi.fn();
    const view = renderHook(() =>
      useDraftAuthorityControl({ isForeign, fork }),
    );

    act(() => {
      view.result.current.noteEdit();
    });
    expect(fork).toHaveBeenCalledTimes(1);

    act(() => {
      view.result.current.noteEdit();
    });
    expect(fork).toHaveBeenCalledTimes(2);
  });

  it("reads isForeign at the call, not a value captured at the last render", () => {
    let foreign = false;
    const isForeign = vi.fn(() => foreign);
    const fork = vi.fn();
    const view = renderHook(() =>
      useDraftAuthorityControl({ isForeign, fork }),
    );

    act(() => {
      view.result.current.noteEdit();
    });
    expect(fork).not.toHaveBeenCalled();

    // Flip the row's foreignness (an echo, a placement move) without a
    // re-render: the SAME `noteEdit` closure must observe the new value.
    foreign = true;

    act(() => {
      view.result.current.noteEdit();
    });
    expect(fork).toHaveBeenCalledTimes(1);
  });
});
