import { useEffect, useState, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { PromotableModalFrame } from "@/components/layout/dialogs/promotable-modal-frame";
import { Button } from "@/components/ui/button";
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
 *
 * `showStrip` mounts a title strip that carries the inline placements beside a
 * title and a button: `title-strip` in a plain row that declares the
 * `title-strip` container, `settings-modal` in the real modal frame's title
 * bar. `controls: false` mounts the same strip without them, as the baseline
 * for its height. `setStripWidth` sets the strip's width.
 */
declare global {
  interface Window {
    __soundtrackControlsProbe?: {
      readonly setTrack: (name: string, title: string) => void;
      readonly setPaused: (paused: boolean) => void;
      readonly setSettingsOverlay: (open: boolean) => void;
      readonly showStrip: (kind: StripKind | null, controls: boolean) => void;
      readonly setStripWidth: (px: number) => void;
    };
  }
}

type StripKind = "title-strip" | "settings-modal";

function TitleStrip(props: {
  readonly kind: StripKind;
  readonly controls: boolean;
}): ReactNode {
  const controls = props.controls ? (
    <SoundtrackPlaybackControls placement={props.kind} />
  ) : null;
  if (props.kind === "settings-modal") {
    return (
      <DialogPrimitive.Root open>
        <PromotableModalFrame
          icon={null}
          title="Settings"
          contentClassName="h-40 w-(--strip-width)"
          dataAttributes={{}}
          headerActions={controls}
          promoteAriaLabel="Open Settings as a tab"
          promoteTestId="promote"
          closeTestId="close"
          onPromote={() => undefined}
          onClose={() => undefined}
          onEscapeKeyDown={() => undefined}
          onOpenAutoFocus={undefined}
        >
          {null}
        </PromotableModalFrame>
      </DialogPrimitive.Root>
    );
  }
  return (
    <div
      data-testid="strip-row"
      className="@container/title-strip flex w-(--strip-width) items-center gap-2 border-b px-4 py-2"
    >
      <span>Channel</span>
      <span className="ml-auto flex min-w-0 items-center">{controls}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Search"
      />
    </div>
  );
}

export function Fixture(): ReactNode {
  const [overlay, setOverlay] = useState(false);
  const [strip, setStrip] = useState<{
    readonly kind: StripKind;
    readonly controls: boolean;
  } | null>(null);
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
      showStrip: (kind, controls) => {
        setStrip(kind === null ? null : { kind, controls });
      },
      setStripWidth: (px) => {
        document.documentElement.style.setProperty("--strip-width", `${px}px`);
      },
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
      {strip === null ? null : (
        <TitleStrip kind={strip.kind} controls={strip.controls} />
      )}
    </TooltipProvider>
  );
}
