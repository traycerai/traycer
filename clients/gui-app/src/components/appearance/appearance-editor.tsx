import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AppearanceUpload,
  WorkspaceAppearance,
  WorkspaceAppearanceRead,
} from "@traycer/protocol/host/workspace/appearance-schemas";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  useWorkspaceAppearance,
  useWorkspaceSetAppearance,
} from "@/hooks/appearance/use-workspace-appearance";
import { useSaveGlobalAppearance } from "@/hooks/appearance/use-appearance-assets";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { isAppearanceSessionCurrent } from "@/lib/appearance/appearance-cache";
import {
  appearanceEditorSessionCurrent,
  type AppearanceEditorTarget,
} from "./appearance-editor-launcher";
import { AppearanceChoice } from "./appearance-editor-controls";
import {
  useAppearanceEditorForm,
  type AppearanceEditorValues,
} from "./appearance-editor-form";

export interface AppearanceEditorSave {
  readonly values: AppearanceEditorValues;
  readonly wallpaperBlob: Blob | null;
  readonly uploads: AppearanceUpload[];
}

function assertEditorSession(target: AppearanceEditorTarget): void {
  if (!appearanceEditorSessionCurrent(target))
    throw new Error("Your account changed. Close Customize and open it again.");
}

export default function AppearanceEditor(props: {
  readonly target: AppearanceEditorTarget;
  readonly onClose: () => void;
  readonly onRestoreFocus: () => void;
}) {
  const dirty = useRef({ global: false, project: false });
  const saved = (scope: "global" | "project") => {
    dirty.current[scope] = false;
    if (!dirty.current.global && !dirty.current.project) props.onClose();
  };
  const [selection, setSelection] = useState(props.target.kind);
  const [visitedProject, setVisitedProject] = useState(
    props.target.kind === "project",
  );
  const [projectTarget] = useState(() => {
    if (props.target.kind === "project") return props.target;
    if (props.target.repository === null) return null;
    return {
      ...props.target.repository,
      accountId: props.target.accountId,
      session: props.target.session,
    };
  });
  const accountId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const validSession =
    accountId === props.target.accountId &&
    isAppearanceSessionCurrent(props.target.accountId, props.target.session);
  const renderDialog = (
    globalContent: ReactNode,
    projectContent: ReactNode,
  ) => (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          props.onRestoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {selection === "global"
              ? "Customize start pages"
              : "Customize repository"}
          </DialogTitle>
          <DialogDescription>
            {selection === "global"
              ? "Personal defaults for this installation. Repository backgrounds keep their own settings."
              : "Saves configuration and images in this repository. Share them through your usual Git workflow."}
          </DialogDescription>
        </DialogHeader>
        {!validSession ? (
          <p role="alert">
            Your account changed. Close Customize and open it again.
          </p>
        ) : null}
        {props.target.kind === "global" && projectTarget !== null ? (
          <AppearanceChoice
            label="Edit"
            value={selection}
            options={[
              { value: "global", label: "Personal defaults" },
              { value: "project", label: "Primary repository" },
            ]}
            onChange={(value) => {
              if (value !== "global" && value !== "project") return;
              setSelection(value);
              if (value === "project") setVisitedProject(true);
            }}
          />
        ) : null}
        <div hidden={selection !== "global"} className="space-y-4">
          {globalContent}
        </div>
        <div hidden={selection !== "project"} className="space-y-4">
          {projectContent}
        </div>
      </DialogContent>
    </Dialog>
  );
  const renderProject = (globalContent: ReactNode) =>
    visitedProject && projectTarget !== null ? (
      <ProjectEditor
        onDirty={(value) => {
          dirty.current.project = value;
        }}
        onSaved={() => saved("project")}
        target={projectTarget}
        onClose={props.onClose}
        active={selection === "project"}
      >
        {(projectContent) => renderDialog(globalContent, projectContent)}
      </ProjectEditor>
    ) : (
      renderDialog(globalContent, null)
    );
  if (!validSession) return renderDialog(null, null);
  return props.target.kind === "global" ? (
    <GlobalEditor
      target={props.target}
      onClose={props.onClose}
      onDirty={(value) => {
        dirty.current.global = value;
      }}
      onSaved={() => saved("global")}
      active={selection === "global"}
    >
      {renderProject}
    </GlobalEditor>
  ) : (
    renderProject(null)
  );
}

