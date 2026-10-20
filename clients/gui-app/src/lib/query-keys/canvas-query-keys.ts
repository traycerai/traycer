import type { SandboxSource } from "@/components/sandbox/sandbox-frame";

export const canvasQueryKeys = {
  source: (
    artifactId: string,
    path: string,
    hash: string | null,
    source: SandboxSource | null,
  ) =>
    [
      "canvas.source",
      artifactId,
      path,
      hash,
      // The reader only consumes this immutable object, not sibling manifest files
      // or the serving callbacks. A sibling's capture must not reload this source.
      source?.kind === "artifact"
        ? {
            artifactId: source.artifactId,
            entryPath: source.entryPath,
            object: Object.hasOwn(source.manifest.files, source.entryPath)
              ? source.manifest.files[source.entryPath]
              : null,
          }
        : null,
    ] as const,
};
