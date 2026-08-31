import { useMutation } from "@tanstack/react-query";
import {
  createArtifactExport,
  serializeArtifactMarkdown,
  type ArtifactExportFormat,
} from "@/lib/artifacts/artifact-export";
import {
  ArtifactBodyUnavailableError,
  holdArtifactBody,
} from "@/lib/epic-replica-reads";
import { saveBlobToDisk, type SavedFile } from "@/lib/files/save-blob-to-disk";
import { toastSavedFile } from "@/lib/files/saved-file-toast";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
import { appLogger } from "@/lib/logger";
import { epicMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

interface ArtifactExportSelection {
  readonly id: string;
  readonly title: string;
}

export interface EpicExportArtifactsInput {
  readonly artifacts: readonly ArtifactExportSelection[];
  readonly format: ArtifactExportFormat;
  readonly archive: boolean;
  readonly archiveTitle: string | null;
}

export function useEpicExportArtifacts() {
  const epicHandle = useOpenEpicHandle();
  const fileSave = useFileSaveHost();
  const openSaved = useOpenSavedFile();

  return useMutation<SavedFile | null, Error, EpicExportArtifactsInput>({
    mutationKey: epicMutationKeys.exportArtifacts(),
    mutationFn: async (input) => {
      const firstArtifact = input.artifacts.at(0);
      if (firstArtifact === undefined) {
        throw new Error("Select at least one artifact to export.");
      }
      // Artifact-room docs are only materialized while leased, and export is
      // the one fragment reader with no editor mounted behind it. Take a lease
      // per artifact for the duration of the read - without one, exporting a
      // body nobody has opened in this session reads as "still loading".
      //
      // ONE lease at a time, and the body is serialized before the next is
      // materialized. Holding them all was the byte spike the accountant
      // exists to prevent: a lease is what keeps a room resident, so retaining
      // every hold until the build made the whole selection hot at once, with
      // no bound on how much a user may select. Sequential MATERIALIZATION was
      // never the property that mattered - sequential RETENTION is.
      const serialized: Array<{
        readonly id: string;
        readonly title: string;
        readonly markdown: string;
      }> = [];
      for (const artifact of input.artifacts) {
        const hold = await holdArtifactBody(epicHandle, artifact.id).catch(
          (cause: unknown) => {
            // The seam names the artifact by id; the user knows it by title.
            if (cause instanceof ArtifactBodyUnavailableError) {
              throw new Error(`“${artifact.title}” is still loading.`);
            }
            throw cause;
          },
        );
        try {
          serialized.push({
            ...artifact,
            markdown: serializeArtifactMarkdown(hold.fragment),
          });
        } finally {
          // Before the next materialize, so at most one body is resident -
          // including on the throw path, where the loop is abandoned.
          hold.release();
        }
      }
      const output = await createArtifactExport({
        artifacts: serialized,
        format: input.format,
        archive: input.archive,
        archiveTitle: input.archiveTitle ?? firstArtifact.title,
      });
      // No leases are held here any more - each was released as its body was
      // serialized - so `saveBlobToDisk` can block on native OS UI (a save
      // dialog, a share sheet) the user leaves open for minutes without
      // pinning a single room. That wait is why holding leases across the
      // build was worth removing rather than merely bounding.
      return saveBlobToDisk(output.blob, output.suggestedName, fileSave);
    },
    onSuccess: (saved, input) => {
      if (saved !== null) {
        Analytics.getInstance().track(AnalyticsEvent.ArtifactExported, {
          format: input.format,
          artifact_count: input.artifacts.length,
        });
        toastSavedFile(saved, openSaved.mutate, fileSave);
      }
    },
    onError: (error, input) => {
      appLogger.errorSummary(
        "[artifact-export] export failed",
        { artifactCount: input.artifacts.length, format: input.format },
        error,
      );
      toastFromRunnerError(error, "Failed to export artifacts");
    },
  });
}
