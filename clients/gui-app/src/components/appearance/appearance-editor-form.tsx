import { AppearanceEditorFormView } from "./appearance-editor-form-view";
import { useEffect, useRef, useState } from "react";
import {
  appearanceIconSchema,
  type AppearanceUpload,
  type WorkspaceAppearance,
} from "@traycer/protocol/host/workspace/appearance-schemas";
import type { AppearanceWallpaperImage } from "@/components/home/appearance-wallpaper";
import {
  useAppearanceAsset,
  type AppearanceAssetState,
} from "@/hooks/appearance/use-appearance-assets";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { AppearanceScope } from "@/lib/appearance/appearance-cache";
import {
  prepareAppearanceImage,
  type PreparedAppearanceImage,
} from "@/lib/appearance/appearance-image-preparation";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import type { AppearanceEditorSave } from "./appearance-editor";
import {
  appearanceEditorSessionCurrent,
  type AppearanceEditorTarget,
} from "./appearance-editor-launcher";

export interface AppearanceEditorValues {
  readonly appearance: WorkspaceAppearance;
  readonly showGreeting: boolean;
  readonly showRecentHistory: boolean;
}

interface LocalImage {
  readonly prepared: PreparedAppearanceImage;
  readonly upload: AppearanceUpload;
  readonly url: string;
}

async function prepareEditorImage(
  blob: Blob,
  kind: AppearanceUpload["target"],
  signal: AbortSignal,
): Promise<Omit<LocalImage, "url">> {
  const prepared = await prepareAppearanceImage({ blob, target: kind }, signal);
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
  signal.throwIfAborted();
  return { prepared, upload: { target: kind, mediaType, dataBase64 } };
}

export interface EditorImage {
  readonly image: LocalImage | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly select: (blob: Blob) => Promise<LocalImage | null>;
  readonly clear: () => void;
}

function useEditorImage(
  target: AppearanceEditorTarget,
  kind: AppearanceUpload["target"],
): EditorImage {
  const [image, setImage] = useState<LocalImage | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  useEffect(
    () => () => {
      if (image !== null) URL.revokeObjectURL(image.url);
    },
    [image],
  );
  const select = (blob: Blob): Promise<LocalImage | null> => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setPending(true);
    setError(null);
    return prepareEditorImage(blob, kind, request.signal)
      .then((prepared) => {
        if (request.signal.aborted || !appearanceEditorSessionCurrent(target))
          return null;
        const next = {
          ...prepared,
          url: URL.createObjectURL(prepared.prepared.blob),
        };
        setImage(next);
        return next;
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted && appearanceEditorSessionCurrent(target))
          setError(
            reason instanceof Error
              ? reason.message
              : "This image could not be prepared. Choose another image.",
          );
        return null;
      })
      .finally(() => {
        if (!request.signal.aborted) setPending(false);
      });
  };
  return {
    image,
    pending,
    error,
    select,
    clear: () => {
      controller.current?.abort();
      setImage(null);
      setPending(false);
      setError(null);
    },
  };
}

function newWallpaper(path: string): AppearanceWallpaperImage {
  return {
    kind: "image",
    path,
    focalPoint: [0.5, 0.5],
    treatment: "original",
    dimming: 0.25,
    strength: 0.4,
  };
}

export interface AppearanceEditorFormProps {
  readonly target: AppearanceEditorTarget;
  readonly active: boolean;
  readonly initial: AppearanceEditorValues;
  readonly scope: AppearanceScope | null;
  readonly issues: readonly string[];
  readonly refreshKey: number;
  readonly disabled: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onSave: (input: AppearanceEditorSave) => Promise<boolean>;
  readonly onDirty: (dirty: boolean) => void;
  readonly onClose: () => void;
}

