import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRetryFailedQueryOnWindowFocus } from "@/hooks/host/use-retry-failed-query-on-window-focus";

interface HookProps {
  readonly enabled: boolean;
  readonly isError: boolean;
}

function focusWindow(): void {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

describe("useRetryFailedQueryOnWindowFocus", () => {
  afterEach(() => {
    cleanup();
  });

  function renderRetry(initial: HookProps) {
    const refetch = vi.fn(() => Promise.resolve(undefined));
    const rendered = renderHook(
      (props: HookProps) =>
        useRetryFailedQueryOnWindowFocus({ ...props, refetch }),
      { initialProps: initial },
    );
    return { refetch, rendered };
  }

  it("refetches once without cancelling a fetch in flight when a failed query's window gains focus", () => {
    const { refetch } = renderRetry({ enabled: true, isError: true });

    expect(document.visibilityState).toBe("visible");
    focusWindow();

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  it("leaves a query that is not in error alone", () => {
    const { refetch } = renderRetry({ enabled: true, isError: false });

    focusWindow();

    expect(refetch).not.toHaveBeenCalled();
  });

  it("leaves a disabled query alone", () => {
    const { refetch } = renderRetry({ enabled: false, isError: true });

    focusWindow();

    expect(refetch).not.toHaveBeenCalled();
  });

  it("reads the latest props at focus time", () => {
    const { refetch, rendered } = renderRetry({
      enabled: true,
      isError: false,
    });

    rendered.rerender({ enabled: true, isError: true });
    focusWindow();
    expect(refetch).toHaveBeenCalledTimes(1);

    rendered.rerender({ enabled: true, isError: false });
    focusWindow();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("stops listening after unmount", () => {
    const { refetch, rendered } = renderRetry({ enabled: true, isError: true });

    rendered.unmount();
    focusWindow();

    expect(refetch).not.toHaveBeenCalled();
  });
});
