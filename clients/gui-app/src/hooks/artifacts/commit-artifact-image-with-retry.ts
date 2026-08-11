import type { CommitArtifactImageResponse } from "@traycer/protocol/host/epic/unary-schemas";

const FINISH_RETRY_DELAY_MS = 25;
const FINISH_ATTEMPTS = 3;

export async function commitArtifactImageWithRetry(
  commit: (
    artifactId: string,
    operationId: string,
  ) => Promise<CommitArtifactImageResponse>,
  artifactId: string,
  operationId: string,
): Promise<void> {
  for (let attempt = 0; attempt < FINISH_ATTEMPTS; attempt += 1) {
    const response = await commit(artifactId, operationId);
    if ("committed" in response) return;
    if (response.status === "unknown-operation") {
      throw new Error("The artifact image operation is no longer available.");
    }
    if (attempt < FINISH_ATTEMPTS - 1) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, FINISH_RETRY_DELAY_MS),
      );
    }
  }
  throw new Error("The artifact image could not be committed.");
}
