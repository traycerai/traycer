import { Fragment, useEffect, useId, useRef, useState } from "react";
import { appearanceIconSchema } from "@traycer/protocol/host/workspace/appearance-schemas";
import { Folder, Pipette, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppearanceAsset } from "@/hooks/appearance/use-appearance-assets";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import {
  REPOSITORY_IDENTITY_COLORS,
  type RepoIdentityDraft,
  type RepositoryIcon,
} from "./use-repo-identity-draft";

/**
 * Repository appearance controls and a live preview. Presentation only - the draft
 * above owns the state and the write.
 */
export function RepoIdentityFields(props: {
  readonly draft: RepoIdentityDraft;
}) {
  const { draft } = props;
  const [choosingEmoji, setChoosingEmoji] = useState(false);
  const emojiTriggerRef = useRef<HTMLButtonElement>(null);
  const wasChoosingEmoji = useRef(false);
  const icon = draft.values.icon;
  const labels = ICON_LABELS[icon?.kind ?? "default"];
  useEffect(() => {
    if (!choosingEmoji && wasChoosingEmoji.current)
      emojiTriggerRef.current?.focus();
    wasChoosingEmoji.current = choosingEmoji;
  }, [choosingEmoji]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="flex flex-col gap-4" data-testid="repo-identity-fields">
      <h3 className="text-ui-sm font-semibold">Appearance</h3>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <p className="text-ui-xs font-medium">Repository icon</p>
          <div className="flex items-start gap-3">
            <RepoIdentityTile draft={draft} />
            <div className="min-w-0 flex-1 space-y-2">
              {choosingEmoji ? (
                <RepoEmojiEditor
                  draft={draft}
                  onClose={() => setChoosingEmoji(false)}
                />
              ) : (
                <>
                  <p className="text-ui-xs text-muted-foreground">
                    {labels.status}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={draft.disabled || draft.busy}
                      onClick={() => fileRef.current?.click()}
                    >
                      <Upload className="size-3.5" aria-hidden />
                      {labels.upload}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={draft.disabled || draft.busy}
                      ref={emojiTriggerRef}
                      onClick={() => setChoosingEmoji(true)}
                    >
                      {labels.emoji}
                    </Button>
                    {icon !== null ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={draft.disabled || draft.busy}
                        onClick={draft.clearIcon}
                      >
                        Remove icon
                      </Button>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
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
              if (file !== null) {
                draft.chooseLogo(file);
              }
            }}
          />
        </div>
        <div className="space-y-3">
          <p className="text-ui-xs font-medium">Tab color</p>
          <div
            role="group"
            aria-label="Repository color"
            className="flex flex-wrap items-center gap-1.5"
          >
            <ColorSwatch draft={draft} color={null} />
            {REPOSITORY_IDENTITY_COLORS.map((color, index) => (
              <Fragment key={color}>
                <ColorSwatch draft={draft} color={color} />
                {index === 0 ? <CustomColorSwatch draft={draft} /> : null}
              </Fragment>
            ))}
          </div>
        </div>
      </div>
      <p className="text-ui-xs text-muted-foreground">
        Shown in tabs and the workspace picker. Commit to share with your team.
      </p>
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

const ICON_LABELS = {
  image: {
    status: "Uploaded image",
    upload: "Replace image",
    emoji: "Use emoji",
  },
  emoji: {
    status: "Emoji icon",
    upload: "Upload image",
    emoji: "Change emoji",
  },
  default: {
    status: "Default folder",
    upload: "Upload image",
    emoji: "Use emoji",
  },
};

function RepoEmojiEditor({
  draft,
  onClose,
}: {
  readonly draft: RepoIdentityDraft;
  readonly onClose: () => void;
}) {
  const emojiId = useId();
  const emojiRef = useRef<HTMLInputElement>(null);
  const [emojiChoice, setEmojiChoice] = useState(
    draft.values.icon?.kind === "emoji" ? draft.values.icon.value : "",
  );
  const validEmoji = appearanceIconSchema.safeParse({
    kind: "emoji",
    value: emojiChoice.trim(),
  }).success;
  useEffect(() => {
    emojiRef.current?.focus();
  }, []);
  return (
    <div className="space-y-3">
      <label htmlFor={emojiId} className="sr-only">
        Emoji
      </label>
      <Input
        ref={emojiRef}
        id={emojiId}
        placeholder="Type or paste an emoji"
        aria-invalid={emojiChoice.length > 0 && !validEmoji}
        value={emojiChoice}
        disabled={draft.disabled || draft.busy}
        maxLength={32}
        className="h-10 w-full border-foreground/20 bg-foreground/5 text-lg placeholder:text-ui-xs"
        onChange={(event) => setEmojiChoice(event.currentTarget.value)}
      />
      {emojiChoice.length > 0 && !validEmoji ? (
        <p role="alert" className="text-ui-xs text-destructive">
          Enter one emoji.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          disabled={draft.disabled || draft.busy || !validEmoji}
          onClick={() => {
            draft.setEmoji(emojiChoice.trim());
            onClose();
          }}
        >
          Use emoji
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
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

function CustomColorSwatch({ draft }: { readonly draft: RepoIdentityDraft }) {
  const color = draft.values.color;
  const selected =
    color !== null && !REPOSITORY_IDENTITY_COLORS.includes(color);
  return (
    <TooltipWrapper
      label="Custom tab color"
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <label
        className={cn(
          "relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 bg-clip-padding focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-popover",
          selected
            ? "border-popover ring-2 ring-foreground"
            : "border-transparent",
          draft.disabled && "opacity-50",
        )}
        style={
          selected
            ? { backgroundColor: color }
            : {
                backgroundImage:
                  "conic-gradient(#e5484d, #f5b000, #46a758, #0090ff, #7c6cf0, #e5484d)",
              }
        }
      >
        <Pipette className="size-3 text-white drop-shadow-sm" aria-hidden />
        <input
          type="color"
          aria-label="Custom tab color"
          value={color ?? "#0090ff"}
          disabled={draft.disabled}
          onChange={(event) => draft.setColor(event.currentTarget.value)}
          className="absolute inset-0 size-full min-w-0 cursor-pointer appearance-none rounded-full border-0 p-0 opacity-0 disabled:cursor-not-allowed"
        />
      </label>
    </TooltipWrapper>
  );
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
        "size-6 shrink-0 rounded-full border-2 outline-none ring-offset-2 ring-offset-popover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-popover ring-2 ring-foreground"
          : "border-transparent",
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
