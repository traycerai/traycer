import { Folder } from "lucide-react";
import type { WorkspaceAppearance } from "@traycer/protocol/host/workspace/appearance-schemas";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { AppearanceWallpaper } from "@/components/home/appearance-wallpaper";
import { RepositoryIdentityIcon } from "@/components/layout/tabs/repository-identity";
import { repositoryTabFill } from "@/components/layout/tabs/repository-identity-presentation";
import { cn } from "@/lib/utils";
import type {
  AppearanceEditorFormProps,
  AppearanceEditorValues,
  EditorImage,
  EditorPreview,
} from "./appearance-editor-form";
import {
  AppearanceChoice,
  RepositoryIconChoices,
  WallpaperImageControls,
  ImageFile,
} from "./appearance-editor-controls";

interface FormViewProps {
  readonly props: AppearanceEditorFormProps;
  readonly values: AppearanceEditorValues;
  readonly preview: EditorPreview;
  readonly wallpaperMode: string;
  readonly iconMode: string;
  readonly wallpaperUpload: EditorImage;
  readonly iconUpload: EditorImage;
  readonly invalidEmoji: boolean;
  readonly cannotSave: boolean;
  readonly disabled: boolean;
  readonly preparing: boolean;
  readonly selectWallpaper: (file: File) => void;
  readonly selectIcon: (file: File) => void;
  readonly changeWallpaperMode: (mode: string) => void;
  readonly changeIconMode: (mode: string) => void;
  readonly editAppearance: (patch: Partial<WorkspaceAppearance>) => void;
  readonly updateValues: (
    update: (previous: AppearanceEditorValues) => AppearanceEditorValues,
  ) => void;
  readonly save: () => void;
}

export function AppearanceEditorFormView(model: FormViewProps) {
  return (
    <>
      <EditorPreviewView {...model} />
      <EditorFields {...model} />
      <EditorFeedback {...model} />
      <EditorFooter {...model} />
    </>
  );
}

function RepositoryPreview(model: FormViewProps) {
  const {
    props,
    values,
    preview: { logoUrl },
  } = model;
  const icon = values.appearance.icon;
  return (
    <div
      className="flex items-center gap-2 border-b px-3 py-2 text-ui-xs"
      style={{ background: repositoryTabFill(values.appearance.color) }}
    >
      {icon?.kind === "image" ? (
        <>
          {logoUrl === null ? (
            <Folder className="size-3.5" />
          ) : (
            <img src={logoUrl} alt="" className="size-3.5 object-contain" />
          )}
        </>
      ) : (
        <RepositoryIdentityIcon
          identity={{
            scope: props.scope,
            color: values.appearance.color ?? null,
            icon: icon ?? { kind: "symbol", value: "folder" },
            iconRejected: false,
            assetRefreshKey: props.refreshKey,
          }}
          fallbackIcon={Folder}
        />
      )}
      <span className="truncate">
        {props.scope?.canonicalSourceRoot.split("/").at(-1) ?? "Repository"}
      </span>
    </div>
  );
}

function EditorPreviewView(model: FormViewProps) {
  const {
    props,
    preview: {
      previewWallpaper,
      previewUrl,
      inherit,
      onDecodeFailure,
      previewGreeting,
      previewHistory,
    },
  } = model;
  return (
    <div
      className="overflow-hidden rounded-lg border"
      aria-label="Appearance preview"
    >
      {props.target.kind === "project" ? (
        <RepositoryPreview {...model} />
      ) : null}
      <div className="landing-appearance-surface relative isolate flex aspect-[2/1] flex-col justify-center gap-3 bg-background px-6">
        <AppearanceWallpaper
          wallpaper={
            previewWallpaper?.kind === "image" ? previewWallpaper : null
          }
          originalUrl={props.active ? previewUrl : null}
          scope={inherit ? null : props.scope}
          persistTreatment={false}
          onDecodeFailure={onDecodeFailure}
        />
        <div
          className={cn(
            "relative text-center font-heading text-ui-lg",
            !previewGreeting && "invisible",
          )}
        >
          What would you like to work on?
        </div>
        <div className="relative rounded-xl border bg-background px-4 py-3 text-ui-sm text-muted-foreground">
          Describe a task…
        </div>
        <div
          className={cn(
            "relative text-center text-ui-xs text-muted-foreground",
            !previewHistory && "invisible",
          )}
        >
          Recent tasks
        </div>
      </div>
    </div>
  );
}

