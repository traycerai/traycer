import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useReducedMotion } from "@/lib/animation/status-animation-clock";

interface MarqueeStyle extends CSSProperties {
  readonly "--soundtrack-title-offset": string;
  readonly "--soundtrack-title-duration": string;
}

/** A single accessible title; only its visual position moves, never the buttons. */
export function SoundtrackTitle(props: {
  readonly title: string;
  readonly paused: boolean;
}): ReactNode {
  const viewport = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const reducedMotion = useReducedMotion();
  useLayoutEffect(() => {
    const box = viewport.current;
    const content = text.current;
    if (box === null || content === null) return;
    const measure = (): void => {
      setOverflow(Math.max(0, content.scrollWidth - box.clientWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(content);
    return () => observer.disconnect();
  }, [props.title]);
  const scrolling = overflow > 0 && !reducedMotion;
  const style: MarqueeStyle = {
    "--soundtrack-title-offset": `${String(-overflow)}px`,
    "--soundtrack-title-duration": `${String(Math.max(8, overflow / 24 + 4))}s`,
  };
  return (
    <span ref={viewport} className="block overflow-hidden whitespace-nowrap">
      <span
        ref={text}
        className="soundtrack-title"
        data-scrolling={scrolling}
        data-paused={props.paused}
        style={style}
      >
        {props.title}
      </span>
    </span>
  );
}
