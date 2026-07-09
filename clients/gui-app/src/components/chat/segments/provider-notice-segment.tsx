import { ChevronDown, ChevronRight, Info, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type {
  ProviderNoticeDetail,
  ProviderNoticeTone,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { useChatMeasuredBooleanToggle } from "@/components/chat/chat-measured-item-change-context";
import { LivePulse } from "@/components/ui/live-pulse";
import { cn } from "@/lib/utils";

interface ProviderNoticeSegmentProps {
  status: "streaming" | "completed" | "errored";
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
  const { status, tone, title, message, details, findUnitId } = props;
  const isStreaming = status === "streaming";
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useChatMeasuredBooleanToggle(setExpanded);

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
        </div>
      ) : null}
    </div>
  );
}
