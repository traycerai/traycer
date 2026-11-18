import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SegmentCopyButton } from "./segment-copy-button";

interface SegmentPanelProps {
  label: string;
  copyValue: string | null;
  className: string | undefined;
  tone: "default" | "destructive";
  bodyChrome: "framed" | "bare";
  children: ReactNode;
}

const TONE_LABEL_CLASS: Record<SegmentPanelProps["tone"], string> = {
  default: "text-muted-foreground/80",
  destructive: "text-destructive",
};

/**
 * Stacked panel inside an expanded segment card. Shows a small label header
 * + body, and surfaces a hover-revealed copy button when `copyValue` is set.
 * Caps the body height with internal scroll so long outputs do not blow up
 * the chat row.
 */
export function SegmentPanel(props: SegmentPanelProps) {
  const { label, copyValue, className, tone, bodyChrome, children } = props;
  return (
    <div
      className={cn(
        "group/segment-panel flex flex-col gap-1 rounded-md bg-canvas/40",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <span
          data-find-skip
          className={cn(
            "select-none font-medium uppercase text-overline",
            TONE_LABEL_CLASS[tone],
          )}
        >
          {label}
        </span>
        {copyValue !== null ? (
          <SegmentCopyButton
            value={copyValue}
            ariaLabel={`Copy ${label.toLowerCase()}`}
            className={undefined}
          />
        ) : null}
      </div>
      <div
        className={cn(
          "max-h-[40vh] overflow-auto",
          bodyChrome === "framed"
            ? "rounded-md border border-canvas-border/30 bg-canvas/40"
            : null,
        )}
      >
        {children}
      </div>
    </div>
  );
}
