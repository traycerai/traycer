import * as React from "react";
import { Avatar as AvatarPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * The shape of an avatar's picture, as the clip of its picture layer (the
 * image and the initials): a person is a circle and a bot a squircle, so a
 * glance at a row says which wrote it. The root carries the clip as
 * `--avatar-clip` and is not clipped itself, so a corner badge and a
 * group's ring outside the picture are not cut.
 */
const CIRCLE_CLIP = "circle(50%)";

/**
 * A rounded square whose sides run straight into the corners, in the clip
 * path's bounding-box units, so one path serves every size.
 */
const SQUIRCLE_PATH =
  "M .5 0 C .92 0 1 .08 1 .5 C 1 .92 .92 1 .5 1 C .08 1 0 .92 0 .5 C 0 .08 .08 0 .5 0 Z";

function Avatar({
  className,
  size = "default",
  shape = "circle",
  children,
  style,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  size?: "default" | "sm" | "lg" | "xs";
  shape?: "circle" | "squircle";
}) {
  const reactId = React.useId();
  const clipId = `avatar-squircle-${reactId.replace(/[^\w-]/g, "")}`;
  const squircle = shape === "squircle";
  const clip = squircle ? `url("#${clipId}")` : CIRCLE_CLIP;
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      data-shape={shape}
      className={cn(
        "group/avatar relative flex size-8 shrink-0 select-none data-[size=lg]:size-10 data-[size=sm]:size-6 data-[size=xs]:size-4",
        // A squircle has no radius to draw its edge or a group's ring
        // with: its ring is a plate of the page behind it, clipped to
        // the same shape a little larger.
        squircle
          ? "isolate"
          : "rounded-full after:absolute after:inset-0 after:rounded-full after:border after:border-border after:mix-blend-darken dark:after:mix-blend-lighten",
        className,
      )}
      style={{ "--avatar-clip": clip, ...style } as React.CSSProperties}
      {...props}
    >
      {squircle ? <SquircleClip id={clipId} /> : null}
      {children}
    </AvatarPrimitive.Root>
  );
}

/** The squircle's clip path, beside the picture it clips, and its group ring. */
function SquircleClip(props: { readonly id: string }) {
  return (
    <>
      <svg
        aria-hidden="true"
        focusable="false"
        className="pointer-events-none absolute size-0 overflow-hidden"
      >
        <defs>
          <clipPath id={props.id} clipPathUnits="objectBoundingBox">
            <path d={SQUIRCLE_PATH} />
          </clipPath>
        </defs>
      </svg>
      <span
        aria-hidden="true"
        data-slot="avatar-ring"
        className="absolute -inset-0.5 -z-10 hidden bg-background [clip-path:var(--avatar-clip)] in-data-[slot=avatar-group]:block"
      />
    </>
  );
}

function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn(
        "aspect-square size-full object-cover [clip-path:var(--avatar-clip)]",
        className,
      )}
      {...props}
    />
  );
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        // `bg-foreground/8` per `ui/skeleton.tsx`: unlike the group-overflow
        // chip below, this fallback carries no ring, so on a dialog/popover
        // surface in a preset theme the initials used to float on nothing.
        "flex size-full items-center justify-center bg-foreground/8 text-ui-sm [clip-path:var(--avatar-clip)] text-muted-foreground group-data-[size=sm]/avatar:text-ui-xs group-data-[size=xs]/avatar:text-micro",
        className,
      )}
      {...props}
    />
  );
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground bg-blend-color ring-2 ring-background select-none",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Overlapping avatars, each on a ring of the page behind it, so the one in
 * front reads over the one it covers: a circle's ring is its outline, a
 * squircle draws its own plate (`SquircleClip`).
 */
function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "group/avatar-group flex -space-x-2 has-data-[size=xs]:-space-x-1 *:data-[shape=circle]:ring-2 *:data-[shape=circle]:ring-background",
        className,
      )}
      {...props}
    />
  );
}

function AvatarGroupCount({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-ui-sm text-muted-foreground ring-2 ring-background group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 group-has-data-[size=sm]/avatar-group:text-ui-xs group-has-data-[size=xs]/avatar-group:size-4 group-has-data-[size=xs]/avatar-group:text-micro [&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
        className,
      )}
      {...props}
    />
  );
}

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarBadge,
};
