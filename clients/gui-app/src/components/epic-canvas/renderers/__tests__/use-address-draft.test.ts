import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAddressDraft } from "@/components/epic-canvas/renderers/use-address-draft";

const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";
const TYPED = "https://typed.example/path";

afterEach(() => {
  cleanup();
});

describe("useAddressDraft", () => {
  it("shows the live url until the field is touched", () => {
    const { result, rerender } = renderHook(
      (liveUrl: string) => useAddressDraft(liveUrl),
      { initialProps: URL_A },
    );
    expect(result.current.addressValue).toBe(URL_A);
    rerender(URL_B);
    expect(result.current.addressValue).toBe(URL_B);
  });

  it("keeps a focused draft across a navigation and restores it on blur", () => {
    const { result, rerender } = renderHook(
      (liveUrl: string) => useAddressDraft(liveUrl),
      { initialProps: URL_A },
    );

    act(() => {
      result.current.onAddressFocusChange(true);
    });
    expect(result.current.addressValue).toBe(URL_A);

    act(() => {
      result.current.onAddressChange(TYPED);
    });
    rerender(URL_B);
    expect(result.current.addressValue).toBe(TYPED);

    act(() => {
      result.current.onAddressFocusChange(false);
    });
    expect(result.current.addressValue).toBe(URL_B);
  });

  it("holds a submitted draft until the next navigation lands", () => {
    const { result, rerender } = renderHook(
      (liveUrl: string) => useAddressDraft(liveUrl),
      { initialProps: URL_A },
    );

    act(() => {
      result.current.onAddressSubmitted(TYPED);
    });
    expect(result.current.addressValue).toBe(TYPED);

    // The redirect the submit landed on wins, not what was typed.
    rerender(URL_B);
    expect(result.current.addressValue).toBe(URL_B);
  });

  it("drops the draft when the field is left", () => {
    const { result } = renderHook(
      (liveUrl: string) => useAddressDraft(liveUrl),
      {
        initialProps: URL_A,
      },
    );

    act(() => {
      result.current.onAddressSubmitted(TYPED);
      result.current.onAddressFocusChange(false);
    });
    expect(result.current.addressValue).toBe(URL_A);
  });
});
