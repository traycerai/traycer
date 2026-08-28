import { ChevronDown, CircleAlert } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { EASE_OUT } from "./ease";
import { useHoverCapable } from "./use-hover-capable";

export type ImageGenerationStatus =
  | "generating"
  | "complete"
  | "error"
  | "stopped"
  | "superseded";

interface ImageGenerationProps {
  readonly children: ReactNode;
  readonly status: ImageGenerationStatus;
  readonly prompt: string;
  readonly resolution: string;
  readonly aspectRatio: CSSProperties["aspectRatio"];
  readonly mediaStyle: CSSProperties;
}

const STATUS_TEXT: Record<ImageGenerationStatus, string> = {
  generating: "Generating image",
  complete: "Image ready",
  error: "Generation failed",
  stopped: "Generation stopped",
  superseded: "Generation superseded",
};

const MEDIA_STATE: Record<
  ImageGenerationStatus,
  { filter: string; opacity: number; scale: number }
> = {
  generating: { filter: "blur(3px) saturate(0.85)", opacity: 0, scale: 1.015 },
  complete: { filter: "blur(0px) saturate(1)", opacity: 1, scale: 1 },
  error: { filter: "blur(2px) saturate(0.5)", opacity: 0.28, scale: 1 },
  stopped: { filter: "blur(2px) saturate(0.5)", opacity: 0.28, scale: 1 },
  superseded: { filter: "blur(2px) saturate(0.5)", opacity: 0.28, scale: 1 },
};

const OVERLAY_OPACITY: Record<ImageGenerationStatus, number> = {
  generating: 1,
  complete: 0,
  error: 0,
  stopped: 0,
  superseded: 0,
};

const DOT_GAP = 10;
const TWO_PI = Math.PI * 2;

function DitherMark(props: {
  readonly status: ImageGenerationStatus;
  readonly reduce: boolean;
}): ReactNode {
  if (props.status === "error") {
    return <CircleAlert aria-hidden="true" className="size-3.5" />;
  }
  if (props.status !== "generating") return null;
  return (
    <AgentSpinningDots
      className="text-current"
      testId={undefined}
      variant={props.reduce ? "static" : undefined}
    />
  );
}

function DitherField(props: {
  readonly reduce: boolean;
  readonly status: ImageGenerationStatus;
}): ReactNode {
  const canHover = useHoverCapable();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas === null || context === null || context === undefined) return;

    let frame = 0;
    let visible = true;
    let width = 0;
    let height = 0;
    let dotColor = "currentColor";
    const pointer = {
      x: 0,
      y: 0,
      targetX: 0,
      targetY: 0,
      inside: false,
    };
    const pointerEnabled = canHover && !props.reduce;

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width || canvas.clientWidth || 208;
      height = rect.height || canvas.clientHeight || 208;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      dotColor = window.getComputedStyle(canvas).color;
      pointer.x = width / 2;
      pointer.y = height / 2;
      pointer.targetX = pointer.x;
      pointer.targetY = pointer.y;
    };

    const draw = (time: number): void => {
      context.clearRect(0, 0, width, height);
      if (!pointer.inside) {
        pointer.targetX =
          width / 2 + (props.reduce ? 0 : Math.sin(time / 1700) * width * 0.12);
        pointer.targetY =
          height / 2 +
          (props.reduce ? 0 : Math.cos(time / 2100) * height * 0.1);
      }

      let follow = 0.045;
      if (props.reduce) follow = 1;
      else if (pointer.inside) follow = 0.16;
      pointer.x += (pointer.targetX - pointer.x) * follow;
      pointer.y += (pointer.targetY - pointer.y) * follow;

      const radius = Math.min(width, height) * 0.38;
      const columns = Math.ceil(width / DOT_GAP) + 1;
      const rows = Math.ceil(height / DOT_GAP) + 1;
      const offsetX = (width - (columns - 1) * DOT_GAP) / 2;
      const offsetY = (height - (rows - 1) * DOT_GAP) / 2;
      context.fillStyle = dotColor;

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const anchorX = offsetX + column * DOT_GAP;
          const anchorY = offsetY + row * DOT_GAP;
          const deltaX = anchorX - pointer.x;
          const deltaY = anchorY - pointer.y;
          const distance = Math.hypot(deltaX, deltaY);
          const proximity = Math.max(0, 1 - distance / radius);
          const influence = proximity * proximity * (3 - 2 * proximity);
          const displacement = influence * influence * 9;
          const directionX = distance > 0 ? deltaX / distance : 0;
          const directionY = distance > 0 ? deltaY / distance : 0;
          const x = anchorX + directionX * displacement;
          const y = anchorY + directionY * displacement;
          const dotRadius = 0.65 + influence * 0.85;
          context.globalAlpha = 0.17 + influence * 0.72;
          context.beginPath();
          context.arc(x, y, dotRadius, 0, TWO_PI);
          context.fill();
        }
      }

      context.globalAlpha = 1;
      if (!props.reduce && visible) frame = window.requestAnimationFrame(draw);
    };

    const handlePointerMove = (event: PointerEvent): void => {
      if (!pointerEnabled) return;
      const rect = canvas.getBoundingClientRect();
      pointer.inside = true;
      pointer.targetX = event.clientX - rect.left;
      pointer.targetY = event.clientY - rect.top;
    };
    const handlePointerLeave = (): void => {
      pointer.inside = false;
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    const visibilityObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            const nextVisible = entries.some((entry) => entry.isIntersecting);
            if (nextVisible === visible) return;
            visible = nextVisible;
            if (!visible) {
              if (frame !== 0) window.cancelAnimationFrame(frame);
              frame = 0;
            } else if (!props.reduce && frame === 0) {
              frame = window.requestAnimationFrame(draw);
            }
          });

    resize();
    resizeObserver?.observe(canvas);
    visibilityObserver?.observe(canvas);
    canvas.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    canvas.addEventListener("pointerleave", handlePointerLeave);
    draw(0);

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      visibilityObserver?.disconnect();
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, [canHover, props.reduce]);

  return (
    <motion.div
      aria-hidden="true"
      initial={false}
      animate={{ opacity: OVERLAY_OPACITY[props.status] }}
      transition={{ duration: props.reduce ? 0 : 0.4, ease: EASE_OUT }}
      className="absolute inset-0 overflow-hidden bg-muted"
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 size-full text-foreground"
      />
    </motion.div>
  );
}

