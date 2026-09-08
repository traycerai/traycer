import { LazyAppearanceEditor } from "./appearance-editor-lazy";
import type { HeaderTab } from "@/stores/tabs/types";
import { useEpicAppearanceSource } from "@/hooks/appearance/use-workspace-appearance";
import { sessionCreatedEpicHostId } from "@/lib/epics/session-created-epics";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { Suspense, useRef, useState, type RefObject } from "react";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  captureAppearanceSession,
  isAppearanceSessionCurrent,
} from "@/lib/appearance/appearance-cache";
import { isMobileApp } from "@/lib/mobile-app";
import { isMobileViewport } from "@/hooks/ui/use-mobile-viewport";

export interface AppearanceProjectScope {
  readonly kind: "project";
  readonly hostId: string | null;
  readonly workspacePath: string | null;
  readonly epicId: string;
  readonly readOnly: boolean;
}

export type AppearanceEditorScope =
  | {
      readonly kind: "global";
      readonly repository: AppearanceProjectScope | null;
    }
  | AppearanceProjectScope;

export function appearanceEditorSessionCurrent(
  target: AppearanceEditorTarget,
): boolean {
  return (
    (useAuthStore.getState().contextMetadata?.userId ?? null) ===
      target.accountId &&
    isAppearanceSessionCurrent(target.accountId, target.session)
  );
}

export type AppearanceEditorTarget = AppearanceEditorScope & {
  readonly accountId: string | null;
  readonly session: number;
};

export function useAppearanceEditor() {
  const opener = useRef<HTMLElement | null>(null);
  const [target, setTarget] = useState<AppearanceEditorTarget | null>(null);
  return {
    openEditor: (scope: AppearanceEditorScope, trigger: HTMLElement | null) => {
      if (isMobileApp() || isMobileViewport()) return;
      opener.current = trigger;
      setTarget({
        ...scope,
        accountId: useAuthStore.getState().contextMetadata?.userId ?? null,
        session: captureAppearanceSession(),
      });
    },
    editor:
      target === null ? null : (
        <Suspense fallback={null}>
          <LazyAppearanceEditor
            target={target}
            onClose={() =>
              setTarget((current) => (current === target ? null : current))
            }
            onRestoreFocus={() => {
              if (opener.current?.isConnected)
                opener.current.focus({ preventScroll: true });
            }}
          />
        </Suspense>
      ),
  };
}

export function useTabAppearanceEditor(
  tab: HeaderTab,
  readOnly: boolean,
  trigger: RefObject<HTMLElement | null>,
) {
  const { openEditor, editor } = useAppearanceEditor();
  const source = useEpicAppearanceSource({
    hostId:
      tab.kind === "epic"
        ? (tab.hostId ?? sessionCreatedEpicHostId(tab.epicId))
        : null,
    epicId: tab.kind === "epic" ? tab.epicId : "",
  });
  const isMobile = useIsMobileViewport();
  const onCustomize =
    tab.kind === "epic" && !isMobile && !isMobileApp()
      ? () =>
          openEditor(
            {
              kind: "project",
              hostId: source.hostId,
              workspacePath:
                tab.repositoryIdentity?.scope?.canonicalSourceRoot ??
                source.workspacePath,
              epicId: tab.epicId,
              readOnly,
            },
            trigger.current,
          )
      : null;
  return { editor, onCustomize };
}
