import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createArtifactExport,
  type ArtifactExportFormat,
} from "@/lib/artifacts/artifact-export";
import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";
import { appLogger } from "@/lib/logger";
import { epicMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";

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

  return useMutation<string | null, Error, EpicExportArtifactsInput>({
    mutationKey: epicMutationKeys.exportArtifacts(),
    mutationFn: async (input) => {
      const firstArtifact = input.artifacts.at(0);
      if (firstArtifact === undefined) {
        throw new Error("Select at least one artifact to export.");
      }
      const state = epicHandle.store.getState();
      const artifacts = input.artifacts.map((artifact) => {
        const fragment = state.getArtifactFragment(artifact.id);
        if (fragment === null) {
          throw new Error(`“${artifact.title}” is still loading.`);
        }
        return { ...artifact, fragment };
      });
      const output = await createArtifactExport({
        artifacts,
        format: input.format,
        archive: input.archive,
        archiveTitle: input.archiveTitle ?? firstArtifact.title,
      });
      return saveBlobToDisk(output.blob, output.suggestedName);
    },
    onSuccess: (saved) => {
      if (saved !== null) toast.success(`Saved ${saved}`);
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
