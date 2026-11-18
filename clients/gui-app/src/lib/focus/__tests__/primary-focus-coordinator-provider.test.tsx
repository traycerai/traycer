import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerPrimaryFocusEndpoint,
  requestPrimaryFocus,
  resetPrimaryFocusCoordinatorForTests,
  type PrimaryFocusTarget,
} from "../primary-focus-coordinator";
import { PrimaryFocusCoordinatorProvider } from "../primary-focus-coordinator-provider";

const focus = vi.fn();

function HandoffProbe(props: {
  readonly target: PrimaryFocusTarget;
}): ReactNode {
  const endpointRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(true);
  useLayoutEffect(() => {
    const endpoint = endpointRef.current;
    if (endpoint === null) return;
    return registerPrimaryFocusEndpoint(props.target, {
      focus: () => {
        focus();
        endpoint.focus();
      },
      containsActiveElement: (candidate) => candidate === endpoint,
      isEligible: () => endpoint.isConnected,
    });
  }, [active, props.target]);
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper === null) return;
    const activateBrowser = (): void => setActive(false);
    wrapper.addEventListener("focus", activateBrowser, true);
    return () => wrapper.removeEventListener("focus", activateBrowser, true);
  }, []);
  useEffect(() => {
    requestPrimaryFocus(props.target);
  }, [props.target]);
  return (
    <>
      <textarea ref={endpointRef} aria-label="primary endpoint" />
      <div ref={wrapperRef} data-browser-active={String(!active)}>
        {createElement("webview", {
          "aria-label": "browser guest",
          role: "application",
        })}
      </div>
    </>
  );
}

afterEach(() => {
  cleanup();
  resetPrimaryFocusCoordinatorForTests();
  focus.mockReset();
});

describe("PrimaryFocusCoordinatorProvider", () => {
  it.each([
    { kind: "composer", surfaceId: "chat-a" },
    { kind: "terminal", instanceId: "terminal-a" },
  ] as const)(
    "hands a fulfilled $kind intent to a non-bubbling browser guest focus before activation commits",
    async (target) => {
      const view = render(
        <PrimaryFocusCoordinatorProvider>
          <HandoffProbe target={target} />
        </PrimaryFocusCoordinatorProvider>,
      );
      const endpoint = view.getByRole("textbox", { name: "primary endpoint" });
      const guest = view.getByRole("application", { name: "browser guest" });
      await waitFor(() => expect(document.activeElement).toBe(endpoint));
      endpoint.blur();

      act(() => {
        guest.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
      });
      expect(guest.parentElement?.dataset.browserActive).toBe("true");
      expect(document.activeElement).not.toBe(endpoint);

      act(() => {
        view.container.appendChild(document.createElement("div"));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(focus).toHaveBeenCalledTimes(1);
      expect(document.activeElement).not.toBe(endpoint);

      act(() => {
        requestPrimaryFocus(target);
      });
      expect(focus).toHaveBeenCalledTimes(2);
      expect(document.activeElement).toBe(endpoint);
    },
  );
});
