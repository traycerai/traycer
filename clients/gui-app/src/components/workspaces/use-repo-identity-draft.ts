import { useEffect, useRef, useState } from "react";
import {
  appearanceIconSchema,
  type AppearanceUpload,
  type WorkspaceAppearance,
  type WorkspaceAppearanceRead,
} from "@traycer/protocol/host/workspace/appearance-schemas";
import {
  useWorkspaceAppearance,
  useWorkspaceSetAppearance,
} from "@/hooks/appearance/use-workspace-appearance";
import type { AppearanceScope } from "@/lib/appearance/appearance-cache";
import { prepareAppearanceImage } from "@/lib/appearance/appearance-image-preparation";
import { bytesToBase64 } from "@/lib/composer/image-base64";

export type RepositoryIcon = NonNullable<WorkspaceAppearance["icon"]>;

/**
 * The curated palette offered in the UI. The schema still accepts any
 * `#rrggbb`, so a hand-edited file keeps whatever colour it names - it simply
 * shows as "no swatch selected" here.
 */
export const REPOSITORY_IDENTITY_COLORS: readonly string[] = [
  "#e5484d",
  "#f76b15",
  "#f5b000",
  "#46a758",
  "#12a594",
  "#0090ff",
  "#7c6cf0",
  "#e93d82",
];

interface RepoIdentityValues {
  readonly color: string | null;
  readonly icon: RepositoryIcon | null;
}

interface LocalLogo {
  readonly path: string;
  readonly url: string;
  readonly upload: AppearanceUpload;
}

export interface RepoIdentityDraft {
  readonly values: RepoIdentityValues;
  readonly emojiText: string;
  readonly emojiInvalid: boolean;
  readonly imageError: string | null;
  /** One short line naming why this repo has no editable identity. */
  readonly note: string | null;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly changed: boolean;
  /** Object URL for a logo chosen in this session, before it is saved. */
  readonly localLogoUrl: string | null;
  readonly scope: AppearanceScope | null;
  readonly assetRefreshKey: number;
  readonly setColor: (color: string | null) => void;
  readonly setEmoji: (text: string) => void;
  readonly chooseLogo: (file: File) => void;
  readonly clearIcon: () => void;
  /** Resolves once the write succeeded; rejects so the dialog can stay open. */
  readonly save: () => Promise<unknown>;
}

function iconsEqual(
  left: RepositoryIcon | null,
  right: RepositoryIcon | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === "emoji")
    return right.kind === "emoji" && left.value === right.value;
  return right.kind === "image" && left.path === right.path;
}

function emojiIcon(value: string): RepositoryIcon | null {
  const candidate: RepositoryIcon = { kind: "emoji", value };
  return appearanceIconSchema.safeParse(candidate).success ? candidate : null;
}

function identityNote(
  read: WorkspaceAppearanceRead | null,
  supported: boolean,
): string | null {
  if (read?.status === "non-git")
    return "This folder isn't a Git repository, so it has no shared identity.";
  if (read?.status === "unavailable")
    return "This repository's source checkout is unavailable.";
  if (read?.status === "malformed")
    return "This repository's appearance is unreadable. Repair .traycer/environment.json to edit it.";
  if (!supported) return "This host is too old to store a repository identity.";
  return null;
}

function savedIdentityValues(
  read: WorkspaceAppearanceRead | null,
): RepoIdentityValues {
  const appearance = read?.appearance ?? null;
  return { color: appearance?.color ?? null, icon: appearance?.icon ?? null };
}

function identityChanged(
  draft: RepoIdentityValues | null,
  saved: RepoIdentityValues,
): boolean {
  if (draft === null) return false;
  return draft.color !== saved.color || !iconsEqual(draft.icon, saved.icon);
}

/** The typed text while editing, else whatever emoji the values carry. */
function emojiTextFor(
  values: RepoIdentityValues,
  emojiDraft: string | null,
): string {
  if (emojiDraft !== null) return emojiDraft;
  return values.icon?.kind === "emoji" ? values.icon.value : "";
}

/** The object URL, only while the values still point at the chosen logo. */
function localLogoUrlFor(
  values: RepoIdentityValues,
  logo: LocalLogo | null,
): string | null {
  if (logo === null || values.icon?.kind !== "image") return null;
  return values.icon.path === logo.path ? logo.url : null;
}

/**
 * Repository identity (colour + icon) for one source repo, seeded from the
 * committed `.traycer/environment.json` and written back to the repo's
 * CANONICAL source root - never a bound worktree's own file. The state lives
 * here rather than in the fields below so it survives the scripts editor's
 * re-seed remounts, and so the dialog's single Save can persist it alongside
 * the scripts.
 */
