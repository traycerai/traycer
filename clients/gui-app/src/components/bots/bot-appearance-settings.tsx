import {
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  BOT_SWATCH_COUNT,
  type BotAppearance,
  type BotAppearanceMark,
  type BotUpdateAppearanceRequest,
} from "@traycer/protocol/host/bot/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  BotCreaturePreview,
  NamedBotAvatar,
} from "@/components/bots/bot-avatars";
import { BotSettingsRefusal } from "@/components/bots/bot-settings-group";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useBotLook } from "@/hooks/bots/use-bot-appearance";
import {
  useBotPicturePutMutation,
  useBotUpdateAppearanceMutation,
} from "@/hooks/bots/use-bot-mutations";
import { type CreatureChoice, creatureSheet } from "@/lib/bots/creature-mark";
import { prepareBotPicture } from "@/lib/bots/bot-picture";
import { bytesToBase64Async } from "@/lib/composer/image-base64";
import {
  botSwatchAt,
  derivedBotSwatchIndex,
} from "@/lib/providers/profile-accent-color";

/** The twelve hues' names, in the swatches' order; the deep tones follow. */
const HUE_NAMES: readonly string[] = [
  "Red",
  "Orange",
  "Amber",
  "Lime",
  "Emerald",
  "Teal",
  "Cyan",
  "Blue",
  "Violet",
  "Purple",
  "Fuchsia",
  "Pink",
];

function swatchName(index: number): string {
  const hue = HUE_NAMES[index % HUE_NAMES.length] ?? "Colour";
  return index < HUE_NAMES.length ? hue : `Deep ${hue.toLowerCase()}`;
}

const SWATCHES: readonly number[] = Array.from(
  { length: BOT_SWATCH_COUNT },
  (_, index) => index,
);

/** Which of the three a write changes, read off its request. */
type AppearanceField = "mark" | "swatch" | "background";

function fieldOf(request: BotUpdateAppearanceRequest): AppearanceField | null {
  if (request.mark !== undefined) return "mark";
  if (request.swatch !== undefined) return "swatch";
  if (request.background !== undefined) return "background";
  return null;
}

function sameChoice(
  mark: BotAppearanceMark | null,
  choice: CreatureChoice,
): boolean {
  return (
    mark?.kind === "creature" &&
    mark.family === choice.family &&
    mark.seed === choice.seed
  );
}

/**
 * A bot's look, in its channel settings: its icon (a creature from its own
 * sheet, or a picture of the person's), the colour its icon sits on, and the
 * background of its channel. Each starts on the look the bot's id gives it,
 * and "Use the default" brings that back. Drawn where the tab's host can
 * change it; the rename authority decides who may.
 */
export function BotAppearanceSettings(props: {
  readonly botId: string;
}): ReactNode {
  const { botId } = props;
  const client = useTabHostClient();
  const hostId = useTabHostId();
  const supported =
    useHostMethodSupport(hostId, "bot.updateAppearance") === true;
  const picturesSupported =
    useHostMethodSupport(hostId, "drafts.putBlob") === true;
  const update = useBotUpdateAppearanceMutation(client);
  const look = useBotLook(botId);
  if (!supported) return null;
  const appearance: BotAppearance = look?.appearance ?? {
    mark: null,
    swatch: null,
    background: null,
  };
  const pending = update.isPending ? fieldOf(update.variables) : null;
  const failed = update.isError ? fieldOf(update.variables) : null;
  const refusal = (field: AppearanceField): string | null =>
    failed === field && update.error !== null ? update.error.message : null;
  const change = (request: Omit<BotUpdateAppearanceRequest, "botId">): void =>
    update.mutate({ botId, ...request });
  return (
    <>
      <BotIconSection
        botId={botId}
        mark={appearance.mark}
        swatch={appearance.swatch ?? derivedBotSwatchIndex(botId)}
        pending={pending === "mark"}
        disabled={update.isPending}
        refusal={refusal("mark")}
        picturesSupported={picturesSupported}
        onChange={(mark) => change({ mark })}
      />
      <SwatchSection
        label="Colour"
        testId="bot-settings-colour"
        chosen={appearance.swatch}
        pending={pending === "swatch"}
        disabled={update.isPending}
        refusal={refusal("swatch")}
        onChange={(swatch) => change({ swatch })}
      />
      <SwatchSection
        label="Background"
        testId="bot-settings-background"
        chosen={appearance.background}
        pending={pending === "background"}
        disabled={update.isPending}
        refusal={refusal("background")}
        onChange={(background) => change({ background })}
      />
    </>
  );
}

