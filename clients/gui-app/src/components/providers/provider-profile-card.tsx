import { useId, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Eye, EyeOff, Pencil, X } from "lucide-react";
import type {
  ProviderCliState,
  ProviderProfile,
  ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRenameProviderProfile } from "@/hooks/providers/use-rename-provider-profile-mutation";
import { useRecolorProviderProfile } from "@/hooks/providers/use-recolor-provider-profile-mutation";
import { redactEmail } from "@/lib/providers/redact-email";
import {
  profileAuthStatusText,
  profileDisplayLabel,
} from "@/components/providers/provider-profile-model";
import { AccentColorSwatchGrid } from "@/components/providers/accent-color-swatch-grid";

interface ProviderProfileCardProps {
  readonly providerId: ProviderCliState["providerId"];
  readonly profile: ProviderProfile;
  readonly profiles: readonly ProviderProfile[];
}

export function ProviderProfileCard({
  providerId,
  profile,
  profiles,
}: ProviderProfileCardProps): ReactNode {
  const [emailRevealed, setEmailRevealed] = useState(false);

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-ui-base font-medium text-foreground">
            {profileDisplayLabel(profile)}
          </div>
        </div>
        <ProfileCardIdentityLine
          profile={profile}
          emailRevealed={emailRevealed}
          setEmailRevealed={setEmailRevealed}
        />
      </div>

      {/* Keyed by profileId so switching to a different profile discards any
       *  in-progress name edit / optimistic color pick via a fresh mount,
       *  instead of a render-phase resync that would also clobber unsaved
       *  edits on unrelated profile refreshes (e.g. a recolor's refetch). */}
      <ProviderProfileCardEditor
        key={profile.profileId}
        providerId={providerId}
        profile={profile}
        profiles={profiles}
      />

      <div className="flex flex-wrap items-center gap-1.5 text-ui-xs text-muted-foreground">
        <span>Status:</span>
        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
          {profileAuthStatusText(profile)}
        </Badge>
      </div>
    </div>
  );
}

