import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { themeTokens, type ThemeToken } from "@/lib/themes/theme-definition";
import { findThemeTokenUsage, inspectThemeElement } from "./theme-inspection";

function candidates(): Element[] {
  return Array.from(document.body.querySelectorAll("*")).filter(
    (element) =>
      !element.closest("[data-theme-editor], [data-theme-inspector]") &&
      element.getBoundingClientRect().width > 0 &&
      element.getBoundingClientRect().height > 0,
  );
}

interface Highlight {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function ThemeInspector({
  inspecting,
  token,
  onSelect,
  onStop,
}: {
  inspecting: boolean;
  token: ThemeToken | null;
  onSelect: (token: ThemeToken) => void;
  onStop: () => void;
}) {
  const highlightIds = useRef(new WeakMap<Element, string>());
  const [hover, setHover] = useState<Element | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!inspecting) return;
    let pending: Element | null = null;
    let frame = 0;
    const move = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest("[data-theme-editor]")
      )
        return;
      pending = event.target;
      if (!frame)
        frame = requestAnimationFrame(() => {
          setHover(pending);
          frame = 0;
        });
    };
    const click = (event: MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest("[data-theme-editor]")
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const result = inspectThemeElement(event.target);
      if (result) {
        onSelect(result.token);
        onStop();
      } else
        setMessage(
          "This area does not use an editable color. Try another element.",
        );
    };
    const preventAction = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest("[data-theme-editor]")
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onStop();
      }
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerdown", preventAction, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerdown", preventAction, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [inspecting, onSelect, onStop]);

  useEffect(() => {
    let frame = 0;
    // ponytail: usage discovery scans the mounted DOM on selection; index token dependencies if very large documents make this slow.
    let elements: Element[] = [];
    if (inspecting && hover) elements = [hover];
    if (!inspecting && token)
      elements = findThemeTokenUsage(candidates(), [token]).map(
        (match) => match.element,
      );
    const refresh = () => {
      frame = 0;
      setHighlights(
        elements
          .filter((element) => element.isConnected)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const id = highlightIds.current.get(element) ?? crypto.randomUUID();
            highlightIds.current.set(element, id);
            return {
              id,
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            };
          }),
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(refresh);
    };
    refresh();
    const observer = new MutationObserver((mutations) => {
      if (
        inspecting ||
        !token ||
        mutations.every(
          (mutation) =>
            mutation.target instanceof Element &&
            mutation.target.closest(
              "[data-theme-editor], [data-theme-inspector]",
            ),
        )
      )
        return;
      elements = findThemeTokenUsage(candidates(), [token]).map(
        (match) => match.element,
      );
      schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
    };
  }, [hover, inspecting, token]);

  if (!inspecting && !token) return null;
  return createPortal(
    <div
      data-theme-inspector
      className="pointer-events-none fixed inset-0 z-[109]"
    >
      {highlights.map(({ id, ...rect }) => (
        <div
          key={id}
          className="absolute rounded-md border-2 border-[#a5bd83] bg-[#a5bd83]/10 ring-1 ring-[#272a25]/40"
          style={rect}
        />
      ))}
      <div
        role="status"
        className="absolute top-safe-top-gutter left-safe-left-gutter max-w-safe-dvw rounded-lg border border-[#4a5143] bg-[#272a25] px-4 py-3 text-sm text-[#edf0e8] shadow-lg"
      >
        {inspecting
          ? message || "Select an area to edit its color. Escape cancels."
          : `${themeTokens.find((entry) => entry.key === token)?.label}: ${highlights.length} areas`}
      </div>
    </div>,
    document.body,
  );
}
