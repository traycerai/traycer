import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export const OverlayFrameContext = createContext<Set<object> | null>(null);

/** Only committed, presented dismissible descendants own a frame gesture. */
export function useOverlayFrameRegistration(open: boolean): void {
  const registry = useContext(OverlayFrameContext);
  useLayoutEffect(() => {
    if (!open || !registry) return;
    const token = {};
    registry.add(token);
    return () => {
      registry.delete(token);
    };
  }, [registry, open]);
}

export function useOverlayFrame() {
  const [registry] = useState(() => new Set<object>());
  const backdrop = useRef<HTMLDivElement>(null);
  const ownedEvents = useRef(new WeakMap<Event, boolean>());
  useLayoutEffect(() => {
    let gesture: {
      pointerId: number;
      target: EventTarget | null;
      owned: boolean;
    } | null = null;
    const down = (event: PointerEvent): void => {
      gesture = {
        pointerId: event.pointerId,
        target: event.target,
        owned: registry.size > 0,
      };
      ownedEvents.current.set(event, registry.size > 0);
    };
    const cancel = (): void => {
      gesture = null;
    };
    const click = (event: MouseEvent): void => {
      const start = gesture;
      if (event.detail === 0) ownedEvents.current.set(event, registry.size > 0);
      if (
        start &&
        event.detail > 0 &&
        event.target === start.target &&
        (!(event instanceof PointerEvent) ||
          event.pointerId === start.pointerId)
      )
        ownedEvents.current.set(event, start.owned);
      gesture = null;
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("click", click, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("click", click, true);
    };
  }, [registry]);
  const guard = (details: {
    reason: string;
    event: Event;
    cancel: () => void;
  }): void => {
    if (
      details.reason === "outside-press" &&
      (ownedEvents.current.get(details.event) === true ||
        details.event.target !== backdrop.current)
    )
      details.cancel();
  };
  return { registry, backdrop, guard };
}
