import { use, useId, type ReactNode } from "react";
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useTabSurfaceActivity } from "@/components/layout/tab-surface-activity-hooks";
import { SoundtrackTitle } from "./soundtrack-title";
import { SoundtrackPageControlsContext } from "./soundtrack-page-controls-context";
import { StatusRowChromeBoundary } from "@/components/epic-canvas/panels/status-row-chrome-boundary";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import {
  nextTrack,
  pauseMusic,
  playMusic,
  previousTrack,
} from "@/lib/commands/actions/soundtrack";
import { isPlaybackControlsRowAvailable } from "@/lib/settings/settings-availability";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";

type PlaybackPlacement = "task" | "surface" | "settings-modal";

/** Window-wide playback actions, wherever the current page presents them. */
export function SoundtrackPlaybackControls(props: {
  readonly placement: PlaybackPlacement;
}): ReactNode {
  return (
    <StatusRowChromeBoundary label="playback controls">
      <SoundtrackPlaybackControlsBody placement={props.placement} />
    </StatusRowChromeBoundary>
  );
}

function SoundtrackPlaybackControlsBody(props: {
  readonly placement: PlaybackPlacement;
}): ReactNode {
  const pageControlsVisible = use(SoundtrackPageControlsContext);
  const activity = useTabSurfaceActivity();
  const availability = useSettingsAvailabilityContext();
  const asked = useSettingsStore((state) => state.soundtrackPlaybackControls);
  const waiting = useSoundtrackStore((state) => state.waitingForLock);
  const ownsSlot =
    props.placement === "settings-modal" ||
    (pageControlsVisible && activity.visible && activity.focused);
  if (
    !isPlaybackControlsRowAvailable(availability) ||
    !asked ||
    waiting ||
    !ownsSlot
  ) {
    return null;
  }
  return <PlaybackControlsContent placement={props.placement} />;
}

function PlaybackControlsContent(props: {
  readonly placement: PlaybackPlacement;
}): ReactNode {
  const task = props.placement === "task";
  const paused = useSettingsStore((state) => state.soundtrackPaused);
  const trackId = useId();
  const track = useSoundtrackStore((state) => state.soundingTrack);
  const trackTitle = track === null ? null : track.title.trim() || track.name;
  const trackKind =
    track?.kind === "composed" ? "Composed" : "Generative variant";
  const trackDescription =
    track === null ? null : `${trackTitle} · ${trackKind}`;
  const describedBy = trackDescription === null ? undefined : trackId;
  return (
    <div
      role="group"
      aria-label="Music playback"
      className={cn(
        "flex min-w-0 items-center gap-1.5",
        task
          ? "max-w-1/2"
          : "@container h-10 w-full shrink-0 justify-end px-3 max-md:hidden",
      )}
    >
      {trackDescription === null ? null : (
        <span
          id={trackId}
          data-testid="epic-playback-track"
          className={cn(
            "w-40 min-w-0 shrink text-xs leading-tight text-muted-foreground",
            task && "@max-[46rem]:sr-only",
          )}
        >
          <SoundtrackTitle
            key={track?.name}
            title={trackTitle ?? ""}
            paused={paused}
          />
          <span className="sr-only"> · </span>
          <span className="block truncate">{trackKind}</span>
        </span>
      )}
      <PlaybackButton
        trackDescription={trackDescription}
        describedBy={describedBy}
        label="Previous track"
        testId="epic-playback-previous"
        icon={SkipBack}
        onClick={previousTrack}
        leavesShortRow={task}
      />
      <PlaybackButton
        trackDescription={trackDescription}
        describedBy={describedBy}
        label={paused ? "Play" : "Pause"}
        testId="epic-playback-toggle"
        icon={paused ? Play : Pause}
        onClick={paused ? playMusic : pauseMusic}
        // Play is the way back to the music, so it stays for as long as there is
        // a row.
        leavesShortRow={task ? !paused : false}
      />
      <PlaybackButton
        trackDescription={trackDescription}
        describedBy={describedBy}
        label="Next track"
        testId="epic-playback-next"
        icon={SkipForward}
        onClick={nextTrack}
        leavesShortRow={task}
      />
    </div>
  );
}

function PlaybackButton(props: {
  readonly trackDescription: string | null;
  readonly describedBy: string | undefined;
  readonly label: string;
  readonly testId: string;
  readonly icon: LucideIcon;
  readonly onClick: () => void;
  readonly leavesShortRow: boolean;
}): ReactNode {
  const { label, testId, icon: Icon, onClick, leavesShortRow } = props;
  return (
    <TooltipWrapper
      label={
        props.trackDescription === null
          ? label
          : `${label} · ${props.trackDescription}`
      }
      side="bottom"
      sideOffset={undefined}
      align="end"
    >
      <Button
        type="button"
        variant="muted"
        size="icon-xs"
        aria-label={label}
        aria-describedby={props.describedBy}
        data-testid={testId}
        onClick={onClick}
        // 34rem of content is the row at its fullest: the pill's longest label
        // and every other item beside these. The row keeps one shape whatever the
        // pill is saying, so the buttons leave below that and do not come and go
        // with it.
        className={cn(leavesShortRow && "@max-[34rem]:hidden")}
      >
        <Icon className="size-3.5" />
      </Button>
    </TooltipWrapper>
  );
}
