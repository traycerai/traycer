import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { APP_NOTIFICATIONS } from "@/components/settings/panels/app-notifications-settings.definitions";
import { SettingsRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { runnerMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import {
  isRecordingLimitId,
  isRecordingQuality,
  RECORDING_LIMITS,
  type RecordingLimitId,
  type RecordingQuality,
} from "@/lib/soundtrack/recording";
import { desktopRecordingChannel } from "@/lib/soundtrack/recording-bridge";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  useSoundtrackStore,
  type SoundtrackRecording,
} from "@/stores/soundtrack/soundtrack-store";

const LIMIT_LABELS: Readonly<Record<RecordingLimitId, string>> = {
  "30-minutes": "30 minutes",
  "1-hour": "1 hour",
  "2-hours": "2 hours",
  "until-off": "When I turn it off",
};

const LIMIT_IDS: readonly RecordingLimitId[] = [
  "30-minutes",
  "1-hour",
  "2-hours",
  "until-off",
];

const QUALITY_LABELS: Readonly<Record<RecordingQuality, string>> = {
  compressed: "Compressed",
  lossless: "Lossless",
};

const QUALITIES: readonly RecordingQuality[] = ["compressed", "lossless"];

const ROWS = APP_NOTIFICATIONS.definitions;

/** 12:40 under an hour, 1:00:00 from one up. */
function clockText(seconds: number): string {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secondsText = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${secondsText}`
    : `${String(minutes)}:${secondsText}`;
}

function stoppedEarly(problem: "disk" | "error", seconds: number): string {
  const why =
    problem === "disk"
      ? "the disk could not take more"
      : "the recording ran into a problem";
  return `Stopped at ${clockText(seconds)}: ${why}.`;
}

function SavedStatus(props: {
  readonly recording: Extract<SoundtrackRecording, { kind: "saved" }>;
}): ReactNode {
  const { recording } = props;
  const reveal = useMutation({
    mutationKey: runnerMutationKeys.revealSoundtrackRecording(),
    mutationFn: (recordingId: string): Promise<boolean> => {
      const channel = desktopRecordingChannel();
      return channel === null
        ? Promise.resolve(false)
        : channel.reveal(recordingId);
    },
    onError: (error) => {
      toastFromRunnerError(error, "Couldn't show the recording");
    },
  });
  const saved = `Saved ${recording.name}, ${clockText(recording.durationSeconds)}.`;
  return (
    <>
      {recording.problem === null
        ? saved
        : `${stoppedEarly(recording.problem, recording.durationSeconds)} ${saved}`}{" "}
      <Button
        variant="link"
        size="inline"
        disabled={reveal.isPending}
        onClick={() => {
          reveal.mutate(recording.recordingId);
        }}
      >
        Show in folder
      </Button>
    </>
  );
}

/** How the music stands, which is what the line says while nothing records. */
interface MusicSituation {
  readonly on: boolean;
  readonly waitingForLock: boolean;
  readonly paused: boolean;
  readonly sessionOpen: boolean;
}

/**
 * The live line in place of the description; undefined keeps the description.
 */
function recordingStatus(
  recording: SoundtrackRecording,
  music: MusicSituation,
): ReactNode {
  switch (recording.kind) {
    case "off":
      if (!music.on) return "Turn on Music to record.";
      if (music.waitingForLock) {
        return "Another window is playing the music. Record from that window.";
      }
      return music.paused && !music.sessionOpen
        ? "Music is paused. Play it to record."
        : undefined;
    case "recording": {
      const lead = music.paused ? "Recording paused" : "Recording";
      const elapsed = clockText(recording.elapsedSeconds);
      return recording.limitSeconds === null
        ? `${lead}, ${elapsed}.`
        : `${lead}, ${elapsed} of ${clockText(recording.limitSeconds)}.`;
    }
    case "saving":
      return "Saving…";
    case "saved":
      return <SavedStatus recording={recording} />;
    case "failed":
      return "Could not record. Nothing was saved.";
  }
}

function Choice(props: {
  readonly label: string;
  readonly description: string | null;
  readonly control: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="font-medium text-foreground">{props.label}</div>
        {props.description === null ? null : (
          <p className="text-ui-sm text-muted-foreground">
            {props.description}
          </p>
        )}
      </div>
      {props.control}
    </div>
  );
}

/**
 * Records this window's music to the desktop's folder: the audio, and beside it
 * a log of what changed it and why. The length and quality are kept; the
 * recording itself is not, so every start of the app finds it off. While it
 * records, the choices hold still and the line counts the time.
 */
export function SoundtrackRecordingRow(): ReactNode {
  const musicOn = useSettingsStore((state) => state.soundtrackEnabled);
  const paused = useSettingsStore((state) => state.soundtrackPaused);
  const limit = useSettingsStore((state) => state.soundtrackRecordingLimit);
  const setLimit = useSettingsStore(
    (state) => state.setSoundtrackRecordingLimit,
  );
  const quality = useSettingsStore((state) => state.soundtrackRecordingQuality);
  const setQuality = useSettingsStore(
    (state) => state.setSoundtrackRecordingQuality,
  );
  const sessionOpen = useSoundtrackStore((state) => state.enabled);
  const waitingForLock = useSoundtrackStore((state) => state.waitingForLock);
  const recording = useSoundtrackStore((state) => state.recording);
  const startRecording = useSoundtrackStore((state) => state.startRecording);
  const stopRecording = useSoundtrackStore((state) => state.stopRecording);
  const busy = recording.kind === "recording" || recording.kind === "saving";
  const switchable =
    recording.kind === "recording" || (!busy && musicOn && sessionOpen);
  return (
    <SettingsRow
      row={ROWS.soundtrackRecording}
      status={recordingStatus(recording, {
        on: musicOn,
        waitingForLock,
        paused,
        sessionOpen,
      })}
      control={
        <Switch
          checked={recording.kind === "recording"}
          disabled={!switchable}
          aria-label={ROWS.soundtrackRecording.label}
          onCheckedChange={(on) => {
            if (!on) {
              stopRecording();
              return;
            }
            startRecording({ limitSeconds: RECORDING_LIMITS[limit], quality });
          }}
        />
      }
      details={
        <div className="flex flex-col gap-3 pl-3">
          <Choice
            label={ROWS.soundtrackRecordingLimit.label}
            description={ROWS.soundtrackRecordingLimit.description}
            control={
              <Select
                value={limit}
                disabled={busy}
                onValueChange={(next) => {
                  if (isRecordingLimitId(next)) setLimit(next);
                }}
              >
                <SelectTrigger
                  className="w-[min(50vw,13rem)]"
                  aria-label={ROWS.soundtrackRecordingLimit.label}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LIMIT_IDS.map((id) => (
                    <SelectItem key={id} value={id}>
                      {LIMIT_LABELS[id]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <Choice
            label={ROWS.soundtrackRecordingQuality.label}
            description={ROWS.soundtrackRecordingQuality.description}
            control={
              <Select
                value={quality}
                disabled={busy}
                onValueChange={(next) => {
                  if (isRecordingQuality(next)) setQuality(next);
                }}
              >
                <SelectTrigger
                  className="w-[min(50vw,13rem)]"
                  aria-label={ROWS.soundtrackRecordingQuality.label}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUALITIES.map((id) => (
                    <SelectItem key={id} value={id}>
                      {QUALITY_LABELS[id]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </div>
      }
    />
  );
}