function GlobalEditor(props: {
  readonly target: AppearanceEditorTarget;
  readonly onClose: () => void;
  readonly active: boolean;
  readonly onDirty: (dirty: boolean) => void;
  readonly onSaved: () => void;
  readonly children: (content: ReactNode) => ReactNode;
}) {
  const [initial, setInitial] = useState<AppearanceEditorValues>(() => {
    const settings = useSettingsStore.getState();
    return {
      appearance: {
        version: 1,
        wallpaper: settings.globalWallpaper ?? undefined,
      },
      showGreeting: settings.showGreeting,
      showRecentHistory: settings.showRecentHistory,
    };
  });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mutation = useSaveGlobalAppearance();
  const [error, setError] = useState<string | null>(null);
  const save = async (input: AppearanceEditorSave) => {
    setError(null);
    try {
      assertEditorSession(props.target);
      await mutation.mutateAsync({
        wallpaper: input.values.appearance.wallpaper ?? null,
        blob: input.wallpaperBlob,
        showGreeting: input.values.showGreeting,
        showRecentHistory: input.values.showRecentHistory,
      });
      if (!mounted.current) return false;
      assertEditorSession(props.target);
      setInitial(input.values);
      props.onSaved();
      return true;
    } catch (reason) {
      if (!mounted.current) return false;
      setError(
        reason instanceof Error
          ? reason.message
          : "Appearance could not be saved. Try again.",
      );
      return false;
    }
  };
  const content = useAppearanceEditorForm({
    onDirty: props.onDirty,
    active: props.active,
    target: props.target,
    initial,
    scope: null,
    issues: [],
    refreshKey: 0,
    disabled: false,
    saving: mutation.isPending,
    error,
    onSave: save,
    onClose: props.onClose,
  });
  return props.children(content);
}

function projectProblem(args: {
  readonly target: Extract<AppearanceEditorTarget, { kind: "project" }>;
  readonly read: WorkspaceAppearanceRead | null;
  readonly readSupport: boolean | null;
  readonly writeSupport: boolean | null;
  readonly failed: boolean;
  readonly editable: boolean;
}): string | null {
  const status = args.read?.status;
  if (args.target.readOnly)
    return "You have read-only access to this task. Repository appearance cannot be saved.";
  if (args.target.hostId === null)
    return "This task's device is not known yet. Open the task, then try again.";
  if (args.target.workspacePath === null)
    return "This task has no primary repository. Repository customization needs a Git checkout.";
  if (args.readSupport === null || args.writeSupport === null)
    return "Connect to this task's device to load repository appearance.";
  if (!args.readSupport || !args.writeSupport)
    return "Update this task's device to edit repository appearance.";
  if (args.failed || status === "unavailable")
    return "The repository is unavailable. Reconnect to its device and reload to edit.";
  if (status === "unsupported")
    return "This appearance uses a newer format. Update the device before editing.";
  if (status === "non-git")
    return "Repository customization needs a Git checkout.";
  if (status === "malformed")
    return args.editable
      ? "Some saved appearance fields are invalid. Saving replaces them with the settings shown here."
      : "The repository appearance is unreadable. Repair its configuration and reload before editing.";
  return null;
}

function ProjectEditor(props: {
  readonly target: Extract<AppearanceEditorTarget, { kind: "project" }>;
  readonly active: boolean;
  readonly onDirty: (dirty: boolean) => void;
  readonly onSaved: () => void;
  readonly children: (content: ReactNode) => ReactNode;
  readonly onClose: () => void;
}) {
  const resolved = useWorkspaceAppearance({
    hostId: props.target.hostId,
    workspacePath: props.target.workspacePath,
  });
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{
    read: WorkspaceAppearanceRead;
    serial: number;
  } | null>(null);
  const refetch = resolved.query.refetch;
  const canRead =
    props.target.hostId !== null &&
    props.target.workspacePath !== null &&
    resolved.readSupport !== false;
  useEffect(() => {
    if (!canRead) return;
    let active = true;
    void refetch().then((result) => {
      const read = result.data;
      if (
        active &&
        result.isSuccess &&
        read !== null &&
        read !== undefined &&
        appearanceEditorSessionCurrent(props.target)
      )
        setLoaded((previous) => previous ?? { read, serial: 0 });
    });
    return () => {
      active = false;
    };
  }, [canRead, refetch, props.target]);
  const problem = projectProblem({
    target: props.target,
    read: resolved.appearance,
    readSupport: resolved.readSupport,
    writeSupport: resolved.writeSupport,
    failed: resolved.query.isError,
    editable: resolved.canEdit,
  });
  const reload = async () => {
    const result = await refetch();
    const read = result.data;
    if (!appearanceEditorSessionCurrent(props.target)) return;
    if (result.isSuccess && read?.editable === true) {
      setLoaded((previous) => ({ read, serial: (previous?.serial ?? 0) + 1 }));
      props.onDirty(false);
      setReloadError(null);
    } else {
      setReloadError(
        "The repository could not be reloaded. Your draft is unchanged.",
      );
    }
  };
  const renderContent = (form: ReactNode) =>
    props.children(
      <>
        <p className="break-all text-ui-xs text-muted-foreground">
          {loaded?.read.canonicalSourceRoot ?? props.target.workspacePath}
        </p>
        {problem !== null ? <p role="alert">{problem}</p> : null}
        {reloadError !== null ? <p role="alert">{reloadError}</p> : null}
        {canRead && loaded === null ? (
          <Button
            variant="outline"
            size="sm"
            disabled={resolved.query.isFetching}
            onClick={() => {
              void reload();
            }}
          >
            Reload saved settings
          </Button>
        ) : null}
        {loaded === null && problem === null ? (
          <p role="status">Loading appearance…</p>
        ) : null}
        {loaded === null ? (
          <DialogFooter>
            <Button variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
          </DialogFooter>
        ) : null}
        {form}
      </>,
    );
  return loaded !== null && props.target.hostId !== null ? (
    <ProjectEditorForm
      onReload={reload}
      reloading={resolved.query.isFetching}
      onDirty={props.onDirty}
      onSaved={(read) => {
        setLoaded({ ...loaded, read });
        props.onSaved();
      }}
      active={props.active}
      key={loaded.serial}
      target={{ ...props.target, hostId: props.target.hostId }}
      read={loaded.read}
      refreshKey={resolved.assetRefreshKey}
      disabled={
        props.target.readOnly || !resolved.canEdit || resolved.query.isFetching
      }
      changed={resolved.appearance?.revision !== loaded.read.revision}
      onClose={props.onClose}
    >
      {renderContent}
    </ProjectEditorForm>
  ) : (
    renderContent(null)
  );
}

