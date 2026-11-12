import type { CSSProperties, ReactElement, ReactNode } from "react";
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
  type MascotLook,
  type MascotMarkSize,
  botMascot,
  drawMascotMark,
} from "@/lib/bots/mascot-mark";
import { useBotLook } from "@/hooks/bots/use-bot-appearance";

type IdentityAvatarSize = "xs" | "sm" | "default" | "lg";

const MASCOT_SIZE: Readonly<Record<IdentityAvatarSize, MascotMarkSize>> = {
  xs: 16,
  sm: 24,
  default: 32,
  lg: 40,
};

/**
 * Who a picture is of, in a bot's channel and everywhere a bot appears:
 * a person is a circle, a bot a squircle. A bot is its mascot on a tile of
 * its hue, shape and colour from its id alone, so a rename changes neither,
 * unless a person chose another shape or colour in its settings. A
 * person without a picture shows their initials on a colour hashed from who
 * they are; the smallest size has room for one letter. The picture is
 * decoration beside the name, which every surface shows or labels its
 * control with.
 */
function IdentityAvatar(
  props: (
    | { readonly kind: "bot"; readonly botId: string }
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
        size={props.size}
        testId={props.testId}
      />
    );
  }
  const initials = computeInitials(props.name, "");
  const color = resolveProfileAccentColor(props.seed, null);
  return (
    <AvatarFrame
      kind="person"
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
  readonly size: IdentityAvatarSize;
  readonly testId: string;
}): ReactElement {
  const { botId, size, testId } = props;
  const look = useBotLook(botId);
  return (
    <BotMascotFrame
      mascot={botMascot(botId, look)}
      size={size}
      testId={testId}
    />
  );
}

/** A mascot on its tile, in a bot's squircle. */
function BotMascotFrame(props: {
  readonly mascot: MascotLook;
  readonly size: IdentityAvatarSize;
  readonly testId: string;
}): ReactElement {
  const { mascot, size, testId } = props;
  return (
    <AvatarFrame
      kind="bot"
      size={size}
      testId={testId}
      fill={mascot.ramp.tile}
      image={null}
    >
      <MascotMarkSvg mascot={mascot} size={MASCOT_SIZE[size]} />
    </AvatarFrame>
  );
}

/**
 * The clipped picture: an image when there is one, over its fallback, filled
 * with one colour in each theme.
 */
function AvatarFrame(props: {
  readonly kind: "bot" | "person";
  readonly size: IdentityAvatarSize;
  readonly testId: string;
  readonly fill: { readonly light: string; readonly dark: string };
  readonly image: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  const { kind, size, testId, fill } = props;
  return (
    <Avatar
      shape={kind === "bot" ? "squircle" : "circle"}
      size={size}
      data-testid={testId}
      data-identity={kind}
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
  readonly size: MascotMarkSize;
}): ReactElement {
  const drawing = drawMascotMark(props.mascot, props.size);
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
 * One mascot a bot's settings offer, on its tile, as the bot would draw it
 * if chosen.
 */
export function BotMascotPreview(props: {
  readonly mascot: MascotLook;
  readonly size: IdentityAvatarSize;
}): ReactElement {
  return (
    <BotMascotFrame
      mascot={props.mascot}
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
  const identity = useBotIdentity();
  return (
    <IdentityAvatar
      kind="bot"
      botId={identity?.botId ?? "bot"}
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
