import type { ReactNode } from "react";
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
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

/**
 * Previous, Pause or Play, and Next in a task's status row, for a person who
 * asked for them in Settings › Sounds. They are drawn before a launch's first
 * gesture too, when pressing one is what opens the session, and not while this
 * window waits for another window's session to end.
 *
 * Unlike the row's other items these read no host, but they are as optional, so
 * they fail the same way.
 */
export function EpicPlaybackControls(): ReactNode {
  return (
    <StatusRowChromeBoundary label="playback controls">
      <EpicPlaybackControlsBody />
    </StatusRowChromeBoundary>
  );
}

function EpicPlaybackControlsBody(): ReactNode {
  const availability = useSettingsAvailabilityContext();
  const asked = useSettingsStore((state) => state.soundtrackPlaybackControls);
  const paused = useSettingsStore((state) => state.soundtrackPaused);
  const waiting = useSoundtrackStore((state) => state.waitingForLock);
  if (!isPlaybackControlsRowAvailable(availability) || !asked || waiting) {
    return null;
  }
  return (
    <div className="flex items-center gap-1.5">
      <PlaybackButton
        label="Previous track"
        testId="epic-playback-previous"
        icon={SkipBack}
        onClick={previousTrack}
        leavesShortRow
      />
      <PlaybackButton
        label={paused ? "Play" : "Pause"}
        testId="epic-playback-toggle"
        icon={paused ? Play : Pause}
        onClick={paused ? playMusic : pauseMusic}
        // Play is the way back to the music, so it stays for as long as there is
        // a row.
        leavesShortRow={!paused}
      />
      <PlaybackButton
        label="Next track"
        testId="epic-playback-next"
        icon={SkipForward}
        onClick={nextTrack}
        leavesShortRow
      />
    </div>
  );
}

function PlaybackButton(props: {
  readonly label: string;
  readonly testId: string;
  readonly icon: LucideIcon;
  readonly onClick: () => void;
  readonly leavesShortRow: boolean;
}): ReactNode {
  const { label, testId, icon: Icon, onClick, leavesShortRow } = props;
  return (
    <TooltipWrapper
      label={label}
      side="bottom"
      sideOffset={undefined}
      align="end"
    >
      <Button
        type="button"
        variant="muted"
        size="icon-xs"
        aria-label={label}
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
