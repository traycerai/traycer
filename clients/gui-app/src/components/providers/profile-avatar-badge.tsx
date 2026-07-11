import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { computeInitials } from "@/lib/auth/compute-initials";
import { resolveProfileAccentColor } from "@/lib/providers/profile-accent-color";

interface ProfileAvatarBadgeProps {
  readonly profileId: string;
  readonly label: string;
  readonly email: string | null;
  readonly accentColor: string | null;
  readonly size: "sm" | "default" | "lg";
  readonly className: string | undefined;
}

/**
 * Initials badge for a provider profile (subscription), colored with its
 * deterministic accent (`resolveProfileAccentColor`). Shared by the provider
 * picker rail and the chat profile-anchor display.
 */
export function ProfileAvatarBadge(props: ProfileAvatarBadgeProps) {
  const { profileId, label, email, accentColor, size, className } = props;
  const color = resolveProfileAccentColor(profileId, accentColor);
  const initials = computeInitials(label, email ?? "");
  return (
    <Avatar size={size} className={className}>
      <AvatarFallback
        style={{ backgroundColor: color }}
        className="font-semibold text-neutral-950"
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
