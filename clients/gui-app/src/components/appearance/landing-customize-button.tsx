import { isMobileApp } from "@/lib/mobile-app";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { Paintbrush } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLandingDraftAppearanceSource } from "@/hooks/appearance/use-landing-draft-appearance";
import { useWorkspaceAppearance } from "@/hooks/appearance/use-workspace-appearance";
import { resolvePrimaryPath } from "@/lib/worktree/resolve-primary-path";
import { useAppearanceEditor } from "./appearance-editor-launcher";

export function LandingCustomizeButton(props: {
  readonly draftId: string | null;
}) {
  const source = useLandingDraftAppearanceSource(props.draftId);
  const workspacePath = resolvePrimaryPath(source.folders, source.primaryPath);
  const resolved = useWorkspaceAppearance({
    hostId: source.hostId,
    workspacePath,
  });
  const { openEditor, editor } = useAppearanceEditor();
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        onClick={(event) =>
          openEditor(
            {
              kind: "global",
              repository:
                workspacePath === null ||
                resolved.appearance?.status === "non-git"
                  ? null
                  : {
                      kind: "project",
                      hostId: source.hostId,
                      workspacePath:
                        resolved.scope?.canonicalSourceRoot ?? workspacePath,
                      epicId: "",
                      readOnly: false,
                    },
            },
            event.currentTarget,
          )
        }
      >
        <Paintbrush className="size-3.5" />
        Customize
      </Button>
      {editor}
    </>
  );
}

export function LandingCustomizeEntry(props: {
  readonly draftId: string | null;
}) {
  const isMobile = useIsMobileViewport();
  if (isMobile || isMobileApp()) return null;
  return (
    <div className="absolute right-6 top-full z-10 mt-2">
      <LandingCustomizeButton draftId={props.draftId} />
    </div>
  );
}
