/**
 * The identity tab's surface: rail (file tree), body (editor or preview) and
 * the details panel (history + settings), all under one open-identity session
 * bound to the tab's host for life.
 *
 * Fluid three-column layout on wide viewports; below `lg` the details panel
 * folds into a segmented control with the tree and the body, since three
 * columns cannot share a phone width. Which file is shown is local state
 * seeded from the tree: the first root markdown file (the soul) when nothing
 * has been picked, so an identity opens on its soul rather than on a blank.
 */
import { useState, type ReactNode } from "react";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOpenIdentityGate } from "@/providers/open-identity-context";
import { OpenIdentityProvider } from "@/providers/open-identity-provider";
import { useOpenIdentityState } from "@/lib/identity-selectors";
import {
  buildIdentityFileTree,
  type IdentityTreeFile,
  type IdentityTreeGroup,
} from "@/lib/identities/file-tree";
import { cn } from "@/lib/utils";
import { IdentityFileBody } from "./identity-file-body";
import { IdentityFileTree } from "./identity-file-tree";
import { IdentityDetailsPanel } from "./identity-details-panel";

export interface IdentitySurfaceProps {
  readonly identityId: string;
  readonly hostId: string;
}

export function IdentitySurface(props: IdentitySurfaceProps): ReactNode {
  return (
    <OpenIdentityProvider identityId={props.identityId} hostId={props.hostId}>
      <IdentitySurfaceGate
        identityId={props.identityId}
        hostId={props.hostId}
      />
    </OpenIdentityProvider>
  );
}

function IdentitySurfaceGate(props: IdentitySurfaceProps): ReactNode {
  const gate = useOpenIdentityGate();
  switch (gate.kind) {
    case "ready":
      return (
        <IdentityWorkspace
          identityId={props.identityId}
          hostId={props.hostId}
        />
      );
    case "unsupported":
      return (
        <SurfaceNotice testId="identity-surface-unsupported">
          This host doesn&apos;t support identities. Update the host on this
          device to open one here.
        </SurfaceNotice>
      );
    case "binding-pending":
    case "unknown":
      return (
        <SurfaceNotice testId="identity-surface-pending">
          <MutedAgentSpinner />
          <span>Connecting to the host…</span>
        </SurfaceNotice>
      );
  }
}

function SurfaceNotice(props: {
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      data-testid={props.testId}
      className="flex h-full w-full items-center justify-center gap-2 p-6 text-center text-ui-sm text-muted-foreground"
    >
      {props.children}
    </div>
  );
}

type NarrowPane = "files" | "editor" | "details";

const NARROW_PANES: ReadonlyArray<{
  readonly id: NarrowPane;
  readonly label: string;
}> = [
  { id: "files", label: "Files" },
  { id: "editor", label: "Editor" },
  { id: "details", label: "Details" },
];

function isNarrowPane(value: string): value is NarrowPane {
  return value === "files" || value === "editor" || value === "details";
}

/** The file an identity opens on: its first root markdown file. */
function defaultPath(groups: readonly IdentityTreeGroup[]): string | null {
  for (const group of groups) {
    if (group.files.length > 0) return group.files[0].path;
  }
  return null;
}

function findFile(
  groups: readonly IdentityTreeGroup[],
  path: string | null,
): IdentityTreeFile | null {
  if (path === null) return null;
  for (const group of groups) {
    const match = group.files.find((file) => file.path === path);
    if (match !== undefined) return match;
  }
  return null;
}

function IdentityWorkspace(props: IdentitySurfaceProps): ReactNode {
  const { identityId, hostId } = props;
  const documents = useOpenIdentityState((state) => state.documents);
  const files = useOpenIdentityState((state) => state.files);
  const hydrated = useOpenIdentityState((state) => state.hydrated);
  const connection = useOpenIdentityState((state) => state.connection);
  const groups = buildIdentityFileTree(documents, files);
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [narrowPane, setNarrowPane] = useState<NarrowPane>("editor");
  // A picked file that has since been deleted or renamed falls back to the
  // default; the pick itself is kept so a rename that lands the same path
  // back (an undo) re-selects it without a click.
  const selected =
    findFile(groups, pickedPath) ?? findFile(groups, defaultPath(groups));
  const selectedPath = selected?.path ?? null;

  const onSelect = (path: string) => {
    setPickedPath(path);
    setNarrowPane("editor");
  };

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      data-testid="identity-surface"
      data-identity-id={identityId}
    >
      {connection === "reconnecting" || connection === "closed" ? (
        <div
          className="border-b border-warning/30 bg-warning/10 px-3 py-1 text-ui-xs text-warning-foreground"
          data-testid="identity-connection-banner"
        >
          {connection === "reconnecting"
            ? "Reconnecting to the host… edits will sync when it returns."
            : "Disconnected from the host. Edits stay local until it returns."}
        </div>
      ) : null}
      <div className="border-b border-border/60 px-2 py-1 lg:hidden">
        <Tabs
          value={narrowPane}
          onValueChange={(value) => {
            if (isNarrowPane(value)) setNarrowPane(value);
          }}
        >
          <TabsList className="w-full">
            {NARROW_PANES.map((pane) => (
              <TabsTrigger key={pane.id} value={pane.id} className="flex-1">
                {pane.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="flex min-h-0 w-full flex-1">
        <aside
          className={cn(
            "min-h-0 shrink-0 flex-col overflow-y-auto border-border/60 lg:flex lg:w-[clamp(13rem,20vw,17rem)] lg:border-r",
            narrowPane === "files" ? "flex w-full" : "hidden",
          )}
          data-testid="identity-rail"
        >
          <IdentityFileTree
            identityId={identityId}
            groups={groups}
            hydrated={hydrated}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        </aside>
        <main
          className={cn(
            "min-h-0 min-w-0 flex-1 lg:flex",
            narrowPane === "editor" ? "flex" : "hidden",
          )}
          data-testid="identity-body"
        >
          <IdentityFileBody
            identityId={identityId}
            hostId={hostId}
            file={selected}
            hydrated={hydrated}
          />
        </main>
        <aside
          className={cn(
            "min-h-0 shrink-0 flex-col overflow-y-auto border-border/60 lg:flex lg:w-[clamp(16rem,24vw,22rem)] lg:border-l",
            narrowPane === "details" ? "flex w-full" : "hidden",
          )}
          data-testid="identity-details"
        >
          <IdentityDetailsPanel
            identityId={identityId}
            hostId={hostId}
            selectedPath={selectedPath}
          />
        </aside>
      </div>
    </div>
  );
}