export function useAppearanceEditorForm(props: AppearanceEditorFormProps) {
  const [values, setValues] = useState(props.initial);
  const currentValues = useRef(props.initial);
  const baseline = useRef(props.initial);
  const updateValues = (
    update: (previous: AppearanceEditorValues) => AppearanceEditorValues,
  ) => {
    const next = update(currentValues.current);
    currentValues.current = next;
    setValues(next);
    props.onDirty(JSON.stringify(next) !== JSON.stringify(baseline.current));
  };
  const [wallpaperMode, setWallpaperMode] = useState(
    values.appearance.wallpaper?.kind ??
      (props.target.kind === "global" ? "none" : "global"),
  );
  const [iconMode, setIconMode] = useState(
    values.appearance.icon?.kind ?? "neutral",
  );
  const wallpaperUpload = useEditorImage(props.target, "wallpaper");
  const iconUpload = useEditorImage(props.target, "icon");
  const { icon } = values.appearance;
  const initialWallpaper = props.initial.appearance.wallpaper;
  const initialIcon = props.initial.appearance.icon;
  const preview = useEditorPreview(
    props,
    values,
    wallpaperUpload.image,
    iconUpload.image,
  );
  const { localWallpaper } = preview;
  const { invalidEmoji, preparing, disabled, cannotSave } = editorValidity({
    props,
    appearance: values.appearance,
    wallpaperMode,
    iconMode,
    wallpaperUpload,
    iconUpload,
  });
  const editAppearance = (patch: Partial<WorkspaceAppearance>) =>
    updateValues((previous) => ({
      ...previous,
      appearance: { ...previous.appearance, ...patch },
    }));
  const selectWallpaper = (file: File) => {
    props.onDirty(true);
    void wallpaperUpload.select(file).then((image) => {
      if (image !== null) {
        setWallpaperMode("image");
        updateValues((previous) => ({
          ...previous,
          appearance: {
            ...previous.appearance,
            wallpaper:
              previous.appearance.wallpaper?.kind === "image"
                ? {
                    ...previous.appearance.wallpaper,
                    path: image.prepared.path,
                  }
                : newWallpaper(image.prepared.path),
          },
        }));
      }
    });
  };
  const selectIcon = (file: File) => {
    props.onDirty(true);
    void iconUpload.select(file).then((image) => {
      if (image !== null)
        editAppearance({ icon: { kind: "image", path: image.prepared.path } });
    });
  };
  const changeIconMode = (mode: string) => {
    if (
      mode !== "neutral" &&
      mode !== "symbol" &&
      mode !== "emoji" &&
      mode !== "image"
    )
      return;
    iconUpload.clear();
    setIconMode(mode);
    if (mode === "neutral") editAppearance({ icon: undefined });
    if (mode === "symbol")
      editAppearance({ icon: { kind: "symbol", value: "folder" } });
    if (mode === "emoji")
      editAppearance({ icon: { kind: "emoji", value: "🚀" } });
    if (mode === "image")
      editAppearance({
        icon: initialIcon?.kind === "image" ? initialIcon : undefined,
      });
  };
  const changeWallpaperMode = (mode: string) => {
    if (mode !== "global" && mode !== "none" && mode !== "image") return;
    wallpaperUpload.clear();
    setWallpaperMode(mode);
    if (mode === "global") editAppearance({ wallpaper: undefined });
    if (mode === "none") editAppearance({ wallpaper: { kind: "none" } });
    if (mode === "image")
      editAppearance({
        wallpaper:
          initialWallpaper?.kind === "image" ? initialWallpaper : undefined,
      });
  };
  const save = () => {
    const uploads: AppearanceUpload[] = [];
    if (localWallpaper !== null) uploads.push(localWallpaper.upload);
    if (icon?.kind === "image" && iconUpload.image?.prepared.path === icon.path)
      uploads.push(iconUpload.image.upload);
    void props
      .onSave({
        values,
        wallpaperBlob: localWallpaper?.prepared.blob ?? null,
        uploads,
      })
      .then((saved) => {
        if (saved) {
          baseline.current = values;
          props.onDirty(false);
        }
      });
  };
  return (
    <AppearanceEditorFormView
      props={props}
      values={values}
      preview={preview}
      wallpaperMode={wallpaperMode}
      iconMode={iconMode}
      wallpaperUpload={wallpaperUpload}
      iconUpload={iconUpload}
      invalidEmoji={invalidEmoji}
      cannotSave={cannotSave}
      disabled={disabled}
      preparing={preparing}
      selectWallpaper={selectWallpaper}
      selectIcon={selectIcon}
      changeWallpaperMode={changeWallpaperMode}
      changeIconMode={changeIconMode}
      editAppearance={editAppearance}
      updateValues={updateValues}
      save={save}
    />
  );
}

function editorValidity(args: {
  readonly props: AppearanceEditorFormProps;
  readonly appearance: WorkspaceAppearance;
  readonly wallpaperMode: string;
  readonly iconMode: string;
  readonly wallpaperUpload: EditorImage;
  readonly iconUpload: EditorImage;
}) {
  const {
    props,
    appearance,
    wallpaperMode,
    iconMode,
    wallpaperUpload,
    iconUpload,
  } = args;
  const { wallpaper, icon } = appearance;
  const invalidEmoji =
    icon?.kind === "emoji" && !appearanceIconSchema.safeParse(icon).success;
  const missingImage =
    (wallpaperMode === "image" && wallpaper?.kind !== "image") ||
    (iconMode === "image" && icon?.kind !== "image");
  const preparing = wallpaperUpload.pending || iconUpload.pending;
  const disabled = props.disabled || props.saving;
  return {
    invalidEmoji,
    preparing,
    disabled,
    cannotSave: disabled || preparing || invalidEmoji || missingImage,
  };
}

