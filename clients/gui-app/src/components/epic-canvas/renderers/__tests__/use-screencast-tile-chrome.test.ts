import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SyntheticEvent } from "react";
import type { BrowserNavState } from "@traycer/protocol/host/browser/contracts";
import {
  useScreencastTileChrome,
  type ScreencastTileChrome,
} from "@/components/epic-canvas/renderers/use-screencast-tile-chrome";

const INITIAL_URL = "http://localhost:3000";
const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";
const DRAFT_URL = "https://draft.example/path";
const SUBMITTED_URL = "https://submitted.example/";

interface ChromeHookProps {
  readonly navState: BrowserNavState;
  readonly initialUrl: string;
}

interface ChromeHookView {
  readonly result: { readonly current: ScreencastTileChrome };
  readonly rerender: (props: ChromeHookProps) => void;
  readonly onNavigateUrl: Mock;
  readonly onBack: Mock;
  readonly onForward: Mock;
  readonly onReload: Mock;
}

function idleNav(url: string): BrowserNavState {
  return {
    url,
    canGoBack: false,
    canGoForward: false,
    loading: false,
  };
}

function renderChrome(
  navState: BrowserNavState,
  initialUrl: string,
): ChromeHookView {
  const onNavigateUrl = vi.fn();
  const onBack = vi.fn();
  const onForward = vi.fn();
  const onReload = vi.fn();
  const view = renderHook(
    (props: ChromeHookProps) =>
      useScreencastTileChrome({
        navState: props.navState,
        initialUrl: props.initialUrl,
        disabled: false,
        onNavigateUrl,
        onBack,
        onForward,
        onReload,
      }),
    { initialProps: { navState, initialUrl } },
  );
  return { ...view, onNavigateUrl, onBack, onForward, onReload };
}

function submitEvent(): SyntheticEvent<HTMLFormElement, SubmitEvent> {
  return {
    preventDefault: () => undefined,
  } as SyntheticEvent<HTMLFormElement, SubmitEvent>;
}

afterEach(() => {
  cleanup();
});

describe("useScreencastTileChrome", () => {
  it("mirrors navState history flags and no-ops disabled back/forward", () => {
    const { result, rerender, onBack, onForward } = renderChrome(
      {
        url: URL_A,
        canGoBack: false,
        canGoForward: false,
        loading: false,
      },
      INITIAL_URL,
    );

    expect(result.current.controller.canGoBack).toBe(false);
    expect(result.current.controller.canGoForward).toBe(false);

    act(() => {
      result.current.controller.onBack();
      result.current.controller.onForward();
    });
    expect(onBack).not.toHaveBeenCalled();
    expect(onForward).not.toHaveBeenCalled();

    rerender({
      navState: {
        url: URL_A,
        canGoBack: true,
        canGoForward: false,
        loading: false,
      },
      initialUrl: INITIAL_URL,
    });
    expect(result.current.controller.canGoBack).toBe(true);
    expect(result.current.controller.canGoForward).toBe(false);
    act(() => {
      result.current.controller.onBack();
      result.current.controller.onForward();
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onForward).not.toHaveBeenCalled();

    rerender({
      navState: {
        url: URL_A,
        canGoBack: false,
        canGoForward: true,
        loading: false,
      },
      initialUrl: INITIAL_URL,
    });
    expect(result.current.controller.canGoBack).toBe(false);
    expect(result.current.controller.canGoForward).toBe(true);
    act(() => {
      result.current.controller.onBack();
      result.current.controller.onForward();
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onForward).toHaveBeenCalledTimes(1);
  });

  it("keeps the focused address draft across a live url change and restores on blur", () => {
    const { result, rerender } = renderChrome(idleNav(URL_A), INITIAL_URL);

    expect(result.current.controller.addressValue).toBe(URL_A);

    act(() => {
      result.current.onAddressFocusChange(true);
    });
    expect(result.current.controller.addressValue).toBe(URL_A);

    act(() => {
      result.current.controller.onAddressChange(DRAFT_URL);
    });
    expect(result.current.controller.addressValue).toBe(DRAFT_URL);

    rerender({ navState: idleNav(URL_B), initialUrl: INITIAL_URL });
    expect(result.current.controller.url).toBe(URL_B);
    expect(result.current.controller.addressValue).toBe(DRAFT_URL);

    act(() => {
      result.current.onAddressFocusChange(false);
    });
    expect(result.current.controller.addressValue).toBe(URL_B);
  });

  it("yields a submitted draft to the next navState", () => {
    const { result, rerender, onNavigateUrl } = renderChrome(
      idleNav(URL_A),
      INITIAL_URL,
    );

    act(() => {
      result.current.onAddressFocusChange(true);
      result.current.controller.onAddressChange(SUBMITTED_URL);
    });
    act(() => {
      result.current.controller.onNavigate(submitEvent());
    });
    expect(onNavigateUrl).toHaveBeenCalledWith(SUBMITTED_URL);
    expect(result.current.controller.addressValue).toBe(SUBMITTED_URL);

    rerender({ navState: idleNav(URL_B), initialUrl: INITIAL_URL });
    expect(result.current.controller.url).toBe(URL_B);
    expect(result.current.controller.addressValue).toBe(URL_B);
  });

  it("exposes nav-only chrome capabilities", () => {
    const { result } = renderChrome(idleNav(URL_A), INITIAL_URL);

    expect(result.current.controller.capabilities).toEqual({
      navigate: true,
      back: true,
      forward: true,
      reload: true,
      zoom: false,
      viewportPreset: false,
      devtools: false,
      find: false,
      siteInfo: false,
      annotate: false,
    });
  });

  it("falls back to initialUrl when navState.url is empty", () => {
    const { result } = renderChrome(idleNav(""), INITIAL_URL);

    expect(result.current.controller.url).toBe(INITIAL_URL);
    expect(result.current.controller.addressValue).toBe(INITIAL_URL);
  });
});