function ProviderProfileCardEditor({
  providerId,
  profile,
  profiles,
}: {
  readonly providerId: ProviderCliState["providerId"];
  readonly profile: ProviderProfile;
  readonly profiles: readonly ProviderProfile[];
}): ReactNode {
  const labelInputId = useId();
  const [nameEditing, setNameEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState(profile.label);
  const [optimisticColor, setOptimisticColor] =
    useState<ProviderProfileAccentColor | null>(null);
  const renameProfile = useRenameProviderProfile();
  const recolorProfile = useRecolorProviderProfile();

  if (optimisticColor !== null && optimisticColor === profile.accentColor) {
    setOptimisticColor(null);
  }

  const editable = profile.kind === "managed";
  const selectedColor = optimisticColor ?? profile.accentColor;
  const trimmedLabel = labelDraft.trim();
  const duplicateColorProfile =
    selectedColor === null
      ? undefined
      : profiles.find(
          (candidate) =>
            candidate.profileId !== profile.profileId &&
            candidate.accentColor === selectedColor,
        );
  const busy = renameProfile.isPending || recolorProfile.isPending;

  const saveName = (): void => {
    if (!editable || busy) return;
    if (trimmedLabel.length === 0 || trimmedLabel === profile.label) {
      setLabelDraft(profile.label);
      setNameEditing(false);
      return;
    }
    renameProfile.mutate(
      {
        providerId,
        profileId: profile.profileId,
        label: trimmedLabel,
      },
      { onSuccess: () => setNameEditing(false) },
    );
  };

  const chooseColor = (accentColor: ProviderProfileAccentColor): void => {
    if (!editable || recolorProfile.isPending) return;
    setOptimisticColor(accentColor);
    if (accentColor === profile.accentColor) return;
    recolorProfile.mutate(
      {
        providerId,
        profileId: profile.profileId,
        accentColor,
      },
      {
        onSuccess: () => undefined,
        onError: () => setOptimisticColor(null),
      },
    );
  };

  return (
    <>
      {editable ? (
        <ProfileNameEditor
          inputId={labelInputId}
          profile={profile}
          label={labelDraft}
          trimmedLabel={trimmedLabel}
          editing={nameEditing}
          busy={busy}
          renamePending={renameProfile.isPending}
          onEdit={() => {
            setLabelDraft(profile.label);
            setNameEditing(true);
          }}
          onLabelChange={setLabelDraft}
          onSave={saveName}
          onCancel={() => {
            setLabelDraft(profile.label);
            setNameEditing(false);
          }}
        />
      ) : (
        <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-ui-xs text-muted-foreground">
          Terminal account mirrors the login already configured in this
          machine's shell. Rename, recolor, and remove are unavailable here.
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="text-ui-xs font-medium text-foreground">
          Accent color
        </div>
        <AccentColorSwatchGrid
          selectedColor={selectedColor}
          disabled={!editable || recolorProfile.isPending}
          onSelectColor={chooseColor}
        />
        {duplicateColorProfile !== undefined ? (
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-ui-xs text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {profileDisplayLabel(duplicateColorProfile)} already uses this
              color. You can keep it, but matching colors may be harder to scan.
            </span>
          </div>
        ) : null}
      </div>
    </>
  );
}

function ProfileNameEditor({
  inputId,
  profile,
  label,
  trimmedLabel,
  editing,
  busy,
  renamePending,
  onEdit,
  onLabelChange,
  onSave,
  onCancel,
}: {
  readonly inputId: string;
  readonly profile: ProviderProfile;
  readonly label: string;
  readonly trimmedLabel: string;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly renamePending: boolean;
  readonly onEdit: () => void;
  readonly onLabelChange: (label: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  if (!editing) {
    return (
      <div className="flex min-w-0 flex-col items-start gap-1">
        <div className="text-ui-xs font-medium text-muted-foreground">Name</div>
        <div className="inline-flex max-w-full items-center gap-1.5">
          <div className="min-w-0 truncate text-ui-sm text-foreground">
            {profileDisplayLabel(profile)}
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Edit name for ${profile.label}`}
            className="shrink-0"
            onClick={onEdit}
          >
            <Pencil />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <label
      htmlFor={inputId}
      className="flex flex-col gap-1.5 text-ui-xs font-medium text-foreground"
    >
      Name
      <div className="inline-flex max-w-full items-center gap-1.5">
        <Input
          id={inputId}
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSave();
            if (event.key === "Escape") onCancel();
          }}
          disabled={renamePending}
          className="w-[min(100%,22rem)]"
        />
        <Button
          type="button"
          size="icon-sm"
          variant="secondary"
          aria-label={`Save name for ${profile.label}`}
          disabled={
            busy || trimmedLabel.length === 0 || trimmedLabel === profile.label
          }
          onClick={onSave}
        >
          {renamePending ? <MutedAgentSpinner /> : <Check />}
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Cancel editing name for ${profile.label}`}
          disabled={renamePending}
          onClick={onCancel}
        >
          <X />
        </Button>
      </div>
    </label>
  );
}

function ProfileCardIdentityLine({
  profile,
  emailRevealed,
  setEmailRevealed,
}: {
  readonly profile: ProviderProfile;
  readonly emailRevealed: boolean;
  readonly setEmailRevealed: (value: boolean) => void;
}): ReactNode {
  const email = profile.identity?.email ?? null;
  const tier = profile.identity?.tier ?? null;
  const tierText = tier !== null && tier.length > 0 ? tier : null;
  let identityText = profileAuthFallbackLabel(profile);
  if (email !== null) {
    identityText = emailRevealed ? email : redactEmail(email);
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-ui-xs text-muted-foreground">
      <span className="min-w-0 truncate">{identityText}</span>
      {email !== null ? (
        <button
          type="button"
          aria-label={
            emailRevealed
              ? `Hide email for ${profileDisplayLabel(profile)}`
              : `Reveal email for ${profileDisplayLabel(profile)}`
          }
          aria-pressed={emailRevealed}
          className="rounded p-0.5 text-current opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          onClick={() => setEmailRevealed(!emailRevealed)}
        >
          {emailRevealed ? (
            <EyeOff className="size-3" />
          ) : (
            <Eye className="size-3" />
          )}
        </button>
      ) : null}
      {tierText !== null ? (
        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
          {tierText}
        </Badge>
      ) : null}
    </div>
  );
}

function profileAuthFallbackLabel(profile: ProviderProfile): string {
  if (profile.auth.status === "authenticated") {
    return profile.auth.label ?? "Authenticated";
  }
  return profileAuthStatusText(profile);
}
