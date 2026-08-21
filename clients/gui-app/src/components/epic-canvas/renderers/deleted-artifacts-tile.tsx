import { Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { DeletedArtifactEntry } from "@traycer/protocol/host/epic/artifact-versions";
import { Button } from "@/components/ui/button";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { epicMutationKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { TraycerMarkdown } from "@/markdown/traycer-markdown";
import type { DeletedArtifactsTileRef } from "@/stores/epics/canvas/types";

const DELETED_AT_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatDeletedAt(timestamp: number): string {
  return DELETED_AT_FORMATTER.format(new Date(timestamp));
}

function deletedArtifactUnavailableCopy(
  reason: DeletedArtifactEntry["unrestorable"],
): string | null {
  if (reason === "missing_scalars") {
    return "Cannot restore: the artifact's title, kind, or tree position is missing.";
  }
  if (reason === "missing_blob") {
    return "Cannot restore: the saved artifact body is missing.";
  }
  return null;
}

export function DeletedArtifactsTile(props: {
  readonly node: DeletedArtifactsTileRef;
}): ReactNode {
  const client = useTabHostClient();
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(
    null,
  );
  const deleted = useHostQuery({
    client,
    method: "epic.deletedArtifacts.list",
    params: { epicId: props.node.epicId },
    cacheKeyIdentity: undefined,
    options: { enabled: true },
  });
  const revive = useHostScopedMutationForClient(client, {
    method: "epic.deletedArtifacts.revive",
    mutationKey: epicMutationKeys.reviveDeletedArtifact(),
    errorMessage: "Couldn't restore this artifact",
    invalidateMethods: ["epic.deletedArtifacts.list"],
  });
  const entries = deleted.data?.entries ?? [];
  const selected =
    entries.find((entry) => entry.artifactId === selectedArtifactId) ??
    entries.at(0) ??
    null;
  return (
    <section
      aria-label="Deleted artifacts"
      data-testid="deleted-artifacts-tile"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex shrink-0 items-center gap-3 border-b px-5 py-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Trash2 className="size-4" />
        </div>
        <div className="min-w-0">
          <h1 className="font-semibold">Deleted artifacts</h1>
          <p className="text-ui-sm text-muted-foreground">
            Restore artifacts retained in this epic&apos;s version history.
          </p>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:grid-rows-1">
        <DeletedArtifactList
          entries={entries}
          selectedArtifactId={selected?.artifactId ?? null}
          loading={deleted.isLoading}
          failed={deleted.isError}
          restoringArtifactId={
            revive.isPending ? revive.variables.artifactId : null
          }
          onRetry={() => void deleted.refetch()}
          onSelect={setSelectedArtifactId}
          onRestore={(artifactId) =>
            revive.mutate({ epicId: props.node.epicId, artifactId })
          }
        />
        <DeletedArtifactPreviewPane
          epicId={props.node.epicId}
          entry={selected}
        />
      </div>
    </section>
  );
}

function DeletedArtifactPreviewPane(props: {
  readonly epicId: string;
  readonly entry: DeletedArtifactEntry | null;
}): ReactNode {
  const client = useTabHostClient();
  const preview = useHostQuery({
    client,
    method: "epic.artifactVersions.getBlob",
    params: {
      epicId: props.epicId,
      artifactId: props.entry?.artifactId ?? "unselected",
      observationId: props.entry?.lastObservationId ?? "unselected",
    },
    cacheKeyIdentity:
      props.entry?.lastContentHash === null ||
      props.entry?.lastContentHash === undefined
        ? undefined
        : [props.entry.lastContentHash],
    options: {
      enabled:
        props.entry?.lastObservationId !== null &&
        props.entry?.lastObservationId !== undefined &&
        props.entry.unrestorable !== "missing_blob",
    },
  });

  return (
    <DeletedArtifactPreview
      entry={props.entry}
      markdown={preview.data?.markdown ?? null}
      loading={preview.isLoading}
      failed={preview.isError}
      onRetry={() => void preview.refetch()}
    />
  );
}

function DeletedArtifactList(props: {
  readonly entries: DeletedArtifactEntry[];
  readonly selectedArtifactId: string | null;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly restoringArtifactId: string | null;
  readonly onRetry: () => void;
  readonly onSelect: (artifactId: string) => void;
  readonly onRestore: (artifactId: string) => void;
}): ReactNode {
  const empty = !props.loading && !props.failed && props.entries.length === 0;

  return (
    <div className="min-h-0 overflow-y-auto border-b p-5 lg:border-r lg:border-b-0">
      {props.loading ? (
        <p className="text-muted-foreground">Loading deleted artifacts…</p>
      ) : null}
      {props.failed ? (
        <div>
          <p className="text-muted-foreground">
            Couldn&apos;t load deleted artifacts.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={props.onRetry}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {empty ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">No deleted artifacts</p>
          <p className="mt-1 text-ui-sm text-muted-foreground">
            Artifacts retained after deletion will appear here.
          </p>
        </div>
      ) : null}
      <div className="space-y-2">
        {props.entries.map((entry) => (
          <DeletedArtifactListEntry
            key={entry.artifactId}
            entry={entry}
            selected={props.selectedArtifactId === entry.artifactId}
            restoring={props.restoringArtifactId === entry.artifactId}
            onSelect={props.onSelect}
            onRestore={props.onRestore}
          />
        ))}
      </div>
    </div>
  );
}

function DeletedArtifactListEntry(props: {
  readonly entry: DeletedArtifactEntry;
  readonly selected: boolean;
  readonly restoring: boolean;
  readonly onSelect: (artifactId: string) => void;
  readonly onRestore: (artifactId: string) => void;
}): ReactNode {
  const reason = deletedArtifactUnavailableCopy(props.entry.unrestorable);
  const title = props.entry.title ?? "Untitled artifact";

  return (
    <div
      className={cn(
        "flex items-stretch rounded-lg border transition-colors hover:bg-foreground/5",
        props.selected && "border-primary/50 bg-foreground/5",
      )}
    >
      <button
        type="button"
        aria-label={`Preview deleted artifact ${title}`}
        aria-pressed={props.selected}
        className="min-w-0 flex-1 p-4 text-left focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        onClick={() => props.onSelect(props.entry.artifactId)}
      >
        <p className="truncate font-medium">{title}</p>
        <p className="text-ui-xs text-muted-foreground">
          Deleted {formatDeletedAt(props.entry.deletedAt)} ·{" "}
          {props.entry.versionCount}{" "}
          {props.entry.versionCount === 1 ? "version" : "versions"}
        </p>
        {reason === null ? null : (
          <p className="mt-1 text-ui-xs text-amber-600 dark:text-amber-400">
            {reason}
          </p>
        )}
      </button>
      <div className="flex shrink-0 items-center p-4 pl-0">
        <Button
          size="sm"
          variant="outline"
          disabled={reason !== null || props.restoring}
          onClick={() => props.onRestore(props.entry.artifactId)}
        >
          Restore artifact
        </Button>
      </div>
    </div>
  );
}

function DeletedArtifactPreview(props: {
  readonly entry: DeletedArtifactEntry | null;
  readonly markdown: string | null;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  const title = props.entry?.title ?? "Untitled artifact";
  const previewUnavailable =
    props.entry === null ||
    props.entry.lastObservationId === null ||
    props.entry.unrestorable === "missing_blob";

  return (
    <section
      aria-label="Deleted artifact preview"
      className="flex min-h-0 flex-col"
    >
      <header className="shrink-0 border-b px-5 py-3">
        <p className="truncate font-medium">
          {props.entry === null ? "Preview" : title}
        </p>
        <p className="text-ui-xs text-muted-foreground">Latest saved version</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {props.loading ? (
          <p className="p-5 text-muted-foreground">Loading preview…</p>
        ) : null}
        {props.failed ? (
          <div className="p-5">
            <p className="text-muted-foreground">
              Couldn&apos;t load this artifact&apos;s saved body.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={props.onRetry}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {!props.loading && !props.failed && previewUnavailable ? (
          <p className="p-5 text-muted-foreground">
            No saved body is available to preview.
          </p>
        ) : null}
        {!props.loading && !props.failed && props.markdown !== null ? (
          <TraycerMarkdown
            className="mx-auto w-full max-w-4xl px-6 py-5 text-foreground"
            proseSize="normal"
            components={null}
            remarkPlugins={null}
            rehypePlugins={null}
            quotable={false}
            isStreaming={false}
          >
            {props.markdown}
          </TraycerMarkdown>
        ) : null}
      </div>
    </section>
  );
}
