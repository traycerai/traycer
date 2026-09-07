import { readFile } from "node:fs/promises";
import { readPidMetadata } from "./host-lifecycle";

export interface LocalHostIdentityFiles {
  readonly identityEnrollmentFile: string;
  readonly pidMetadataFile: string;
}

type EnrollmentRead =
  | { readonly kind: "enrolled"; readonly hostId: string }
  /** No file (ENOENT): a legacy install that predates the enrollment record. */
  | { readonly kind: "absent" }
  /**
   * The record EXISTS but cannot answer - unreadable, unparseable, or missing its `hostId`.
   * Not the same fact as absent: an existing record proves this install HAS enrollment machinery, so its content being momentarily unusable must not hand the decision to a lower-trust.
   */
  | { readonly kind: "unusable" };

/** The `hostId` from the host's durable enrollment record. */
export async function readEnrolledHostId(
  path: string,
): Promise<EnrollmentRead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { kind: "absent" };
    }
    return { kind: "unusable" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return { kind: "unusable" };
    }
    const hostId = (parsed as Record<string, unknown>).hostId;
    return typeof hostId === "string" && hostId.length > 0
      ? { kind: "enrolled", hostId }
      : { kind: "unusable" };
  } catch {
    return { kind: "unusable" };
  }
}

/** The two anonymous cases are DIFFERENT facts and are kept apart because a caller enforcing an identity fence must treat them differently: - `unverifiable`. */
export type LocalHostIdentity =
  | { readonly kind: "named"; readonly hostId: string }
  | { readonly kind: "unverifiable" }
  | { readonly kind: "unenrolled" };

export async function classifyLocalHostIdentity(
  files: LocalHostIdentityFiles,
): Promise<LocalHostIdentity> {
  const enrollment = await readEnrolledHostId(files.identityEnrollmentFile);
  if (enrollment.kind === "enrolled") {
    return { kind: "named", hostId: enrollment.hostId };
  }
  if (enrollment.kind === "unusable") return { kind: "unverifiable" };
  const metadata = await readPidMetadata(files.pidMetadataFile);
  return metadata === null
    ? { kind: "unenrolled" }
    : { kind: "named", hostId: metadata.hostId };
}

export async function readLastKnownLocalHostId(
  files: LocalHostIdentityFiles,
): Promise<string | null> {
  const identity = await classifyLocalHostIdentity(files);
  return identity.kind === "named" ? identity.hostId : null;
}
