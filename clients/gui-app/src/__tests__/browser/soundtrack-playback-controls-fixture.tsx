import { useEffect, useState, type ReactNode } from "react";
import { SoundtrackPlaybackControls } from "@/components/soundtrack/soundtrack-playback-controls";
import { SoundtrackPageControlsContext } from "@/components/soundtrack/soundtrack-page-controls-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { playbackTrack } from "@/lib/soundtrack/__tests__/playback-track";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";

/**
 * The music controls in the page placement, with the real component and the
 * real settings and soundtrack stores. Whether a title overflows its window,
 * whether it moves, and where the buttons stand are real layout and real CSS
 * animation, which jsdom cannot decide. The sounding track is set the way the
 * session's `onSounding` sets it (the Vitest suites drive that), so a track's
 * name and title are the only inputs.
 *
 * `__soundtrackControlsProbe` changes what the page is showing: the sounding
 * track, the pause, whether a Settings overlay owns the controls, and whether
 * the overlay's own group is drawn.
 */
declare global {
  interface Window {
    __soundtrackControlsProbe?: {
      readonly setTrack: (name: string, title: string) => void;
      readonly setPaused: (paused: boolean) => void;
      readonly setSettingsOverlay: (open: boolean) => void;
    };
  }
}

export function Fixture(): ReactNode {
  const [overlay, setOverlay] = useState(false);
  useEffect(() => {
    window.__soundtrackControlsProbe = {
      setTrack: (name, title) => {
        useSoundtrackStore.setState({
          soundingTrack: { ...playbackTrack(name, 60), title },
        });
      },
      setPaused: (paused) => {
        useSettingsStore.setState({ soundtrackPaused: paused });
      },
      setSettingsOverlay: setOverlay,
    };
  }, []);
  return (
    <TooltipProvider>
      <div data-testid="page" className="w-full">
        <SoundtrackPageControlsContext value={!overlay}>
          <SoundtrackPlaybackControls placement="surface" />
        </SoundtrackPageControlsContext>
        {overlay ? (
          <div data-testid="overlay">
            <SoundtrackPlaybackControls placement="settings-modal" />
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
