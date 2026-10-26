import type { CSSProperties, ReactElement } from "react";
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

type IdentityAvatarSize = "xs" | "sm" | "default" | "lg";

/**
 * Who a picture is of, in a bot's channel and everywhere a bot appears
 * (Tracy Bots, T62): a person is a circle, a bot a squircle. Without a
 * picture it shows the initials on a colour hashed from who it is (the
 * profile badges' palette), so two members with no picture still tell apart
 * at a glance; the smallest size has room for one letter.
 */
function IdentityAvatar(props: {
  readonly kind: "bot" | "person";
  readonly name: string;
  /** What the colour is hashed from: the bot's or the member's id. */
  readonly seed: string;
  readonly avatarUrl: string | null;
  readonly size: IdentityAvatarSize;
  readonly testId: string;
}): ReactElement {
  const { kind, name, seed, avatarUrl, size, testId } = props;
  const initials = computeInitials(name, "");
  return (
    <Avatar
      shape={kind === "bot" ? "squircle" : "circle"}
      size={size}
      data-testid={testId}
      data-identity={kind}
    >
      {avatarUrl === null ? null : <AvatarImage src={avatarUrl} alt="" />}
      <AvatarFallback
        style={
          {
            "--swatch": resolveProfileAccentColor(seed, null),
          } as CSSProperties
        }
        className="bg-[var(--swatch)] font-semibold text-neutral-950"
      >
        {size === "xs" ? initials.slice(0, 1) : initials}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * The bot's picture: the surface's bot (`BotIdentityContext`) by its id and
 * current title, or a plain bot outside one.
 */
export function BotAvatar(props: {
  readonly size: IdentityAvatarSize;
}): ReactElement {
  const identity = useBotIdentity();
  return (
    <IdentityAvatar
      kind="bot"
      name={identity?.title ?? "Bot"}
      seed={identity?.botId ?? "bot"}
      avatarUrl={null}
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
  readonly title: string;
  readonly size: IdentityAvatarSize;
}): ReactElement {
  return (
    <IdentityAvatar
      kind="bot"
      name={props.title}
      seed={props.botId}
      avatarUrl={null}
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
