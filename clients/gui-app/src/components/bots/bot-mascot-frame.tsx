import type { ReactElement } from "react";
import { Avatar } from "@/components/ui/avatar";
import {
  drawMascotMark,
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
