import { useId, type CSSProperties, type ReactNode } from "react";
import { BOT_COLOR_LINE_UP } from "@traycer/protocol/host/bot/colors";
import {
  BOT_MASCOT_ACCESSORIES,
  BOT_MASCOT_EYEWEAR,
  type BotAppearance,
} from "@traycer/protocol/host/bot/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { BotMascotPreview } from "@/components/bots/bot-avatars";
import { BotSettingsRefusal } from "@/components/bots/bot-settings-group";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  creationColorOf,
  useBotIsMain,
  useBotLook,
} from "@/hooks/bots/use-bot-appearance";
import { useBotLookSaver } from "@/hooks/bots/use-bot-look-save";
import {
  MASCOT_SHAPES,
  botMascot,
  type MascotLook,
} from "@/lib/bots/mascot-mark";

/**
 * A part's name as its button reads it: "Blob", "Shades", "None". The
 * eyewear stored as `glasses` is drawn as wide eyes, and is named for that.
 */
function partName(part: string): string {
  if (part === "glasses") return "Wide eyes";
  return part.charAt(0).toUpperCase() + part.slice(1);
}

/**
 * A bot's icon, its colour and what it wears, in its channel settings, and
 * one reset that puts all four back as the bot started. Drawn where the
 * tab's host can change it; the rename authority decides who may.
 */
export function BotAppearanceSettings(props: {
  readonly botId: string;
}): ReactNode {
  const { botId } = props;
  const client = useTabHostClient();
  const hostId = useTabHostId();
  const saver = useBotLookSaver(client, hostId, botId);
  const look = useBotLook(botId);
  const main = useBotIsMain(botId);
  if (!saver.supported) return null;
  const appearance: BotAppearance = look ?? {
    mark: null,
    color: null,
    eyewear: null,
    accessory: null,
  };
  const change = saver.choose;
  const current = botMascot(botId, appearance, main);
  const asStarted =
    appearance.mark === null &&
    (appearance.eyewear ?? null) === null &&
    (appearance.accessory ?? null) === null &&
    appearance.color === creationColorOf(appearance);
  return (
    <>
      <div
        data-testid="bot-settings-avatar"
        className="flex items-center justify-between gap-2"
      >
        <BotMascotPreview mascot={current} size="default" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="bot-settings-avatar-reset"
          disabled={asStarted}
          onClick={() =>
            change({ mark: null, color: null, eyewear: null, accessory: null })
          }
        >
          Reset avatar
        </Button>
      </div>
      <MascotPartSection
        label="Icon"
        testId="bot-settings-icon"
        choiceTestId="bot-settings-icon-shape"
        options={MASCOT_SHAPES}
        chosen={current.shape}
        preview={(shape) => ({ ...current, shape })}
        pending={saver.saving("mark")}
        refusal={saver.refusal("mark")}
        onChange={(shape) => change({ mark: { kind: "mascot", shape } })}
      />
      <ColorSection
        label="Colour"
        testId="bot-settings-colour"
        chosen={appearance.color}
        pending={saver.saving("color")}
        refusal={saver.refusal("color")}
        onChange={(color) => change({ color })}
      />
      <MascotPartSection
        label="Eyewear"
        testId="bot-settings-eyewear"
        choiceTestId="bot-settings-eyewear"
        options={BOT_MASCOT_EYEWEAR}
        chosen={current.eyewear}
        preview={(eyewear) => ({ ...current, eyewear })}
        pending={saver.saving("eyewear")}
        refusal={saver.refusal("eyewear")}
        onChange={(eyewear) => change({ eyewear })}
      />
      <MascotPartSection
        label="Accessory"
        testId="bot-settings-accessory"
        choiceTestId="bot-settings-accessory"
        options={BOT_MASCOT_ACCESSORIES}
        chosen={current.accessory}
        preview={(accessory) => ({ ...current, accessory })}
        pending={saver.saving("accessory")}
        refusal={saver.refusal("accessory")}
        onChange={(accessory) => change({ accessory })}
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

/** A choice's frame: pressed when it is the current one. */
const CHOICE_CLASS =
  "rounded-md p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 aria-pressed:ring-2 aria-pressed:ring-foreground";

/**
 * One part of the mascot: every option drawn on the bot as it looks now,
 * the one it shows pressed.
 */
function MascotPartSection<Part extends string>(props: {
  readonly label: string;
  readonly testId: string;
  /** Each option's button is `<choiceTestId>-<option>`. */
  readonly choiceTestId: string;
  readonly options: readonly Part[];
  readonly chosen: Part;
  readonly preview: (option: Part) => MascotLook;
  readonly pending: boolean;
  readonly refusal: string | null;
  readonly onChange: (option: Part) => void;
}): ReactNode {
  const { options, chosen, preview, onChange, testId, choiceTestId } = props;
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
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-label={partName(option)}
            aria-pressed={option === chosen}
            className={CHOICE_CLASS}
            data-testid={`${choiceTestId}-${option}`}
            onClick={() => onChange(option)}
          >
            <BotMascotPreview mascot={preview(option)} size="default" />
          </button>
        ))}
      </div>
      <BotSettingsRefusal message={props.refusal} />
    </section>
  );
}

/** A row of the colours on offer; the bot's own pressed when it is one of them. */
function ColorSection(props: {
  readonly label: string;
  readonly testId: string;
  /** The bot's colour; one that is not on offer presses none. */
  readonly chosen: BotAppearance["color"];
  readonly pending: boolean;
  readonly refusal: string | null;
  readonly onChange: (color: string) => void;
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
        {BOT_COLOR_LINE_UP.map(({ name, hex }) => (
          <button
            key={hex}
            type="button"
            aria-label={name}
            aria-pressed={chosen === hex}
            className={CHOICE_CLASS}
            data-testid={`${testId}-${hex.slice(1)}`}
            onClick={() => onChange(hex)}
          >
            <span
              aria-hidden="true"
              className="block size-6 rounded-sm bg-(--choice-color)"
              style={{ "--choice-color": hex } as CSSProperties}
            />
          </button>
        ))}
      </div>
      <BotSettingsRefusal message={props.refusal} />
    </section>
  );
}
