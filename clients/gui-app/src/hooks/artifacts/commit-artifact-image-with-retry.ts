import type { CommitArtifactImageResponse } from "@traycer/protocol/host/epic/unary-schemas";

const FINISH_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800] as const;

export async function commitArtifactImageWithRetry(
  commit: (
    artifactId: string,
    operationId: string,
  ) => Promise<CommitArtifactImageResponse>,
  artifactId: string,
  operationId: string,
): Promise<void> {
  for (
    let attempt = 0;
    attempt <= FINISH_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    const response = await commit(artifactId, operationId);
    if ("committed" in response) return;
    if (response.status === "unknown-operation") {
      throw new Error("The artifact image operation is no longer available.");
    }
    if (attempt < FINISH_RETRY_DELAYS_MS.length) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, FINISH_RETRY_DELAYS_MS[attempt]),
      );
    }
  }
  throw new Error("The artifact image could not be committed.");
}
