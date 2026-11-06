import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import {
  ScreenImage,
  SetUpImage,
  SHARE_PIXEL_FONT_FAMILY,
  TeamImage,
  UsageImage,
} from "@/components/share-on-x/share-image-cards";
import {
  renderShareImage,
  toShareImage,
  type ShareImage,
} from "@/components/share-on-x/share-images";
import type { SetUpHarness } from "@/components/share-on-x/set-up-harnesses";
import type { ShareUsageFacts } from "@/components/share-on-x/share-usage-facts";
import type { AnalyticsShareImage } from "@/lib/analytics";
import { appLogger, describeLogErrorSummary } from "@/lib/logger";

export interface ShareImageSourcesProps {
  readonly setUpHarnesses: ReadonlyArray<SetUpHarness>;
  readonly usage: ShareUsageFacts | null;
  /** The window as captured when the dialog opened, to frame. */
  readonly screenCapture: ShareImage | null;
  readonly onCaptured: (
    image: AnalyticsShareImage,
    captured: ShareImage,
  ) => void;
  readonly onFailed: (image: AnalyticsShareImage) => void;
}

/**
 * Draws the dialog's images offscreen and rasterises each once it has data:
 * the setup, the framed screen, the task's usage and its agent team. Nothing
 * here is visible or reachable; the dialog shows the resulting PNGs.
 */
export function ShareImageSources(props: ShareImageSourcesProps): ReactNode {
  const { setUpHarnesses, usage, screenCapture, onCaptured, onFailed } = props;
  return (
    <div
      aria-hidden="true"
      inert
      // Offscreen, not hidden: a `display: none` subtree has no layout to
      // rasterise.
      className="pointer-events-none fixed top-0 -left-25000 flex flex-col gap-4"
    >
      {setUpHarnesses.length === 0 ? null : (
        <OffscreenCapture
          captureKey={setUpHarnesses.map((harness) => harness.id).join(",")}
          onCaptured={(captured) => onCaptured("setup", captured)}
          onFailed={() => onFailed("setup")}
        >
          <SetUpImage harnesses={setUpHarnesses} />
        </OffscreenCapture>
      )}
      {screenCapture === null ? null : (
        <OffscreenCapture
          captureKey="screen"
          onCaptured={(captured) => onCaptured("screen", captured)}
          onFailed={() => onFailed("screen")}
        >
          <ScreenImage src={screenCapture.src} />
        </OffscreenCapture>
      )}
      {usage === null ? null : (
        <OffscreenCapture
          // Drawn again whenever newer figures arrive, so the image offered
          // is always the current one.
          captureKey={JSON.stringify(usage)}
          onCaptured={(captured) => onCaptured("usage", captured)}
          onFailed={() => onFailed("usage")}
        >
          <UsageImage facts={usage} />
        </OffscreenCapture>
      )}
      {usage === null || usage.chatCount < 2 ? null : (
        <OffscreenCapture
          captureKey={JSON.stringify([
            usage.chatCount,
            usage.machineCount,
            usage.agents.map((agent) => agent.id),
          ])}
          onCaptured={(captured) => onCaptured("team", captured)}
          onFailed={() => onFailed("team")}
        >
          <TeamImage facts={usage} />
        </OffscreenCapture>
      )}
    </div>
  );
}

function OffscreenCapture(props: {
  /** Re-capture when this changes; the same key never captures twice. */
  readonly captureKey: string;
  readonly onCaptured: (captured: ShareImage) => void;
  readonly onFailed: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const run = useEffectEvent((node: HTMLElement, isCurrent: () => boolean) => {
    // Faces first: a capture taken before a web font loads draws the
    // fallback face. The pixel face is asked for by name, since nothing
    // may have started loading it yet.
    void document.fonts
      .load(`16px "${SHARE_PIXEL_FONT_FAMILY}"`)
      .then(() => document.fonts.ready)
      .then(() => renderShareImage(node))
      .then(toShareImage)
      .then(
        (captured) => {
          if (isCurrent()) props.onCaptured(captured);
        },
        (error: unknown) => {
          appLogger.warn("[share-on-x] image capture failed", {
            error: describeLogErrorSummary(error),
          });
          if (isCurrent()) props.onFailed();
        },
      );
  });
  useEffect(() => {
    const node = nodeRef.current;
    if (node === null) return;
    let current = true;
    run(node, () => current);
    return () => {
      current = false;
    };
  }, [props.captureKey]);
  return <div ref={nodeRef}>{props.children}</div>;
}
