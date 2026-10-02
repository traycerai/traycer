import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { ProfileCopyTone } from "@/lib/profile-copy/profile-copy-presentation";

const TONE_VARIANT = {
  success: "success",
  warning: "warning",
  info: "info",
  destructive: "destructive",
  muted: "muted",
} as const satisfies Record<ProfileCopyTone, string>;

export function ProfileCopyBadge(props: {
  readonly tone: ProfileCopyTone;
  readonly label: string;
}): ReactNode {
  return (
    <Badge variant={TONE_VARIANT[props.tone]} size="xs" className="shrink-0">
      {props.label}
    </Badge>
  );
}
