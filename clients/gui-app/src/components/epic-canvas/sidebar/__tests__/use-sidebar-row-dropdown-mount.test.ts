import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSidebarRowDropdownMount } from "../use-sidebar-row-dropdown-mount";

describe("useSidebarRowDropdownMount", () => {
  afterEach(cleanup);

  it("closes when disabled while open and stays closed after re-enabling", () => {
    const { result, rerender } = renderHook(
      (props: { readonly disabled: boolean }) =>
        useSidebarRowDropdownMount(props.disabled),
      { initialProps: { disabled: false } },
    );

    act(() => {
      result.current.onClick();
    });
    expect(result.current.open).toBe(true);
    expect(result.current.mounted).toBe(true);

    rerender({ disabled: true });
    expect(result.current.open).toBe(false);

    rerender({ disabled: false });
    expect(result.current.open).toBe(false);
    expect(result.current.mounted).toBe(true);
  });

  it("omits triggerIdProps.id after mount so Radix's trigger id wins", () => {
    const { result } = renderHook(
      (props: { readonly disabled: boolean }) =>
        useSidebarRowDropdownMount(props.disabled),
      { initialProps: { disabled: false } },
    );

    expect("id" in result.current.triggerIdProps).toBe(true);
    if (!("id" in result.current.triggerIdProps)) {
      throw new Error("expected triggerIdProps.id before mount");
    }
    expect(typeof result.current.triggerIdProps.id).toBe("string");

    act(() => {
      result.current.onClick();
    });
    expect(result.current.triggerIdProps).toEqual({});
    expect("id" in result.current.triggerIdProps).toBe(false);
  });

  it("keeps an open menu open across a rerender while enabled", () => {
    const { result, rerender } = renderHook(
      (props: { readonly disabled: boolean }) =>
        useSidebarRowDropdownMount(props.disabled),
      { initialProps: { disabled: false } },
    );

    act(() => {
      result.current.onClick();
    });
    expect(result.current.open).toBe(true);

    rerender({ disabled: false });
    expect(result.current.open).toBe(true);
  });
});
