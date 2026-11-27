import { v4 as uuidv4 } from "uuid";
import { signedInUserId } from "./sandbox-account-fence";
import {
  stagedSandboxOrdinaryDraftPort,
  type OrdinaryDraftSnapshot,
} from "./staged-sandbox-ordinary-draft-port";

export interface StagedSandboxPress {
  readonly id: string;
  readonly userId: string;
  readonly originalHostId: string | null;
  readonly snapshot: OrdinaryDraftSnapshot;
}

/** Capture before any preparation can re-read a different editor revision. */
export function captureStagedSandboxPress(
  draftId: string | null,
  originalHostId: string | null,
): StagedSandboxPress | null {
  const port = stagedSandboxOrdinaryDraftPort();
  const userId = signedInUserId();
  if (port === null || draftId === null || userId === null) return null;
  const snapshot = port.captureOrdinaryDraftSnapshot(draftId);
  if (snapshot === null || snapshot.write.draftId !== draftId) return null;
  return {
    id: uuidv4(),
    userId,
    originalHostId,
    snapshot: structuredClone(snapshot),
  };
}

export function stagedSandboxPressCurrent(press: StagedSandboxPress): boolean {
  if (signedInUserId() !== press.userId) return false;
  const { snapshot } = press;
  const current = stagedSandboxOrdinaryDraftPort()?.captureOrdinaryDraftSnapshot(
    snapshot.write.draftId,
  );
  return (
    current !== undefined &&
    current !== null &&
    current.scopeId === snapshot.scopeId &&
    current.occurrence === snapshot.occurrence &&
    current.localRevision === snapshot.localRevision &&
    JSON.stringify(current.write) === JSON.stringify(snapshot.write)
  );
}