/** A section's label, with the write's dots while it is under way. */
function SectionLabel(props: {
  readonly id: string;
  readonly label: string;
  readonly pending: boolean;
}): ReactNode {
  return (
    <span
      id={props.id}
      className="flex items-center gap-1 text-ui-sm font-medium text-foreground"
    >
      {props.label}
      {props.pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
    </span>
  );
}

function UseDefaultButton(props: {
  readonly testId: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      data-testid={props.testId}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      Use the default
    </Button>
  );
}

/** A choice's frame: pressed when it is the current one. */
const CHOICE_CLASS =
  "rounded-md p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 aria-pressed:ring-2 aria-pressed:ring-foreground";

function BotIconSection(props: {
  readonly botId: string;
  readonly mark: BotAppearanceMark | null;
  /** The swatch the icon draws on now, chosen or the bot's own. */
  readonly swatch: number;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly refusal: string | null;
  readonly picturesSupported: boolean;
  readonly onChange: (mark: BotAppearanceMark | null) => void;
}): ReactNode {
  const { botId, mark, onChange } = props;
  const labelId = useId();
  const sheet = useMemo(() => creatureSheet(botId), [botId]);
  const swatch = botSwatchAt(props.swatch);
  return (
    <section
      aria-labelledby={labelId}
      data-testid="bot-settings-icon"
      className="flex flex-col gap-2"
    >
      <SectionLabel id={labelId} label="Icon" pending={props.pending} />
      <div
        role="group"
        aria-labelledby={labelId}
        className="flex flex-wrap gap-1.5"
      >
        {mark?.kind === "picture" ? (
          <button
            type="button"
            aria-label="Your picture"
            aria-pressed
            className={CHOICE_CLASS}
            data-testid="bot-settings-icon-picture"
            disabled={props.disabled}
          >
            <NamedBotAvatar botId={botId} size="default" />
          </button>
        ) : null}
        {sheet.map((choice, index) => (
          <button
            key={choice.seed}
            type="button"
            aria-label={`Creature ${String(index + 1)}`}
            aria-pressed={
              sameChoice(mark, choice) || (mark === null && index === 0)
            }
            className={CHOICE_CLASS}
            data-testid={`bot-settings-icon-creature-${String(index)}`}
            disabled={props.disabled}
            onClick={() =>
              onChange({
                kind: "creature",
                family: choice.family,
                seed: choice.seed,
              })
            }
          >
            <BotCreaturePreview
              botId={botId}
              choice={choice}
              swatch={swatch}
              size="default"
            />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {props.picturesSupported ? (
          <BotPictureUpload
            botId={botId}
            disabled={props.disabled}
            onUploaded={(blobRef) => onChange({ kind: "picture", blobRef })}
          />
        ) : null}
        <UseDefaultButton
          testId="bot-settings-icon-default"
          disabled={props.disabled || mark === null}
          onClick={() => onChange(null)}
        />
      </div>
      <BotSettingsRefusal message={props.refusal} />
    </section>
  );
}

/**
 * "Upload a picture": the person's image, cropped to a square and scaled to
 * the largest avatar, put on the tab's host before the bot's icon names it.
 */
function BotPictureUpload(props: {
  readonly botId: string;
  readonly disabled: boolean;
  readonly onUploaded: (blobRef: string) => void;
}): ReactNode {
  const client = useTabHostClient();
  const put = useBotPicturePutMutation(client);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const choose = async (file: File): Promise<void> => {
    setUnreadable(false);
    const picture = await prepareBotPicture(file);
    if (picture === null) {
      setUnreadable(true);
      return;
    }
    const bytesBase64 = await bytesToBase64Async(picture.bytes);
    put.mutate(
      { sha256: picture.sha256, bytesBase64 },
      {
        onSuccess: (response) => {
          if (response.ok) props.onUploaded(picture.sha256);
          else setUnreadable(true);
        },
      },
    );
  };
  const refusal = pictureRefusal(unreadable, put.error);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="bot-settings-icon-upload"
          disabled={props.disabled || put.isPending}
          onClick={() => inputRef.current?.click()}
        >
          Upload a picture
          {put.isPending ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
        <span className="text-ui-xs text-muted-foreground">
          Any image. It&apos;s cropped to a square.
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        data-testid="bot-settings-icon-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file !== undefined) void choose(file);
        }}
      />
      <BotSettingsRefusal message={refusal} />
    </div>
  );
}

/** Why the picture did not reach the host, when it did not. */
function pictureRefusal(
  unreadable: boolean,
  error: Error | null,
): string | null {
  if (unreadable) return "Couldn't read that image.";
  return error === null ? null : error.message;
}

/** A row of the swatches, the chosen one pressed, and "Use the default". */
function SwatchSection(props: {
  readonly label: string;
  readonly testId: string;
  readonly chosen: number | null;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly refusal: string | null;
  readonly onChange: (swatch: number | null) => void;
}): ReactNode {
  const { chosen, onChange, testId } = props;
  const labelId = useId();
  return (
    <section
      aria-labelledby={labelId}
      data-testid={testId}
      className="flex flex-col gap-2"
    >
      <SectionLabel id={labelId} label={props.label} pending={props.pending} />
      <div
        role="group"
        aria-labelledby={labelId}
        className="flex flex-wrap gap-1.5"
      >
        {SWATCHES.map((index) => (
          <button
            key={index}
            type="button"
            aria-label={swatchName(index)}
            aria-pressed={chosen === index}
            className={CHOICE_CLASS}
            data-testid={`${testId}-${String(index)}`}
            disabled={props.disabled}
            onClick={() => onChange(index)}
          >
            <span
              aria-hidden="true"
              className="block size-6 rounded-sm bg-(--swatch)"
              style={{ "--swatch": botSwatchAt(index).color } as CSSProperties}
            />
          </button>
        ))}
      </div>
      <div>
        <UseDefaultButton
          testId={`${testId}-default`}
          disabled={props.disabled || chosen === null}
          onClick={() => onChange(null)}
        />
      </div>
      <BotSettingsRefusal message={props.refusal} />
    </section>
  );
}
