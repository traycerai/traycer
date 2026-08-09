import type { ReactNode } from "react";
import type { ProjectProfile } from "@/lib/profiles/types";
import { cn } from "@/lib/utils";
import { profileColorHex, profileIcon } from "./profile-options";

export interface ProjectProfileBadgeProps {
  readonly profile: ProjectProfile;
  readonly className: string | undefined;
  readonly trailing: ReactNode | undefined;
}

export function ProjectProfileBadge(
  props: ProjectProfileBadgeProps,
): ReactNode {
  const Icon = profileIcon(props.profile.icon);
  const color = profileColorHex(props.profile.color);

  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5",
        props.className,
      )}
      data-testid="project-profile-badge"
    >
      <Icon
        className="size-3.5 shrink-0"
        style={{ color }}
        aria-hidden
      />
      <span className="min-w-0 truncate text-ui-sm">{props.profile.name}</span>
      {props.trailing}
    </span>
  );
}
