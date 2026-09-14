import { useState } from "react";
import { AlarmClockCheck } from "lucide-react";
import type { ProviderNoticeDetail } from "@traycer/protocol/persistence/epic/content-blocks";
import { Button } from "@/components/ui/button";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { SegmentCard } from "@/components/chat/segments/segment-card";
import { FALLBACK_SETTINGS_LABEL } from "./fallback-copy";
import { useOpenFallbackSettings } from "./open-fallback-settings";

/**
 * The "Fallback settings" link inside a fallback notice's expanded details.
 *
 * Its own component, and mounted only for a fallback notice that is actually
 * expanded, because it reads `useTabHostId()` - which THROWS outside
 * `<TabHostProvider>`. Every notice in a transcript would otherwise pay that
 * read, and the several suites that render segments without a tab provider
 * would fail on a Codex reroute notice that has nothing to do with fallback.
 *
 * There is deliberately no action beside it. A historical notice must not
 * re-dispatch: "Switch elsewhere…" was designed here and removed, because a row
 * describing something that already happened is the worst place to start
 * something new - the user reading it is looking backwards, and the chat may be
 * many turns past the state the row describes.
 */
export function FallbackNoticeSettingsLink() {
  const openFallbackSettings = useOpenFallbackSettings(useTabHostId());
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-auto self-start px-1 py-0 text-ui-xs text-muted-foreground"
      onClick={openFallbackSettings}
    >
      {FALLBACK_SETTINGS_LABEL}
    </Button>
  );
}

/**
 * The marker at the head of a turn that a fallback WAIT resumed.
 *
 * Rendered in the autonomous-resume marker's shape (`SegmentCard`, the same
 * clock-check glyph a wakeup trigger carries) rather than as a divider-rule
 * notice, and the reason is what the row is FOR: this turn had no user message.
 * Something the user did not do woke the agent, and the transcript's existing
 * answer to "why is the agent talking" is the resume marker. A hairline notice
 * between two assistant messages does not read as a cause.
 *
 * It is not the `AutonomousResumeSegment` component itself: that renders
 * `AutonomousResumeTrigger`s - a different wire shape, with output files and
 * managed-command doors behind them - and a wait has none of those. What it
 * has is the notice's own detail pairs, which is what the body shows.
 */
export function FallbackWaitResumedMarker({
  title,
  message,
  details,
  findUnitId,
}: {
  readonly title: string;
  readonly message: string | null;
  readonly details: ReadonlyArray<ProviderNoticeDetail>;
  readonly findUnitId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const header = (
    <>
      <AlarmClockCheck
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground/85">
        {title}
      </span>
    </>
  );
  const preview =
    message === null || message.length === 0 ? null : (
      <p className="m-0 line-clamp-2 text-ui-sm leading-6 text-foreground/85">
        {message}
      </p>
    );
  return (
    <div className="w-full max-w-[min(100%,48rem)]">
      <SegmentCard
        open={open}
        onOpenChange={setOpen}
        header={header}
        headerAction={null}
        collapsedPreview={preview}
        body={
          open ? (
            <div className="flex flex-col gap-2">
              <FallbackNoticeDetailList details={details} />
              <FallbackNoticeSettingsLink />
            </div>
          ) : null
        }
        tone="default"
        headerPosition="normal"
        bodyOverflow="hidden"
        headerFindUnitId={findUnitId}
        bodyFindUnitId={null}
        // Collapsed to a static row when the host sent no facts to reveal:
        // an expander that opens onto a settings link alone is a control that
        // lies about having content.
        expandable={details.length > 0}
        className={undefined}
      />
    </div>
  );
}

/**
 * The notice's label/value pairs, in the same shape the divider-rule notice
 * renders them - so a wait that resumed and a switch that applied describe
 * themselves identically, and only their frame differs.
 */
export function FallbackNoticeDetailList({
  details,
}: {
  readonly details: ReadonlyArray<ProviderNoticeDetail>;
}) {
  return (
    <dl className="m-0 flex flex-col gap-1 text-ui-xs">
      {details.map((detail) => (
        <div key={`${detail.label}:${detail.value}`} className="flex gap-2">
          <dt className="shrink-0 font-medium text-muted-foreground">
            {detail.label}
          </dt>
          <dd className="m-0 min-w-0 flex-1 text-foreground/85">
            {detail.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
