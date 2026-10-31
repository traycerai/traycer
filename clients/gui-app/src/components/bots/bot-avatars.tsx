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
  resolveBotSwatch,
  resolveProfileAccentColor,
} from "@/lib/providers/profile-accent-color";
import { useBotIdentity } from "@/components/bots/bot-identity-context";
import {
  type CreatureMarkSize,
  creatureMark,
  drawCreatureMark,
} from "@/lib/bots/creature-mark";

type IdentityAvatarSize = "xs" | "sm" | "default" | "lg";

const CREATURE_SIZE: Readonly<Record<IdentityAvatarSize, CreatureMarkSize>> = {
  xs: 16,
  sm: 24,
  default: 32,
  lg: 40,
};

/**
 * Who a picture is of, in a bot's channel and everywhere a bot appears
 * (Tracy Bots, T62): a person is a circle, a bot a squircle. A bot is its
 * creature mark (T111) on a swatch, both from its id alone, so a rename
 * changes neither. A person without a picture shows their initials on a
 * colour hashed from who they are; the smallest size has room for one
 * letter. The picture is decoration beside the name, which every surface
 * shows or labels its control with.
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
  const { size, testId } = props;
  let swatch: BotSwatch;
  let picture: ReactNode;
  if (props.kind === "bot") {
    swatch = resolveBotSwatch(props.botId);
    picture = (
      <CreatureMarkSvg botId={props.botId} size={CREATURE_SIZE[size]} />
    );
  } else {
    swatch = {
      color: resolveProfileAccentColor(props.seed, null),
      ink: "dark",
    };
    const initials = computeInitials(props.name, "");
    picture = size === "xs" ? initials.slice(0, 1) : initials;
  }
  return (
    <Avatar
      shape={props.kind === "bot" ? "squircle" : "circle"}
      size={size}
      data-testid={testId}
      data-identity={props.kind}
    >
      {props.kind === "person" && props.avatarUrl !== null ? (
        <AvatarImage src={props.avatarUrl} alt="" />
      ) : null}
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
        {picture}
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
  readonly botId: string;
  readonly size: CreatureMarkSize;
}): ReactElement {
  const drawing = drawCreatureMark(creatureMark(props.botId), props.size);
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

/** A person's picture: a member of a bot's environment, or its owner. */
export function MemberAvatar(props: {
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
      testId="chat-sender-avatar"
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
          <MemberAvatar
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
