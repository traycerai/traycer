import { useId, type CSSProperties, type ReactNode } from "react";
import {
  BOT_MASCOT_SHAPES,
  BOT_COLOR_COUNT,
  type BotAppearance,
  type BotAppearanceMark,
  type BotMascotShape,
  type BotUpdateAppearanceRequest,
} from "@traycer/protocol/host/bot/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { BotMascotPreview } from "@/components/bots/bot-avatars";
import { BotSettingsRefusal } from "@/components/bots/bot-settings-group";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useBotLook } from "@/hooks/bots/use-bot-appearance";
import { useBotUpdateAppearanceMutation } from "@/hooks/bots/use-bot-mutations";
import { botMascot } from "@/lib/bots/mascot-mark";
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

/** Which of the three a write changes, read off its request. */
type AppearanceField = "mark" | "color" | "background";

function fieldOf(request: BotUpdateAppearanceRequest): AppearanceField | null {
  if (request.mark !== undefined) return "mark";
  if (request.color !== undefined) return "color";
  if (request.background !== undefined) return "background";
  return null;
}

/** A shape's name as its button reads it: "Blob", "Capsule". */
function shapeName(shape: BotMascotShape): string {
  return shape.charAt(0).toUpperCase() + shape.slice(1);
}

/**
 * A bot's icon, icon colour and channel background, in its channel settings.
 * Drawn where the tab's host can change it; the rename authority decides who may.
 */
export function BotAppearanceSettings(props: {
  readonly botId: string;
}): ReactNode {
  const { botId } = props;
  const client = useTabHostClient();
  const hostId = useTabHostId();
  const supported =
    useHostMethodSupport(hostId, "bot.updateAppearance") === true;
  const update = useBotUpdateAppearanceMutation(client);
  const look = useBotLook(botId);
  if (!supported) return null;
  const appearance: BotAppearance = look ?? {
    mark: null,
    color: null,
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
        look={appearance}
        pending={pending === "mark"}
        disabled={update.isPending}
        refusal={refusal("mark")}
        onChange={(mark) => change({ mark })}
      />
      <ColorSection
        label="Colour"
        testId="bot-settings-colour"
        chosen={appearance.color}
        pending={pending === "color"}
        disabled={update.isPending}
        refusal={refusal("color")}
        onChange={(color) => change({ color })}
      />
      <ColorSection
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

/**
 * The icon: every shape, in the colour the bot shows now, the one it shows
 * pressed, and "Use the default" for the shape its id gives it.
 */
function BotIconSection(props: {
  readonly botId: string;
  readonly look: BotAppearance;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly refusal: string | null;
  readonly onChange: (mark: BotAppearanceMark | null) => void;
}): ReactNode {
  const { botId, look, onChange } = props;
  const labelId = useId();
  const current = botMascot(botId, look);
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
        {BOT_MASCOT_SHAPES.map((shape) => (
          <button
            key={shape}
            type="button"
            aria-label={shapeName(shape)}
            aria-pressed={shape === current.shape}
            className={CHOICE_CLASS}
            data-testid={`bot-settings-icon-shape-${shape}`}
            disabled={props.disabled}
            onClick={() => onChange({ kind: "mascot", shape })}
          >
            <BotMascotPreview
              mascot={{ shape, ramp: current.ramp }}
              size="default"
            />
          </button>
        ))}
      </div>
      <div>
        <UseDefaultButton
          testId="bot-settings-icon-default"
          disabled={props.disabled || look.mark === null}
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
  readonly disabled: boolean;
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
            disabled={props.disabled}
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
          disabled={props.disabled || chosen === null}
          onClick={() => onChange(null)}
        />
      </div>
      <BotSettingsRefusal message={props.refusal} />
    </section>
  );
}
