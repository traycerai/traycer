import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { EpicUsageExportRegion } from "@/components/epic-canvas/panels/epic-usage-dialog";
import {
  SetUpImage,
  TaskCardImage,
} from "@/components/share-on-x/share-image-cards";
import {
  renderShareImage,
  toShareImage,
  waitForDomToSettle,
  type ShareImage,
} from "@/components/share-on-x/share-images";
import type { SetUpHarness } from "@/components/share-on-x/set-up-harnesses";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";
import type { AnalyticsShareImage } from "@/lib/analytics";
import { appLogger, describeLogErrorSummary } from "@/lib/logger";
import {
  captureUsageExportImageBlob,
  USAGE_EXPORT_REGION_SELECTOR,
} from "@/lib/usage-analytics/usage-export-image";

/** A chart's first draw is done once its SVG has been still this long. */
const SETTLE_QUIET_MS = 300;
/** Capture anyway after this long, even if something keeps changing. */
const SETTLE_MAX_MS = 4_000;

type RenderedImage = Exclude<AnalyticsShareImage, "screen">;

export interface ShareImageSourcesProps {
  readonly setUpHarnesses: ReadonlyArray<SetUpHarness>;
  readonly taskTitle: string | null;
  readonly usage: UsageSummaryResponse | null;
  readonly onCaptured: (image: RenderedImage, captured: ShareImage) => void;
  readonly onFailed: (image: RenderedImage) => void;
}

/**
 * Draws the dialog's generated images offscreen and rasterises each once it
 * has data: the setup image, the task card, and the task's usage summary.
 * Nothing here is visible or reachable; the dialog shows the resulting PNGs.
 */
export function ShareImageSources(props: ShareImageSourcesProps): ReactNode {
  const { setUpHarnesses, taskTitle, usage, onCaptured, onFailed } = props;
  return (
    <div
      aria-hidden="true"
      inert
      // Offscreen, not hidden: a `display: none` subtree has no layout to
      // rasterise and the chart would never draw.
      className="pointer-events-none fixed top-0 -left-25000 flex flex-col gap-4"
    >
      {setUpHarnesses.length === 0 ? null : (
        <OffscreenCapture
          captureKey={setUpHarnesses.map((harness) => harness.id).join(",")}
          capture={renderShareImage}
          onCaptured={(captured) => onCaptured("setup", captured)}
          onFailed={() => onFailed("setup")}
        >
          <SetUpImage harnesses={setUpHarnesses} />
        </OffscreenCapture>
      )}
      {taskTitle === null ? null : (
        <OffscreenCapture
          captureKey={taskTitle}
          capture={renderShareImage}
          onCaptured={(captured) => onCaptured("card", captured)}
          onFailed={() => onFailed("card")}
        >
          <TaskCardImage title={taskTitle} />
        </OffscreenCapture>
      )}
      {usage === null ? null : (
        <OffscreenCapture
          captureKey="usage"
          capture={async (node) => {
            await waitForDomToSettle(node, SETTLE_QUIET_MS, SETTLE_MAX_MS);
            const region = node.querySelector<HTMLElement>(
              USAGE_EXPORT_REGION_SELECTOR,
            );
            if (region === null) throw new Error("usage region not rendered");
            return captureUsageExportImageBlob({
              region,
              heading: "Usage",
              subheading: "Cost and token usage for this task.",
            });
          }}
          onCaptured={(captured) => onCaptured("usage", captured)}
          onFailed={() => onFailed("usage")}
        >
          {/* The width the usage dialog lays this summary out at, so the
              picture matches what the person sees there. Only the summary
              and chart: the per-chat table needs an open task and names
              chats, which have no place in a public post. */}
          <div className="usage-chart-root @container w-[48rem] bg-background p-4">
            <EpicUsageExportRegion
              data={usage}
              chartGroupBy="harness"
              onChartGroupByChange={noop}
            />
          </div>
        </OffscreenCapture>
      )}
    </div>
  );
}

function noop(): void {}

function OffscreenCapture(props: {
  /** Re-capture when this changes; the same key never captures twice. */
  readonly captureKey: string;
  readonly capture: (node: HTMLElement) => Promise<Blob>;
  readonly onCaptured: (captured: ShareImage) => void;
  readonly onFailed: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const run = useEffectEvent((node: HTMLElement, isCurrent: () => boolean) => {
    // Fonts first: a capture taken before the web font loads draws the
    // fallback face.
    void document.fonts.ready
      .then(() => props.capture(node))
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
