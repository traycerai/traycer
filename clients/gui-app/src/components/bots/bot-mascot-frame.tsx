import type { ReactElement } from "react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  drawMascotMark,
  type MascotExpression,
  type MascotLook,
  type MascotMarkSize,
  type MascotPose,
} from "@/lib/bots/mascot-mark";

export type IdentityAvatarSize = "xs" | "sm" | "default" | "lg";

const MASCOT_SIZE: Readonly<Record<IdentityAvatarSize, MascotMarkSize>> = {
  xs: 16,
  sm: 24,
  default: 32,
  lg: 40,
};

/**
 * A mascot in a bot's box, drawn straight on the page: no fill behind it and
 * no clip over it, so the figure's own outline is its shape.
 */
export function BotMascotFrame(props: {
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
 * A picture a bot wears in place of its mascot, cropped to the bot's box.
 * It has no eyes to say what the bot is doing, so the whole picture does:
 * grey and faded while the bot is away, and fading on every other beat while
 * it works. The beat stays on its first for a person who asks for reduced
 * motion, which holds the picture still.
 */
export function BotPictureFrame(props: {
  readonly src: string;
  readonly expression: MascotExpression;
  /** Whether a working bot's picture is on its faded beat. */
  readonly dimmed: boolean;
  readonly size: IdentityAvatarSize;
  readonly testId: string;
  /** Told when the picture cannot be drawn, so the caller draws the mascot. */
  readonly onError: () => void;
}): ReactElement {
  const { src, expression, dimmed, size, testId, onError } = props;
  return (
    <Avatar
      shape="squircle"
      size={size}
      data-testid={testId}
      data-identity="bot"
      data-expression={expression}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        data-slot="bot-picture"
        onError={onError}
        className={cn(
          "size-full object-cover motion-safe:transition-opacity motion-safe:duration-500 [clip-path:var(--avatar-clip)]",
          expression === "away" && "opacity-55 grayscale",
          expression === "working" && dimmed && "opacity-55",
        )}
      />
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
