import { useRef } from "react";
import { Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppearanceAsset } from "@/hooks/appearance/use-appearance-assets";
import { cn } from "@/lib/utils";
import {
  REPOSITORY_IDENTITY_COLORS,
  type RepoIdentityDraft,
  type RepositoryIcon,
} from "./use-repo-identity-draft";

/**
 * The identity block at the top of Repository settings: a 56 px preview tile,
 * the curated swatch row, and the icon controls. Presentation only - the draft
 * above owns the state and the write.
 */
export function RepoIdentityFields(props: {
  readonly draft: RepoIdentityDraft;
}) {
  const { draft } = props;
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="flex flex-col gap-2" data-testid="repo-identity-fields">
      <div className="flex items-center gap-4">
        <RepoIdentityTile draft={draft} />
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div
            role="group"
            aria-label="Repository color"
            className="flex flex-wrap items-center gap-2"
          >
            <ColorSwatch draft={draft} color={null} />
            {REPOSITORY_IDENTITY_COLORS.map((color) => (
              <ColorSwatch key={color} draft={draft} color={color} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Emoji"
              aria-invalid={draft.emojiInvalid}
              value={draft.emojiText}
              disabled={draft.disabled}
              maxLength={32}
              className="w-16 text-center"
              onChange={(event) => draft.setEmoji(event.currentTarget.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={draft.disabled || draft.busy}
              onClick={() => fileRef.current?.click()}
            >
              Upload logo…
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              aria-hidden
              tabIndex={-1}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null;
                event.currentTarget.value = "";
                if (file !== null) draft.chooseLogo(file);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={draft.disabled || draft.values.icon === null}
              onClick={draft.clearIcon}
            >
              None
            </Button>
          </div>
          <p className="text-ui-xs text-muted-foreground">
            Shows on this repo&apos;s tabs and in the workspace picker.
            Committed with the repo.
          </p>
        </div>
      </div>
      {draft.emojiInvalid ? (
        <p role="alert" className="text-ui-xs text-destructive">
          Enter one emoji.
        </p>
      ) : null}
      {draft.imageError !== null ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {draft.imageError}
        </p>
      ) : null}
      {draft.note !== null ? (
        <p className="text-ui-xs text-muted-foreground">{draft.note}</p>
      ) : null}
    </div>
  );
}

function RepoIdentityTile(props: { readonly draft: RepoIdentityDraft }) {
  const { draft } = props;
  const icon = draft.values.icon;
  const asset = useAppearanceAsset({
    scope: draft.scope,
    path:
      draft.localLogoUrl === null && icon?.kind === "image" ? icon.path : null,
    rejected: false,
    focused: true,
    refreshKey: draft.assetRefreshKey,
  });
  const logoUrl = draft.localLogoUrl ?? asset.url;
  const color = draft.values.color;
  return (
    <div
      data-testid="repo-identity-tile"
      className={cn(
        "flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/60 text-2xl leading-none",
        // A logo carries its own colour, so the tint would fight it: the tile
        // stays neutral whenever one is shown.
        (logoUrl !== null || color === null) && "bg-foreground/5",
      )}
      style={
        logoUrl === null && color !== null
          ? {
              backgroundColor: `color-mix(in srgb, ${color} 18%, var(--color-background))`,
            }
          : undefined
      }
    >
      <IdentityTileGlyph logoUrl={logoUrl} icon={icon} />
    </div>
  );
}

function IdentityTileGlyph(props: {
  readonly logoUrl: string | null;
  readonly icon: RepositoryIcon | null;
}) {
  const { logoUrl, icon } = props;
  if (logoUrl !== null)
    return (
      <img src={logoUrl} alt="" className="size-full object-contain p-1.5" />
    );
  if (icon?.kind === "emoji") return <span aria-hidden>{icon.value}</span>;
  return <Folder className="size-5 text-muted-foreground" aria-hidden />;
}

function ColorSwatch(props: {
  readonly draft: RepoIdentityDraft;
  readonly color: string | null;
}) {
  const { draft, color } = props;
  const selected = draft.values.color === color;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={color === null ? "No color" : `Color ${color}`}
      disabled={draft.disabled}
      onClick={() => draft.setColor(color)}
      className={cn(
        "size-5.5 shrink-0 rounded-full border-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "border-foreground" : "border-transparent",
        color === null && !selected && "border-border",
      )}
      style={
        color === null
          ? {
              backgroundImage:
                "linear-gradient(135deg, transparent 45%, var(--color-muted-foreground) 45%, var(--color-muted-foreground) 55%, transparent 55%)",
            }
          : { backgroundColor: color }
      }
    />
  );
}