export interface EditorPreview {
  readonly savedWallpaper: AppearanceAssetState;
  readonly savedIcon: AppearanceAssetState;
  readonly localWallpaper: LocalImage | null;
  readonly logoUrl: string | null;
  readonly previewWallpaper: WorkspaceAppearance["wallpaper"] | null;
  readonly previewUrl: string | null;
  readonly inherit: boolean;
  readonly onDecodeFailure: (() => void) | null;
  readonly previewGreeting: boolean;
  readonly previewHistory: boolean;
}

function useEditorPreview(
  props: AppearanceEditorFormProps,
  values: AppearanceEditorValues,
  wallpaperImage: LocalImage | null,
  iconImage: LocalImage | null,
): EditorPreview {
  const globals = useSettingsStore((state) => state.globalWallpaper);
  const globalGreeting = useSettingsStore((state) => state.showGreeting);
  const globalHistory = useSettingsStore((state) => state.showRecentHistory);
  const previewGreeting =
    props.target.kind === "project" ? globalGreeting : values.showGreeting;
  const previewHistory =
    props.target.kind === "project" ? globalHistory : values.showRecentHistory;
  const wallpaper = values.appearance.wallpaper;
  const icon = values.appearance.icon;
  const initialWallpaper = props.initial.appearance.wallpaper;
  const initialIcon = props.initial.appearance.icon;
  const savedWallpaper = useAppearanceAsset({
    scope: props.scope,
    path: initialWallpaper?.kind === "image" ? initialWallpaper.path : null,
    target: "wallpaper",
    rejected: props.issues.includes("wallpaper"),
    focused: props.active,
    refreshKey: props.refreshKey,
  });
  const globalAsset = useAppearanceAsset({
    scope: null,
    path:
      props.target.kind === "project" && globals?.kind === "image"
        ? globals.path
        : null,
    target: "wallpaper",
    rejected: false,
    focused: props.active,
    refreshKey: props.refreshKey,
  });
  const savedIcon = useAppearanceAsset({
    scope: props.scope,
    path: initialIcon?.kind === "image" ? initialIcon.path : null,
    target: "icon",
    rejected: props.issues.includes("icon"),
    focused: props.active,
    refreshKey: props.refreshKey,
  });
  return {
    savedWallpaper,
    savedIcon,
    previewGreeting,
    previewHistory,
    ...resolveEditorPreview({
      kind: props.target.kind,
      wallpaper,
      icon,
      wallpaperImage,
      iconImage,
      savedWallpaper,
      savedIcon,
      globals,
      globalAsset,
    }),
  };
}

function resolveEditorPreview(args: {
  readonly kind: AppearanceEditorTarget["kind"];
  readonly wallpaper: WorkspaceAppearance["wallpaper"];
  readonly icon: WorkspaceAppearance["icon"];
  readonly wallpaperImage: LocalImage | null;
  readonly iconImage: LocalImage | null;
  readonly savedWallpaper: AppearanceAssetState;
  readonly savedIcon: AppearanceAssetState;
  readonly globals: WorkspaceAppearance["wallpaper"] | null;
  readonly globalAsset: AppearanceAssetState;
}) {
  const {
    kind,
    wallpaper,
    icon,
    wallpaperImage,
    iconImage,
    savedWallpaper,
    savedIcon,
    globals,
    globalAsset,
  } = args;
  const localWallpaper = matchingLocalImage(wallpaper, wallpaperImage);
  const wallpaperUrl = localWallpaper?.url ?? savedWallpaper.url;
  const inherit =
    kind === "project" &&
    (wallpaper === undefined ||
      (wallpaper.kind === "image" && wallpaperUrl === null));
  const previewWallpaper = inherit ? globals : wallpaper;
  const previewUrl = inherit ? globalAsset.url : wallpaperUrl;
  let onDecodeFailure =
    localWallpaper === null ? savedWallpaper.reportDecodeFailure : null;
  if (inherit) onDecodeFailure = globalAsset.reportDecodeFailure;
  const logoUrl = matchingLocalImage(icon, iconImage)?.url ?? savedIcon.url;
  return {
    localWallpaper,
    logoUrl,
    previewWallpaper,
    previewUrl,
    inherit,
    onDecodeFailure,
  };
}

function matchingLocalImage(
  appearance: WorkspaceAppearance["wallpaper"] | WorkspaceAppearance["icon"],
  image: LocalImage | null,
): LocalImage | null {
  return appearance?.kind === "image" &&
    image?.prepared.path === appearance.path
    ? image
    : null;
}
