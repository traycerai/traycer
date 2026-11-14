import { useId, type CSSProperties, type ReactNode } from "react";
import {
  BOT_COLOR_COUNT,
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
import { useBotIsMain, useBotLook } from "@/hooks/bots/use-bot-appearance";
import { useBotLookSaver } from "@/hooks/bots/use-bot-look-save";
import {
  MASCOT_SHAPES,
  botMascot,
  type MascotLook,
} from "@/lib/bots/mascot-mark";
import { botColorAt } from "@/lib/providers/profile-accent-color";

/** The twelve hues' names, in the colours' order; the deep tones follow. */
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

function colorName(index: number): string {
  const hue = HUE_NAMES[index % HUE_NAMES.length] ?? "Colour";
  return index < HUE_NAMES.length ? hue : `Deep ${hue.toLowerCase()}`;
}

const COLORS: readonly number[] = Array.from(
  { length: BOT_COLOR_COUNT },
  (_, index) => index,
);

/** A part's name as its button reads it: "Blob", "Shades", "None". */
function partName(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1);
}

/**
 * A bot's icon, its colour, what it wears and its channel's background, in
 * its channel settings. Each part starts as the one the bot's id gives it.
 * Drawn where the tab's host can change it; the rename authority decides who may.
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
    background: null,
    eyewear: null,
    accessory: null,
  };
  const change = saver.choose;
  const current = botMascot(botId, appearance, main);
  return (
    <>
      <MascotPartSection
        label="Icon"
        testId="bot-settings-icon"
        choiceTestId="bot-settings-icon-shape"
        options={MASCOT_SHAPES}
        chosen={current.shape}
        isDefault={appearance.mark === null}
        preview={(shape) => ({ ...current, shape })}
        pending={saver.saving("mark")}
        refusal={saver.refusal("mark")}
        onChange={(shape) =>
          change({ mark: shape === null ? null : { kind: "mascot", shape } })
        }
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
        isDefault={(appearance.eyewear ?? null) === null}
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
        isDefault={(appearance.accessory ?? null) === null}
        preview={(accessory) => ({ ...current, accessory })}
        pending={saver.saving("accessory")}
        refusal={saver.refusal("accessory")}
        onChange={(accessory) => change({ accessory })}
      />
      <ColorSection
        label="Background"
        testId="bot-settings-background"
        chosen={appearance.background}
        pending={saver.saving("background")}
        refusal={saver.refusal("background")}
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

/**
 * One part of the mascot: every option drawn on the bot as it looks now, the
 * one it shows pressed, and "Use the default" for the one its id gives it.
 */
function MascotPartSection<Part extends string>(props: {
  readonly label: string;
  readonly testId: string;
  /** Each option's button is `<choiceTestId>-<option>`. */
  readonly choiceTestId: string;
  readonly options: readonly Part[];
  readonly chosen: Part;
  /** Whether nobody chose this part, so the bot's id decides it. */
  readonly isDefault: boolean;
  readonly preview: (option: Part) => MascotLook;
  readonly pending: boolean;
  readonly refusal: string | null;
  readonly onChange: (option: Part | null) => void;
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
      <div>
        <UseDefaultButton
          testId={`${testId}-default`}
          disabled={props.isDefault}
          onClick={() => onChange(null)}
        />
      </div>
      <BotSettingsRefusal message={props.refusal} />
    </section>
  );
}

/** A row of the colours, the chosen one pressed, and "Use the default". */
function ColorSection(props: {
  readonly label: string;
  readonly testId: string;
  /** The chosen colour; one this client cannot read presses none. */
  readonly chosen: BotAppearance["color"];
  readonly pending: boolean;
  readonly refusal: string | null;
  readonly onChange: (color: number | null) => void;
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
        {COLORS.map((index) => (
          <button
            key={index}
            type="button"
            aria-label={colorName(index)}
            aria-pressed={chosen === index}
            className={CHOICE_CLASS}
            data-testid={`${testId}-${String(index)}`}
            onClick={() => onChange(index)}
          >
            <span
              aria-hidden="true"
              className="block size-6 rounded-sm bg-(--choice-color)"
              style={{ "--choice-color": botColorAt(index) } as CSSProperties}
            />
          </button>
        ))}
      </div>
      <div>
        <UseDefaultButton
          testId={`${testId}-default`}
          disabled={chosen === null}
          onClick={() => onChange(null)}
        />
      </div>
      <BotSettingsRefusal message={props.refusal} />
    </section>
  );
}