function ProjectEditorForm(props: {
  readonly target: Extract<AppearanceEditorTarget, { kind: "project" }> & {
    readonly hostId: string;
  };
  readonly read: WorkspaceAppearanceRead;
  readonly onDirty: (dirty: boolean) => void;
  readonly onSaved: (read: WorkspaceAppearanceRead) => void;
  readonly children: (content: ReactNode) => ReactNode;
  readonly onReload: () => Promise<void>;
  readonly reloading: boolean;
  readonly active: boolean;
  readonly refreshKey: number;
  readonly disabled: boolean;
  readonly changed: boolean;
  readonly onClose: () => void;
}) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mutation = useWorkspaceSetAppearance({ hostId: props.target.hostId });
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const showGreeting = useSettingsStore((state) => state.showGreeting);
  const showRecentHistory = useSettingsStore(
    (state) => state.showRecentHistory,
  );
  const initial = {
    appearance:
      props.read.appearance ?? ({ version: 1 } satisfies WorkspaceAppearance),
    showGreeting,
    showRecentHistory,
  };
  const save = async (input: AppearanceEditorSave) => {
    if (props.read.canonicalSourceRoot === null || props.disabled || conflict) {
      setError("Reload the repository before saving.");
      return false;
    }
    setError(null);
    try {
      assertEditorSession(props.target);
      const appearance = input.values.appearance;
      const result = await mutation.mutateAsync({
        epicId: props.target.epicId,
        workspacePath: props.read.canonicalSourceRoot,
        expectedRevision: props.read.revision,
        patch: {
          color: appearance.color ?? null,
          icon: appearance.icon ?? null,
          wallpaper: appearance.wallpaper ?? null,
        },
        uploads: input.uploads,
      });
      if (!mounted.current) return false;
      assertEditorSession(props.target);
      if (result.status === "conflict") {
        setConflict(true);
        setError(
          "The repository changed. Your draft is still here. Reload saved settings before trying again; reloading replaces this draft.",
        );
        return false;
      }
      props.onSaved(result.appearance);
      return true;
    } catch (reason) {
      if (!mounted.current) return false;
      setError(
        reason instanceof Error
          ? reason.message
          : "Appearance could not be saved. Reconnect and try again.",
      );
      return false;
    }
  };
  const source = props.read.canonicalSourceRoot;
  const scope =
    source !== null && props.target.accountId !== null
      ? {
          accountId: props.target.accountId,
          hostId: props.target.hostId,
          canonicalSourceRoot: source,
        }
      : null;
  const content = useAppearanceEditorForm({
    onDirty: props.onDirty,
    active: props.active,
    target: props.target,
    initial,
    scope,
    issues: props.read.issues,
    refreshKey: props.refreshKey,
    disabled: props.disabled || conflict,
    saving: mutation.isPending,
    error,
    onSave: save,
    onClose: props.onClose,
  });
  return props.children(
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={props.reloading || mutation.isPending}
        onClick={() => {
          void props.onReload();
        }}
      >
        Reload saved settings
      </Button>
      {props.changed && !conflict ? (
        <p role="status">
          Saved settings changed elsewhere. Reload to replace this draft with
          the latest settings.
        </p>
      ) : null}
      {content}
    </>,
  );
}
