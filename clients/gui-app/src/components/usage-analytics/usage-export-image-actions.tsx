import { Fragment, type ReactNode } from "react";
import { Copy, Download, Share2, type LucideIcon } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { UsageImageExportAction } from "@/hooks/usage-analytics/use-usage-image-export";

/** How a surface wants the export controls drawn. */
export type UsageExportImageActionsVariant = "icon" | "labelled";

export interface UsageExportImageActionsProps {
  /** Whether the surface has enough loaded to capture a truthful image. */
  readonly exportReady: boolean;
  /** Which control's export is in flight, from `useUsageImageExport`. */
  readonly pendingAction: UsageImageExportAction | null;
  /** The controls this shell can honour, from `useUsageImageExport`. */
  readonly copyImage: (() => void) | null;
  readonly shareImage: (() => void) | null;
  /** `null` where this device has no download destination at all. */
  readonly downloadImage: (() => void) | null;
  /**
   * Names this surface's buttons in tests - `usage-copy-image`,
   * `epic-usage-download-image`. Each surface keeps the ids it already had.
   */
  readonly testIdPrefix: string;
  readonly variant: UsageExportImageActionsVariant;
  /** Layout the host footer/header imposes, e.g. full-width on a sheet. */
  readonly buttonClassName: string | undefined;
}

interface UsageExportControl {
  readonly action: UsageImageExportAction;
  /** Tooltip and button copy, and the stem of the test id. */
  readonly label: string;
  /** What a screen reader announces where the button is icon-only. */
  readonly ariaLabel: string;
  readonly icon: LucideIcon;
  readonly onClick: () => void;
}

/**
 * The export controls a usage surface renders, in a fixed order, from the
 * set the shell can actually honour.
 *
 * ONE export runs at a time, so EVERY button goes disabled while any is
 * pending; only the one that started it shows the spinner, which is what the
 * mutation's variables discriminate. Shared by both usage surfaces so the set
 * of controls, their copy and their pending behaviour cannot drift apart -
 * which control exists at all is decided once, in `useUsageImageExport`, off
 * shell capability rather than per surface.
 */
export function UsageExportImageActions(
  props: UsageExportImageActionsProps,
): ReactNode {
  const { exportReady, pendingAction, variant, buttonClassName } = props;
  const isExporting = pendingAction !== null;
  const controls: readonly UsageExportControl[] = [
    ...(props.copyImage === null
      ? []
      : [
          {
            action: "copy" as const,
            label: "Copy image",
            ariaLabel: "Copy usage image",
            icon: Copy,
            onClick: props.copyImage,
          },
        ]),
    ...(props.shareImage === null
      ? []
      : [
          {
            action: "share" as const,
            label: "Share image",
            ariaLabel: "Share usage image",
            icon: Share2,
            onClick: props.shareImage,
          },
        ]),
    ...(props.downloadImage === null
      ? []
      : [
          {
            action: "download" as const,
            label: "Download image",
            ariaLabel: "Download usage image",
            icon: Download,
            onClick: props.downloadImage,
          },
        ]),
  ];

  return (
    <>
      {controls.map((control) => {
        const Icon = control.icon;
        const glyph =
          pendingAction === control.action ? (
            <AgentSpinningDots
              className="size-3"
              testId={undefined}
              variant={undefined}
            />
          ) : (
            <Icon
              aria-hidden
              className={variant === "icon" ? "size-3.5" : undefined}
            />
          );
        const button = (
          <Button
            type="button"
            variant="outline"
            size={variant === "icon" ? "icon-sm" : "sm"}
            className={buttonClassName}
            aria-label={variant === "icon" ? control.ariaLabel : undefined}
            data-testid={`${props.testIdPrefix}-${control.action}-image`}
            disabled={!exportReady || isExporting}
            onClick={control.onClick}
          >
            {glyph}
            {variant === "labelled" ? control.label : null}
          </Button>
        );
        // The labelled variant already says what it does; a tooltip repeating
        // the label is noise, and on the touch surfaces that variant is drawn
        // for there is no hover to open one anyway. A keyed Fragment rather
        // than a wrapper element: the button has to stay a direct child of the
        // host's flex row, or its width and the row's gap both stop applying.
        if (variant === "labelled") {
          return <Fragment key={control.action}>{button}</Fragment>;
        }
        return (
          <TooltipWrapper
            key={control.action}
            label={control.label}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            {button}
          </TooltipWrapper>
        );
      })}
    </>
  );
}
