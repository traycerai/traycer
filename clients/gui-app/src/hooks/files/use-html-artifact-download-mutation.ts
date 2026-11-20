import { anyAbortSignal } from "@traycer-clients/shared/auth/request-abort";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
import {
  createHtmlArtifactZip,
  htmlArtifactZipName,
} from "@/lib/artifacts/html-artifact-download";
import {
  downloadBlobToDevice,
  type SavedFile,
} from "@/lib/files/save-blob-to-disk";
import { toastSavedFile } from "@/lib/files/saved-file-toast";
import { toastFromHostError } from "@/lib/host-error-toast";
import { epicMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import {
  artifactReadIsCurrent,
  assertArtifactReadLive,
  type ArtifactReadLifetime,
} from "@/lib/artifacts/artifact-read-lifetime";

interface HtmlArtifactDownloadInput {
  readonly source: Extract<SandboxSource, { kind: "artifact" }>;
  readonly title: string;
  readonly lifetime: ArtifactReadLifetime | null;
}

export function useHtmlArtifactDownload(
  hostId: string,
  artifactId: string,
): UseMutationResult<SavedFile | null, Error, HtmlArtifactDownloadInput> {
  const fileSave = useFileSaveHost();
  const openSaved = useOpenSavedFile();
  return useMutation<SavedFile | null, Error, HtmlArtifactDownloadInput>({
    mutationKey: epicMutationKeys.downloadHtmlArtifact(hostId, artifactId),
    // Bound memory across inline and full-view exports in this renderer, too.
    scope: { id: "html-artifact-download" },
    gcTime: 0,
    mutationFn: async ({ source, title, lifetime }) => {
      assertArtifactReadLive(lifetime);
      // Freeze the manifest and its bound reader in mutation variables. A
      // version switch while downloading cannot change the exported snapshot.
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("The download timed out. Try again.")),
        120_000,
      );
      const blob = await createHtmlArtifactZip({
        manifest: source.manifest,
        readSpan: source.readSpan,
        signal:
          lifetime === null
            ? controller.signal
            : anyAbortSignal([controller.signal, lifetime.signal]),
      }).finally(() => clearTimeout(timeout));
      assertArtifactReadLive(lifetime);
      const saved = await downloadBlobToDevice(
        blob,
        htmlArtifactZipName(title),
        fileSave,
        lifetime === null ? null : () => assertArtifactReadLive(lifetime),
      );
      assertArtifactReadLive(lifetime);
      return saved;
    },
    onSuccess: (saved, { lifetime }) => {
      if (!artifactReadIsCurrent(lifetime)) return;
      if (saved !== null)
        toastSavedFile(saved, openSaved.mutate, fileSave, "save");
    },
    onError: (error, { lifetime }) => {
      if (!artifactReadIsCurrent(lifetime)) return;
      if (error instanceof HostRpcError) {
        toastFromHostError(error, "Could not download this artifact.");
      } else {
        toastFromRunnerError(error, "Could not download this artifact.");
      }
    },
  });
}