export function useRepoIdentityDraft(args: {
  readonly hostId: string | null;
  readonly workspacePath: string;
  readonly epicId: string;
}): RepoIdentityDraft {
  const read = useWorkspaceAppearance({
    hostId: args.hostId,
    workspacePath: args.workspacePath,
  });
  const mutation = useWorkspaceSetAppearance({ hostId: args.hostId });
  // `null` means "follow whatever is saved" - a late-landing read then shows
  // through without a re-seed effect, and only a real edit pins a draft.
  const [draft, setDraft] = useState<RepoIdentityValues | null>(null);
  const [emojiDraft, setEmojiDraft] = useState<string | null>(null);
  const [logo, setLogo] = useState<LocalLogo | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const prepareRef = useRef<AbortController | null>(null);

  const saved = savedIdentityValues(read.appearance);
  const values = draft ?? saved;
  const changed = identityChanged(draft, saved);
  const emojiText = emojiTextFor(values, emojiDraft);
  const trimmedEmoji = emojiText.trim();
  const emojiInvalid =
    trimmedEmoji.length > 0 && emojiIcon(trimmedEmoji) === null;
  const localLogoUrl = localLogoUrlFor(values, logo);

  const logoUrl = logo?.url ?? null;
  useEffect(() => {
    if (logoUrl === null) return;
    return () => URL.revokeObjectURL(logoUrl);
  }, [logoUrl]);
  useEffect(() => {
    const controller = prepareRef;
    return () => controller.current?.abort();
  }, []);

  const edit = (change: (previous: RepoIdentityValues) => RepoIdentityValues) =>
    setDraft((previous) => change(previous ?? saved));

  const chooseLogo = (file: File): void => {
    prepareRef.current?.abort();
    const controller = new AbortController();
    prepareRef.current = controller;
    setImageError(null);
    setBusy(true);
    void prepareAppearanceImage(file, controller.signal)
      .then(async (prepared) => {
        const mediaType = prepared.blob.type;
        if (
          mediaType !== "image/png" &&
          mediaType !== "image/jpeg" &&
          mediaType !== "image/webp"
        )
          throw new Error("Choose a PNG, JPEG, or WebP image.");
        const dataBase64 = bytesToBase64(
          new Uint8Array(await prepared.blob.arrayBuffer()),
        );
        controller.signal.throwIfAborted();
        setLogo({
          path: prepared.path,
          url: URL.createObjectURL(prepared.blob),
          upload: { mediaType, dataBase64 },
        });
        setEmojiDraft("");
        edit((previous) => ({
          ...previous,
          icon: { kind: "image", path: prepared.path },
        }));
        setBusy(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setBusy(false);
        setImageError(
          error instanceof Error
            ? error.message
            : "That image could not be read.",
        );
      });
  };

  const save = (): Promise<unknown> => {
    if (!changed) return Promise.resolve(undefined);
    // The host canonicalizes too, but naming the source root here keeps the
    // request honest about where a committed file is being written.
    const workspacePath =
      read.appearance?.canonicalSourceRoot ?? args.workspacePath;
    const uploading =
      logo !== null &&
      values.icon?.kind === "image" &&
      values.icon.path === logo.path;
    return mutation
      .mutateAsync({
        epicId: args.epicId,
        workspacePath,
        patch: {
          ...(values.color === saved.color ? {} : { color: values.color }),
          ...(iconsEqual(values.icon, saved.icon) ? {} : { icon: values.icon }),
        },
        upload: uploading ? logo.upload : null,
      })
      .then((response) => {
        // Follow the saved value again: the mutation writes the fresh read into
        // the cache before this resolves.
        setDraft(null);
        setEmojiDraft(null);
        return response;
      });
  };

  return {
    values,
    emojiText,
    emojiInvalid,
    imageError,
    note: identityNote(
      read.appearance,
      read.writeSupport !== false && read.readSupport !== false,
    ),
    disabled: !read.canEdit,
    busy,
    changed,
    localLogoUrl,
    scope: read.scope,
    assetRefreshKey: read.assetRefreshKey,
    setColor: (color) => edit((previous) => ({ ...previous, color })),
    setEmoji: (text) => {
      setEmojiDraft(text);
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        edit((previous) => ({ ...previous, icon: null }));
        return;
      }
      const icon = emojiIcon(trimmed);
      if (icon !== null) edit((previous) => ({ ...previous, icon }));
    },
    chooseLogo,
    clearIcon: () => {
      setEmojiDraft("");
      setImageError(null);
      edit((previous) => ({ ...previous, icon: null }));
    },
    save,
  };
}