function RepositoryFields(model: FormViewProps) {
  const {
    values,
    iconMode,
    editAppearance,
    changeIconMode,
    selectIcon,
    invalidEmoji,
  } = model;
  const icon = values.appearance.icon;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span>Tab color</span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={values.appearance.color === undefined}
            onClick={() => editAppearance({ color: undefined })}
          >
            Neutral
          </Button>
          <input
            type="color"
            aria-label="Tab color"
            value={values.appearance.color ?? "#8b5cf6"}
            onChange={(event) =>
              editAppearance({ color: event.currentTarget.value })
            }
            className="size-8 cursor-pointer rounded border bg-transparent p-1"
          />
        </div>
      </div>
      <AppearanceChoice
        label="Tab icon"
        value={iconMode}
        options={[
          { value: "neutral", label: "Neutral" },
          { value: "symbol", label: "Symbol" },
          { value: "emoji", label: "Emoji" },
          { value: "image", label: "Image" },
        ]}
        onChange={changeIconMode}
      />
      <RepositoryIconChoices
        icon={icon}
        onChange={(next) => editAppearance({ icon: next })}
      />
      {iconMode === "image" ? (
        <ImageFile label="Repository image" onSelect={selectIcon} />
      ) : null}
      {invalidEmoji ? (
        <p role="alert" className="text-ui-xs text-destructive">
          Enter one emoji, or choose a suggestion.
        </p>
      ) : null}
    </div>
  );
}

function EditorFields(model: FormViewProps) {
  const {
    props,
    values,
    disabled,
    wallpaperMode,
    changeWallpaperMode,
    selectWallpaper,
    editAppearance,
    updateValues,
  } = model;
  const wallpaper = values.appearance.wallpaper;
  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-4 disabled:opacity-60"
    >
      {props.target.kind === "project" ? <RepositoryFields {...model} /> : null}
      <AppearanceChoice
        label="Background"
        value={wallpaperMode}
        options={
          props.target.kind === "project"
            ? [
                { value: "global", label: "Use global" },
                { value: "none", label: "No image" },
                { value: "image", label: "Project image" },
              ]
            : [
                { value: "none", label: "No image" },
                { value: "image", label: "Image" },
              ]
        }
        onChange={changeWallpaperMode}
      />
      {wallpaperMode === "image" ? (
        <ImageFile label="Background image" onSelect={selectWallpaper} />
      ) : null}
      {wallpaper?.kind === "image" ? (
        <WallpaperImageControls
          image={wallpaper}
          onChange={(image) => editAppearance({ wallpaper: image })}
        />
      ) : null}
      {props.target.kind === "global" ? (
        <div className="space-y-2 border-t pt-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={values.showGreeting}
              onChange={(event) =>
                updateValues((previous) => ({
                  ...previous,
                  showGreeting: event.currentTarget.checked,
                }))
              }
            />
            Show greeting
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={values.showRecentHistory}
              onChange={(event) =>
                updateValues((previous) => ({
                  ...previous,
                  showRecentHistory: event.currentTarget.checked,
                }))
              }
            />
            Show recent history
          </label>
        </div>
      ) : null}
    </fieldset>
  );
}

function EditorFeedback(model: FormViewProps) {
  const {
    props,
    values,
    preview: { localWallpaper, savedWallpaper, savedIcon, logoUrl },
    preparing,
    wallpaperUpload,
    iconUpload,
  } = model;
  const { wallpaper, icon } = values.appearance;
  return (
    <>
      {wallpaper?.kind === "image" &&
      localWallpaper === null &&
      savedWallpaper.status === "unavailable" ? (
        <p role="status" className="text-ui-xs text-muted-foreground">
          The saved background image is unavailable. Reconnect or choose another
          image.
        </p>
      ) : null}
      {icon?.kind === "image" &&
      logoUrl === null &&
      savedIcon.status === "unavailable" ? (
        <p role="status" className="text-ui-xs text-muted-foreground">
          The saved repository image is unavailable. Reconnect or choose another
          image.
        </p>
      ) : null}
      {preparing ? (
        <p role="status" className="flex items-center gap-2 text-ui-xs">
          <AgentSpinningDots
            className={undefined}
            variant={undefined}
            testId="appearance-image-pending"
          />
          Preparing image…
        </p>
      ) : null}
      {wallpaperUpload.error !== null ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {wallpaperUpload.error}
        </p>
      ) : null}
      {iconUpload.error !== null ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {iconUpload.error}
        </p>
      ) : null}
      {props.error !== null ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {props.error}
        </p>
      ) : null}
    </>
  );
}

function EditorFooter(model: FormViewProps) {
  const { props, cannotSave, save } = model;
  return (
    <DialogFooter>
      <Button variant="outline" onClick={props.onClose}>
        Cancel
      </Button>
      <Button disabled={cannotSave} onClick={save}>
        {props.target.kind === "global" ? "Save global" : "Save repository"}
        {props.saving ? (
          <AgentSpinningDots
            className={undefined}
            variant={undefined}
            testId="appearance-save-spinner"
          />
        ) : null}
      </Button>
    </DialogFooter>
  );
}
