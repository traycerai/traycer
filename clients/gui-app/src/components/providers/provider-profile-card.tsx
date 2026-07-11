import { useId, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type {
  ProviderProfile,
  ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import { Input } from "@/components/ui/input";
import { profileDisplayLabel } from "@/components/providers/provider-profile-model";
import { AccentColorSwatchGrid } from "@/components/providers/accent-color-swatch-grid";

interface ProviderProfileCardProps {
  readonly profile: ProviderProfile | null;
  readonly profiles: readonly ProviderProfile[];
  readonly label: string;
  readonly onLabelChange: (label: string) => void;
  readonly selectedColor: ProviderProfileAccentColor | null;
  readonly onSelectColor: (color: ProviderProfileAccentColor) => void;
  readonly disabled: boolean;
}

/**
 * The edit-profile form body. Mutations and save orchestration live at the
 * dialog boundary so name and color commit together from one footer action.
 */
export function ProviderProfileCard({
  profile,
  profiles,
  label,
  onLabelChange,
  selectedColor,
  onSelectColor,
  disabled,
}: ProviderProfileCardProps): ReactNode {
  const labelInputId = useId();
  const duplicateColorProfile =
    selectedColor === null
      ? undefined
      : profiles.find(
          (candidate) =>
            candidate.profileId !== profile?.profileId &&
            candidate.accentColor === selectedColor,
        );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <label
        htmlFor={labelInputId}
        className="flex flex-col gap-2 text-ui-sm font-medium text-foreground"
      >
        Profile name
        <Input
          id={labelInputId}
          value={label}
          maxLength={64}
          disabled={disabled}
          onChange={(event) => onLabelChange(event.target.value)}
        />
      </label>

      <div className="flex flex-col gap-2.5">
        <div className="text-ui-sm font-medium text-foreground">
          Accent color
        </div>
        <AccentColorSwatchGrid
          selectedColor={selectedColor}
          disabled={disabled}
          onSelectColor={onSelectColor}
        />
        {duplicateColorProfile !== undefined ? (
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2.5 text-ui-xs text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {profileDisplayLabel(duplicateColorProfile)} already uses this
              color. You can keep it, but matching colors may be harder to scan.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