export function ImageGeneration(props: ImageGenerationProps): ReactNode {
  const reduce = useReducedMotion() ?? false;
  const active = props.status === "generating";
  const statusText = STATUS_TEXT[props.status];
  const label = props.prompt ? `${statusText}: ${props.prompt}` : statusText;

  return (
    <div
      data-slot="image-generation"
      data-state={props.status}
      aria-busy={active}
      className="w-full max-w-full"
    >
      <ImageGenerationMedia
        props={props}
        active={active}
        reduce={reduce}
        label={label}
      />
      <ImageGenerationDetails
        status={props.status}
        statusText={statusText}
        prompt={props.prompt}
        reduce={reduce}
      />
    </div>
  );
}

function ImageGenerationMedia(props: {
  readonly props: ImageGenerationProps;
  readonly active: boolean;
  readonly reduce: boolean;
  readonly label: string;
}): ReactNode {
  const mediaState = MEDIA_STATE[props.props.status];
  const hasImage = props.props.children !== null;
  return (
    <div
      data-image-generation-media
      role={hasImage ? "group" : "img"}
      aria-label={hasImage ? undefined : props.label}
      style={{
        ...props.props.mediaStyle,
        aspectRatio: props.props.aspectRatio,
      }}
      className="relative isolate max-w-full overflow-hidden rounded-xl bg-muted @container"
    >
      <motion.div
        aria-hidden={hasImage ? undefined : true}
        initial={false}
        animate={
          props.reduce
            ? { opacity: mediaState.opacity }
            : {
                filter: mediaState.filter,
                opacity: mediaState.opacity,
                scale: mediaState.scale,
              }
        }
        transition={
          props.reduce ? { duration: 0 } : { duration: 0.4, ease: EASE_OUT }
        }
        className="absolute inset-0 [&>*]:size-full"
      >
        {props.props.children}
      </motion.div>
      <AnimatePresence initial={false}>
        {props.active ? (
          <motion.div
            key="dither-field"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: props.reduce ? 0 : 0.25,
              ease: EASE_OUT,
            }}
            className="absolute inset-0"
          >
            <DitherField reduce={props.reduce} status={props.props.status} />
          </motion.div>
        ) : null}
      </AnimatePresence>
      {props.props.resolution ? (
        <span className="pointer-events-none absolute left-2 top-2 z-10 whitespace-nowrap rounded-full bg-background/75 px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground @max-[8rem]:left-1 @max-[8rem]:top-1 @max-[8rem]:px-1.5">
          {props.props.resolution}
        </span>
      ) : null}
    </div>
  );
}

function ImageGenerationDetails(props: {
  readonly status: ImageGenerationStatus;
  readonly statusText: string;
  readonly prompt: string;
  readonly reduce: boolean;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-3 text-left">
      {props.status === "complete" ? (
        <span aria-live="polite" className="sr-only">
          {props.statusText}
        </span>
      ) : (
        <div
          aria-live="polite"
          className={cn(
            "mb-2 flex min-h-5 items-center gap-2 text-sm font-medium",
            props.status === "error" ? "text-destructive" : "text-foreground",
          )}
        >
          <DitherMark status={props.status} reduce={props.reduce} />
          <span>{props.statusText}</span>
        </div>
      )}
      {props.prompt ? (
        <Collapsible
          open={expanded}
          onOpenChange={setExpanded}
          className="w-full min-w-0 overflow-hidden rounded-md border border-border/60 bg-muted/20"
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              aria-label={
                expanded ? "Hide image details" : "Show image details"
              }
            >
              <span className="shrink-0 font-medium text-foreground/80">
                Image details
              </span>
              <span className="min-w-0 flex-1 truncate group-data-[state=open]:hidden">
                {props.prompt}
              </span>
              <ChevronDown
                className="ml-auto size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                aria-hidden
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t border-border/50 px-2.5 py-2">
            <p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {props.prompt}
            </p>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
