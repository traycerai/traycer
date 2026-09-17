import {
  ChevronDown,
  ChevronRight,
  Info,
  TriangleAlert,
  Wifi,
} from "lucide-react";
import { useState } from "react";
import type {
  ProviderNoticeDetail,
  ProviderNoticeKind,
  ProviderNoticeTone,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { FallbackNoticeSettingsLink } from "@/components/chat/fallback/fallback-notice-attribution";
import { isFallbackNoticeKind } from "@/components/chat/fallback/fallback-notice-kinds";
import { LivePulse } from "@/components/ui/live-pulse";
import { cn } from "@/lib/utils";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

interface ProviderNoticeSegmentProps {
  status: "streaming" | "completed" | "errored";
  /**
   * Which notice this is. Only the provider-fallback arms read it, and only to
   * add the settings link below their details - the rest of this component is
   * kind-blind on purpose, because a harness notice and a fallback notice are
   * the same shape of row.
   */
  noticeKind: ProviderNoticeKind;
  /** Compact Codex status, matching the native app's transient retry row. */
  presentation?: "retry";
  tone: ProviderNoticeTone;
  title: string;
  message: string | null;
  details: ReadonlyArray<ProviderNoticeDetail>;
  findUnitId: string | null;
}

const TONE_ICON: Record<ProviderNoticeTone, typeof Info> = {
  info: Info,
  warning: TriangleAlert,
};

const TONE_TEXT_CLASS: Record<ProviderNoticeTone, string> = {
  info: "text-muted-foreground",
  warning: "text-amber-700 dark:text-amber-300",
};

export function ProviderNoticeSegment(props: ProviderNoticeSegmentProps) {
  return props.presentation === "retry" ? (
    <CodexRetryNotice
      title={props.title}
      details={props.details}
      findUnitId={props.findUnitId}
    />
  ) : (
    <StandardProviderNoticeSegment {...props} />
  );
}

function CodexRetryNotice(
  props: Pick<ProviderNoticeSegmentProps, "title" | "details" | "findUnitId">,
) {
  const { title, details, findUnitId } = props;
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      role="status"
      data-chat-find-unit={findUnitId ?? undefined}
      className="flex w-full min-w-0 flex-col items-start gap-1 text-ui-xs text-muted-foreground"
    >
      <TooltipWrapper
        label="Reported by Codex"
        side="top"
        sideOffset={undefined}
        align="start"
      >
        <button
          type="button"
          data-find-include="true"
          aria-expanded={expanded}
          aria-label={`${title}. Reported by Codex. ${expanded ? "Hide" : "Show"} details.`}
          onClick={() => setExpanded((current) => !current)}
          className="flex items-center gap-2 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Wifi className="size-3.5 shrink-0" aria-hidden />
          <span>{title}</span>
        </button>
      </TooltipWrapper>
      {expanded ? (
        <dl
          data-find-skip="true"
          className="m-0 flex w-full min-w-0 flex-col gap-1 pl-5"
        >
          {details.map((detail) => (
            <div
              key={`${detail.label}:${detail.value}`}
              className="flex flex-wrap gap-x-2"
            >
              <dt className="font-medium">{detail.label}</dt>
              <dd className="m-0 min-w-0 wrap-anywhere">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function StandardProviderNoticeSegment(props: ProviderNoticeSegmentProps) {
  const { status, noticeKind, tone, title, message, details, findUnitId } =
    props;
  const isStreaming = status === "streaming";
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = (): void => setExpanded((current) => !current);

  const hasDetails = details.length > 0;
  const Icon = TONE_ICON[tone];
  const toneClass = TONE_TEXT_CLASS[tone];
  const ExpandIcon = expanded ? ChevronDown : ChevronRight;

  const labelInner = (
    <div className={cn("flex items-center gap-2 text-ui-xs", toneClass)}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span>
        {title}
        {message !== null && message.length > 0 ? (
          <span className="text-muted-foreground/80"> · {message}</span>
        ) : null}
      </span>
      {isStreaming ? (
        <LivePulse
          size="xs"
          tone="active"
          ariaLabel="Provider notice active"
          className={undefined}
        />
      ) : null}
      {hasDetails ? (
        <ExpandIcon className="size-3 shrink-0" aria-hidden />
      ) : null}
    </div>
  );

  return (
    <div
      data-chat-find-unit={findUnitId ?? undefined}
      role={isStreaming ? "status" : undefined}
      className="flex w-full flex-col gap-1"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden className="h-px flex-1 bg-border/60" />
        {hasDetails ? (
          <button
            type="button"
            onClick={toggleExpanded}
            aria-expanded={expanded}
            className={cn(
              "rounded-sm outline-none transition-colors",
              "hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
            )}
          >
            {labelInner}
          </button>
        ) : (
          labelInner
        )}
        <span aria-hidden className="h-px flex-1 bg-border/60" />
      </div>
      {hasDetails && expanded ? (
        <div
          className={cn(
            "mx-auto w-full max-w-[min(90vw,42rem)]",
            "rounded-md border border-border/60 bg-muted/30 p-3",
          )}
        >
          <dl className="m-0 flex flex-col gap-1 text-ui-xs">
            {details.map((detail) => (
              <div
                key={`${detail.label}:${detail.value}`}
                className="flex gap-2"
              >
                <dt className="shrink-0 font-medium text-muted-foreground">
                  {detail.label}
                </dt>
                <dd className="m-0 min-w-0 flex-1 text-foreground/85">
                  {detail.value}
                </dd>
              </div>
            ))}
          </dl>
          {/*
           * Inside the expanded details, never on the collapsed rule: this is
           * the one place a historical fallback row offers an action, and it
           * is the only KIND of action it may offer - a link to the policy
           * that produced it. Nothing here re-dispatches.
           */}
          {isFallbackNoticeKind(noticeKind) ? (
            <div className="mt-2 flex">
              <FallbackNoticeSettingsLink />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
