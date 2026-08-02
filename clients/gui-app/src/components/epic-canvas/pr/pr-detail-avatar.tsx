import type { ReactNode } from "react";
import type { PrActor } from "@traycer/protocol/host/pr-schemas";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * A GitHub actor's avatar for the PR detail surfaces. Falls back to the
 * login's initial when the actor is unknown or the avatar image is absent
 * or fails to load (e.g. blocked remote images) - radix swaps in the
 * fallback on load error, so a broken URL degrades to the initial too.
 *
 * `isolate` bounds the primitive's `after:mix-blend-*` border to the avatar's
 * own opaque circle. Without it every avatar's blend makes the surrounding
 * scroll contents its compositing backdrop, and a timeline full of avatars
 * inside one tall scroller blows Chromium's tile memory budget ("tile memory
 * limits exceeded" spam + undrawn content after scrolling).
 */
export function PrActorAvatar(props: {
  readonly actor: PrActor | null;
  readonly size: "default" | "sm" | "lg";
  readonly className: string | undefined;
}): ReactNode {
  const login = props.actor?.login ?? "";
  return (
    <Avatar
      size={props.size}
      className={cn("isolate bg-background", props.className)}
    >
      {props.actor !== null && props.actor.avatarUrl !== null ? (
        <AvatarImage src={props.actor.avatarUrl} alt={props.actor.login} />
      ) : null}
      <AvatarFallback>
        {login.length === 0 ? "?" : login.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
