import type { SandboxGetFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { AuthService } from "@/lib/auth/auth-service";
import { signedInUserId } from "@/lib/sandboxes/sandbox-account-fence";

export interface SandboxRowRead {
  readonly row: SandboxSummary | null;
  readonly sentAt: number;
}

export function sandboxRowNotFound(result: SandboxGetFetchResult): boolean {
  return (
    result.kind === "refused" &&
    result.status === 404 &&
    result.code === SANDBOX_REFUSAL_CODE_NOT_FOUND
  );
}

/** Only the exact signed-in row or a typed absence can settle a known ID. */
export async function readKnownSandboxRow(
  auth: AuthService,
  sandboxId: string,
  userId: string | null,
): Promise<SandboxRowRead | null> {
  if (signedInUserId() !== userId) return null;
  const sentAt = Date.now();
  try {
    const result = await auth.getSandbox(sandboxId);
    if (signedInUserId() !== userId) return null;
    if (result.kind === "ok" && result.sandbox.id === sandboxId)
      return { row: result.sandbox, sentAt };
    if (sandboxRowNotFound(result)) return { row: null, sentAt };
  } catch {
    // An unreadable row is still unknown.
  }
  return null;
}
