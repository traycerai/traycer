import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { SimulatorPlatform } from "@traycer/protocol/host/simulator/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { isMac } from "@/lib/keybindings/platform";
import {
  deviceFrameStyle,
  deviceMediaStyle,
  displayAspect,
  fitDeviceFrame,
  normalizedSurfacePoint,
  screenRotationDegrees,
  shouldForwardKey,
  type FrameSize,
  type SimulatorTouchPhase,
} from "@/lib/simulator-view/simulator-input-encoding";
import type {
  SimulatorStreamController,
  SimulatorStreamState,
} from "@/lib/simulator-view/simulator-stream-controller";
import type { AttachableFrameSink } from "@/components/simulator-tile/simulator-frame-sink";
import { cn } from "@/lib/utils";

/**
 * The pixels of a simulator and the input that goes back: a `<canvas>` the
 * decoder paints into, an `<img>` sibling for MJPEG, pointer capture
 * normalised to 0..1 of the drawn frame, and keys while the surface has
 * focus. The frame is the largest box at the device's aspect that fits the
 * tile (`fitDeviceFrame`), so a narrow tile shows a shorter phone rather
 * than a squeezed one, and an iOS device held sideways is a CSS rotation of
 * its portrait framebuffer.
 */
export function SimulatorSurface(props: {
  readonly platform: SimulatorPlatform;
  readonly simulatorName: string;
  readonly controller: SimulatorStreamController | null;
  readonly state: SimulatorStreamState;
  readonly sink: AttachableFrameSink;
  readonly onReconnect: () => void;
}) {
  const { controller, state, sink } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<FrameSize>({ width: 0, height: 0 });
  useEffect(() => {
    const element = hostRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setHost((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The decoded frame's own size on the canvas plane; the image plane reports
  // its size through `naturalWidth`/`naturalHeight` once a frame has loaded.
  const [imageSize, setImageSize] = useState<FrameSize | null>(null);
  const frameSize = state.plane === "image" ? imageSize : state.frameSize;
  const aspect = displayAspect(props.platform, state.config, frameSize);
  const frame = fitDeviceFrame(aspect, host.width, host.height);
  const rotation = screenRotationDegrees(
    props.platform,
    state.config,
    frameSize,
  );
  const mediaStyle = deviceMediaStyle(frame, rotation);
  const frameStyle = deviceFrameStyle(frame);

  const attachCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => sink.attachCanvas(canvas),
    [sink],
  );
  const attachImage = useCallback(
    (image: HTMLImageElement | null) => sink.attachImage(image),
    [sink],
  );

  const pointerActive = useRef(false);
  const sendTouch = (
    phase: SimulatorTouchPhase,
    event: ReactPointerEvent<HTMLElement>,
  ): void => {
    const point = normalizedSurfacePoint({
      clientX: event.clientX,
      clientY: event.clientY,
      rect: event.currentTarget.getBoundingClientRect(),
    });
    if (point === null) return;
    controller?.sendTouch(phase, point);
  };
  const endTouch = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!pointerActive.current) return;
    pointerActive.current = false;
    sendTouch("end", event);
  };

  const onKey = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    phase: "down" | "up",
  ): void => {
    if (!shouldForwardKey(event, isMac())) return;
    // A button fires `click` on Space and Enter; the device gets the key
    // instead, and nothing else here listens for a click.
    event.preventDefault();
    controller?.sendKey(event, phase);
  };

  const streaming = state.lifecycle === "streaming";
  const showOverlay = state.lifecycle !== "streaming";
  const deviceLabel =
    props.platform === "ios" ? "iOS Simulator" : "Android Emulator";

  return (
    <div
      ref={hostRef}
      className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-canvas"
      data-testid="simulator-surface"
      data-lifecycle={state.lifecycle}
    >
      {/*
        A real button, as the screencast surface is: it takes focus for the
        keys, captures the pointer for a drag, and is the box the 0..1
        coordinates are read against. Its native click is never used.
      */}
      <button
        type="button"
        aria-label={`${deviceLabel} screen, ${props.simulatorName}`}
        className={cn(
          "relative block touch-none appearance-none border-0 bg-transparent p-0 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          state.input.connected ? "cursor-default" : "cursor-not-allowed",
        )}
        style={frameStyle}
        data-testid="simulator-frame"
        onKeyDown={(event) => onKey(event, "down")}
        onKeyUp={(event) => onKey(event, "up")}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus();
          pointerActive.current = true;
          sendTouch("begin", event);
        }}
        onPointerMove={(event) => {
          if (!pointerActive.current) return;
          sendTouch("move", event);
        }}
        onPointerUp={endTouch}
        onPointerCancel={endTouch}
      >
        <canvas
          ref={attachCanvas}
          className={cn(
            "absolute top-0 left-0",
            state.plane === "image" && "hidden",
          )}
          style={mediaStyle}
          data-testid="simulator-canvas"
        />
        <img
          ref={attachImage}
          alt=""
          draggable={false}
          className={cn(
            "absolute top-0 left-0 object-contain",
            state.plane === "canvas" && "hidden",
          )}
          style={mediaStyle}
          data-testid="simulator-image"
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth === 0 || image.naturalHeight === 0) return;
            setImageSize((current) =>
              current !== null &&
              current.width === image.naturalWidth &&
              current.height === image.naturalHeight
                ? current
                : { width: image.naturalWidth, height: image.naturalHeight },
            );
          }}
        />
      </button>
      {streaming && !state.input.connected ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2">
          <span className="rounded-md bg-background/85 px-2 py-1 text-ui-xs text-muted-foreground">
            {state.input.detail ?? "Input is not connected."}
          </span>
        </div>
      ) : null}
      {showOverlay ? (
        <SimulatorSurfaceOverlay
          state={state}
          onReconnect={props.onReconnect}
        />
      ) : null}
    </div>
  );
}

function SimulatorSurfaceOverlay(props: {
  readonly state: SimulatorStreamState;
  readonly onReconnect: () => void;
}) {
  const { state } = props;
  const failed = state.lifecycle === "error";
  const message = overlayMessage(state);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="simulator-surface-overlay"
      className={cn(
        "absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center text-ui-sm",
        // Keep the last frame visible under a reconnect; a failure covers it.
        failed ? "bg-canvas" : "pointer-events-none",
      )}
    >
      {failed ? null : (
        <AgentSpinningDots
          className="shrink-0"
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      )}
      <p
        className={cn(
          "max-w-md",
          failed
            ? "text-foreground/75"
            : "rounded-md bg-background/85 px-2 py-1 text-muted-foreground",
        )}
      >
        {message}
      </p>
      {failed && !state.terminal ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onReconnect}
        >
          Reconnect
        </Button>
      ) : null}
    </div>
  );
}

function overlayMessage(state: SimulatorStreamState): string {
  if (state.lifecycle === "error") return state.detail ?? "The video stopped.";
  if (state.lifecycle === "reconnecting") return "Reconnecting…";
  return "Connecting…";
}
