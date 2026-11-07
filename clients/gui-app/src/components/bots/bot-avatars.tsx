import type { CSSProperties, ReactElement, ReactNode } from "react";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar";
import { computeInitials } from "@/lib/auth/compute-initials";
import {
  type BotSwatch,
  botSwatchAt,
  resolveBotSwatch,
  resolveProfileAccentColor,
} from "@/lib/providers/profile-accent-color";
import { useBotIdentity } from "@/components/bots/bot-identity-context";
import {
  type CreatureChoice,
  type CreatureMark,
  type CreatureMarkSize,
  chosenCreatureMark,
  creatureMark,
  drawCreatureMark,
} from "@/lib/bots/creature-mark";
import { useBotLook } from "@/hooks/bots/use-bot-appearance";
import { useBotPictureUrl } from "@/hooks/bots/use-bot-picture";

type IdentityAvatarSize = "xs" | "sm" | "default" | "lg";

const CREATURE_SIZE: Readonly<Record<IdentityAvatarSize, CreatureMarkSize>> = {
  xs: 16,
  sm: 24,
  default: 32,
  lg: 40,
};

/**
 * Who a picture is of, in a bot's channel and everywhere a bot appears:
 * a person is a circle, a bot a squircle. A bot is its creature mark on a
 * swatch, both from its id alone, so a rename changes neither, unless a
 * person chose another creature, a picture or a swatch in its settings. A
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
  return (
    <AvatarFrame
      kind="person"
      size={props.size}
      testId={props.testId}
      swatch={{
        color: resolveProfileAccentColor(props.seed, null),
        ink: "dark",
      }}
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
 * one derived from its id. An uploaded picture shows its creature on its
 * swatch until the image has loaded, and in its place if it cannot.
 */
function BotIdentityAvatar(props: {
  readonly botId: string;
  readonly size: IdentityAvatarSize;
  readonly testId: string;
}): ReactElement {
  const { botId, size, testId } = props;
  const look = useBotLook(botId);
  const mark = look?.appearance.mark ?? null;
  const swatchIndex = look?.appearance.swatch ?? null;
  const creature =
    mark?.kind === "creature"
      ? chosenCreatureMark(botId, { family: mark.family, seed: mark.seed })
      : creatureMark(botId);
  return (
    <AvatarFrame
      kind="bot"
      size={size}
      testId={testId}
      swatch={
        swatchIndex === null
          ? resolveBotSwatch(botId)
          : botSwatchAt(swatchIndex)
      }
      image={
        look !== null && mark?.kind === "picture" ? (
          <BotPictureImage
            botId={botId}
            trunkChatId={look.trunkChatId}
            hash={mark.blobRef}
          />
        ) : null
      }
    >
      <CreatureMarkSvg mark={creature} size={CREATURE_SIZE[size]} />
    </AvatarFrame>
  );
}

/** An uploaded picture, once its bytes have arrived. */
function BotPictureImage(props: {
  readonly botId: string;
  readonly trunkChatId: string;
  readonly hash: string;
}): ReactNode {
  const url = useBotPictureUrl(props.botId, props.trunkChatId, props.hash);
  return url === null ? null : <AvatarImage src={url} alt="" />;
}

/** The clipped picture: an image when there is one, over its fallback. */
function AvatarFrame(props: {
  readonly kind: "bot" | "person";
  readonly size: IdentityAvatarSize;
  readonly testId: string;
  readonly swatch: BotSwatch;
  readonly image: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  const { kind, size, testId, swatch } = props;
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
            "--swatch": swatch.color,
          } as CSSProperties
        }
        className={
          swatch.ink === "light"
            ? "bg-[var(--swatch)] font-semibold text-white"
            : "bg-[var(--swatch)] font-semibold text-neutral-950"
        }
      >
        {props.children}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * The creature in the swatch's ink (the fallback's text colour); its eyes are
 * holes, so the swatch shows through them. Drawn in whole pixels of the
 * avatar's own size, and scaled with it only where the root font is not 16px.
 */
function CreatureMarkSvg(props: {
  readonly mark: CreatureMark;
  readonly size: CreatureMarkSize;
}): ReactElement {
  const drawing = drawCreatureMark(props.mark, props.size);
  return (
    <svg
      viewBox={drawing.viewBox}
      aria-hidden="true"
      focusable="false"
      shapeRendering="crispEdges"
      className="size-full"
      data-slot="bot-creature"
    >
      <path d={drawing.path} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/**
 * One creature a bot's settings offer, on a swatch, as the bot would draw it
 * if chosen.
 */
export function BotCreaturePreview(props: {
  readonly botId: string;
  readonly choice: CreatureChoice;
  readonly swatch: BotSwatch;
  readonly size: IdentityAvatarSize;
}): ReactElement {
  return (
    <AvatarFrame
      kind="bot"
      size={props.size}
      testId="bot-creature-preview"
      swatch={props.swatch}
      image={null}
    >
      <CreatureMarkSvg
        mark={chosenCreatureMark(props.botId, props.choice)}
        size={CREATURE_SIZE[props.size]}
      />
    </AvatarFrame>
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
