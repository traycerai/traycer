import {
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar";
import { computeInitials } from "@/lib/auth/compute-initials";
import { resolveProfileAccentColor } from "@/lib/providers/profile-accent-color";
import { useBotIdentity } from "@/components/bots/bot-identity-context";
import {
  MASCOT_AT_REST,
  MASCOT_WORKING_BEATS,
  type MascotExpression,
  type MascotLook,
  type MascotMarkSize,
  type MascotPose,
  botMascot,
  drawMascotMark,
} from "@/lib/bots/mascot-mark";
import {
  botExpressionOn,
  useBotActivityForHost,
} from "@/hooks/bots/use-bot-activity";
import { useBotIsMain, useBotLook } from "@/hooks/bots/use-bot-appearance";

type IdentityAvatarSize = "xs" | "sm" | "default" | "lg";

const MASCOT_SIZE: Readonly<Record<IdentityAvatarSize, MascotMarkSize>> = {
  xs: 16,
  sm: 24,
  default: 32,
  lg: 40,
};

/**
 * Who a picture is of, in a bot's channel and everywhere a bot appears:
 * a person is a circle, a bot its mascot with nothing behind it. Each part of
 * a bot's look comes from its id alone, so a rename changes
 * none, unless a person chose another in its settings. A
 * person without a picture shows their initials on a colour hashed from who
 * they are; the smallest size has room for one letter. The picture is
 * decoration beside the name, which every surface shows or labels its
 * control with.
 */
function IdentityAvatar(
  props: (
    | {
        readonly kind: "bot";
        readonly botId: string;
        readonly expression: MascotExpression;
      }
    | {
        readonly kind: "person";
        readonly name: string;
        /** What the colour is hashed from: the member's id. */
        readonly seed: string;
        readonly avatarUrl: string | null;
      }
  ) & {
    readonly size: IdentityAvatarSize;
    readonly testId: string;
  },
): ReactElement {
  if (props.kind === "bot") {
    return (
      <BotIdentityAvatar
        botId={props.botId}
        expression={props.expression}
        size={props.size}
        testId={props.testId}
      />
    );
  }
  const initials = computeInitials(props.name, "");
  const color = resolveProfileAccentColor(props.seed, null);
  return (
    <AvatarFrame
      size={props.size}
      testId={props.testId}
      fill={{ light: color, dark: color }}
      image={
        props.avatarUrl === null ? null : (
          <AvatarImage src={props.avatarUrl} alt="" />
        )
      }
    >
      {props.size === "xs" ? initials.slice(0, 1) : initials}
    </AvatarFrame>
  );
}

/**
 * A bot's picture: what its settings chose, each choice falling back to the
 * one derived from its id.
 */
function BotIdentityAvatar(props: {
  readonly botId: string;
  readonly expression: MascotExpression;
  readonly size: IdentityAvatarSize;
  readonly testId: string;
}): ReactElement {
  const { botId, expression, size, testId } = props;
  const look = useBotLook(botId);
  const main = useBotIsMain(botId);
  const beat = useWorkingBeat(expression === "working");
  return (
    <BotMascotFrame
      mascot={botMascot(botId, look, main)}
      pose={{ expression, beat }}
      size={size}
      testId={testId}
    />
  );
}

/** How long each beat of a working mascot's eyes lasts. */
const WORKING_BEAT_MS = 500;

/**
 * The one beat every working mascot on the page is on, so they move
 * together off a single timer, which runs only while one is drawn. It stays
 * on the first beat for a person who asks for reduced motion, from the
 * moment they ask.
 */
const workingBeat = {
  beat: 0,
  readers: new Set<() => void>(),
  timer: null as number | null,
  reduced: null as MediaQueryList | null,
};

function moveWorkingBeat(beat: number): void {
  workingBeat.beat = beat;
  for (const reader of workingBeat.readers) reader();
}

function followReducedMotion(): void {
  if (workingBeat.timer !== null) window.clearInterval(workingBeat.timer);
  workingBeat.timer = null;
  if (workingBeat.reduced?.matches === true) {
    moveWorkingBeat(0);
    return;
  }
  workingBeat.timer = window.setInterval(() => {
    moveWorkingBeat((workingBeat.beat + 1) % MASCOT_WORKING_BEATS);
  }, WORKING_BEAT_MS);
}

function readWorkingBeat(onBeat: () => void): () => void {
  workingBeat.readers.add(onBeat);
  if (workingBeat.readers.size === 1) {
    workingBeat.reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    workingBeat.reduced.addEventListener("change", followReducedMotion);
    followReducedMotion();
  }
  return () => {
    workingBeat.readers.delete(onBeat);
    if (workingBeat.readers.size > 0) return;
    workingBeat.reduced?.removeEventListener("change", followReducedMotion);
    workingBeat.reduced = null;
    if (workingBeat.timer !== null) window.clearInterval(workingBeat.timer);
    workingBeat.timer = null;
    workingBeat.beat = 0;
  };
}

const readNoBeat = (): (() => void) => () => undefined;

/** The beat a mascot's eyes are on: the shared one while `working`. */
function useWorkingBeat(working: boolean): number {
  return useSyncExternalStore(
    working ? readWorkingBeat : readNoBeat,
    () => (working ? workingBeat.beat : 0),
    () => 0,
  );
}

/**
 * A mascot in a bot's box, drawn straight on the page: no fill behind it and
 * no clip over it, so the figure's own outline is its shape.
 */
function BotMascotFrame(props: {
  readonly mascot: MascotLook;
  readonly pose: MascotPose;
  readonly size: IdentityAvatarSize;
  readonly testId: string;
}): ReactElement {
  const { mascot, pose, size, testId } = props;
  return (
    <Avatar
      shape="squircle"
      size={size}
      data-testid={testId}
      data-identity="bot"
    >
      <MascotMarkSvg mascot={mascot} pose={pose} size={MASCOT_SIZE[size]} />
    </Avatar>
  );
}

/**
 * A person's clipped picture: an image when there is one, over its fallback,
 * filled with one colour in each theme.
 */
function AvatarFrame(props: {
  readonly size: IdentityAvatarSize;
  readonly testId: string;
  readonly fill: { readonly light: string; readonly dark: string };
  readonly image: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  const { size, testId, fill } = props;
  return (
    <Avatar
      shape="circle"
      size={size}
      data-testid={testId}
      data-identity="person"
    >
      {props.image}
      <AvatarFallback
        style={
          {
            "--avatar-fill": fill.light,
            "--avatar-fill-dark": fill.dark,
          } as CSSProperties
        }
        className="bg-(--avatar-fill) font-semibold text-neutral-950 dark:bg-(--avatar-fill-dark)"
      >
        {props.children}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * The mascot, one path per colour, drawn in whole pixels of the avatar's own
 * size and scaled with it only where the root font is not 16px.
 */
function MascotMarkSvg(props: {
  readonly mascot: MascotLook;
  readonly pose: MascotPose;
  readonly size: MascotMarkSize;
}): ReactElement {
  const drawing = drawMascotMark(props.mascot, props.size, props.pose);
  return (
    <svg
      viewBox={drawing.viewBox}
      aria-hidden="true"
      focusable="false"
      shapeRendering="crispEdges"
      className="size-full"
      data-slot="bot-mascot"
    >
      {drawing.layers.map((layer) => (
        <path key={layer.fill} d={layer.path} fill={layer.fill} />
      ))}
    </svg>
  );
}

/**
 * One mascot a bot's settings offer, as the bot would draw it if chosen,
 * looking ahead.
 */
export function BotMascotPreview(props: {
  readonly mascot: MascotLook;
  readonly size: IdentityAvatarSize;
}): ReactElement {
  return (
    <BotMascotFrame
      mascot={props.mascot}
      pose={MASCOT_AT_REST}
      size={props.size}
      testId="bot-mascot-preview"
    />
  );
}

/**
 * The bot's picture: the surface's bot (`BotIdentityContext`) by its id, or
 * a plain bot outside one.
 */
export function BotAvatar(props: {
  readonly size: IdentityAvatarSize;
}): ReactElement {
  return <ExpressiveBotAvatar size={props.size} expression="idle" />;
}

/**
 * The surface's bot with its eyes on what it is doing: where a surface says
 * what the bot is doing now, beside that.
 */
export function ExpressiveBotAvatar(props: {
  readonly size: IdentityAvatarSize;
  readonly expression: MascotExpression;
}): ReactElement {
  const identity = useBotIdentity();
  return (
    <IdentityAvatar
      kind="bot"
      botId={identity?.botId ?? "bot"}
      expression={props.expression}
      size={props.size}
      testId="bot-avatar"
    />
  );
}

/**
 * A listed bot's picture with its eyes on what the bot is doing, as a
 * channel's row in the sidebar draws it. It reads the bot through `hostId`
 * on the subscription every other reader of that bot there shares.
 */
export function LiveBotAvatar(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly size: IdentityAvatarSize;
}): ReactElement {
  const activity = useBotActivityForHost(props.botId, props.hostId);
  return (
    <IdentityAvatar
      kind="bot"
      botId={props.botId}
      expression={botExpressionOn("row", activity)}
      size={props.size}
      testId="bot-avatar"
    />
  );
}

/**
 * A named bot's picture outside that bot's own surface, as a channel row in
 * the sidebar draws each bot it lists.
 */
export function NamedBotAvatar(props: {
  readonly botId: string;
  readonly size: IdentityAvatarSize;
}): ReactElement {
  return (
    <IdentityAvatar
      kind="bot"
      botId={props.botId}
      expression="idle"
      size={props.size}
      testId="bot-avatar"
    />
  );
}

/**
 * The one picture of a person in the app: their picture, else their initials
 * on the colour hashed from their id. Every surface shows or labels the name
 * beside it, so the picture itself is decoration.
 */
export function PersonAvatar(props: {
  readonly userId: string | null;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly size: IdentityAvatarSize;
}): ReactElement {
  return (
    <IdentityAvatar
      kind="person"
      name={props.name}
      seed={props.userId ?? props.name}
      avatarUrl={props.avatarUrl}
      size={props.size}
      testId="person-avatar"
    />
  );
}

/** One picture of a stack: a person or the bot. */
export type StackedIdentity =
  | {
      readonly kind: "person";
      readonly userId: string | null;
      readonly name: string;
      readonly avatarUrl: string | null;
    }
  | { readonly kind: "bot" };

/**
 * Overlapping pictures, each on a ring of the page behind it, the first
 * `max` of them and "+N" for the rest.
 */
export function AvatarStack(props: {
  readonly identities: ReadonlyArray<StackedIdentity>;
  readonly max: number;
  readonly size: "xs" | "sm" | "default";
  readonly label: string;
  readonly testId: string;
}): ReactElement | null {
  const { identities, max, size, label, testId } = props;
  if (identities.length === 0) return null;
  const shown = identities.slice(0, max);
  const rest = identities.length - shown.length;
  return (
    <AvatarGroup role="img" aria-label={label} data-testid={testId}>
      {shown.map((identity, index) =>
        identity.kind === "bot" ? (
          <BotAvatar key="bot" size={size} />
        ) : (
          <PersonAvatar
            // A stack never lists one person twice; the index keeps two
            // unnamed members apart.
            key={identity.userId ?? `member-${String(index)}`}
            userId={identity.userId}
            name={identity.name}
            avatarUrl={identity.avatarUrl}
            size={size}
          />
        ),
      )}
      {rest > 0 ? (
        <AvatarGroupCount data-testid={`${testId}-more`}>
          +{rest}
        </AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  );
}
