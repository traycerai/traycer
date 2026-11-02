import type {
  StageConfiguration,
  StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { useAuthStore } from "@/stores/auth/auth-store";
import type {
  StagedSandbox,
  StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";

/**
 * The sandbox a draft's given-back message was going to, kept with that
 * draft: its composer stages it again when it holds no pick of its own, so
 * the draft's Send goes there even after a reload. `clientRequestId` is a
 * create the server may have accepted, named again rather than billed twice.
 */
export interface ReturnedSandbox {
  readonly target: StagedSandboxTarget;
  readonly clientRequestId: string | null;
}

/**
 * A returned sandbox as a draft keeps it, with the account it was returned
 * under. Drafts are this window's, not an account's: only that account's
 * composer restores it, so the next account never sends into its team or
 * names its create again.
 */
export interface StoredReturnedSandbox extends ReturnedSandbox {
  readonly userId: string | null;
}

/**
 * Stamps a returned sandbox with the signed-in account. One already stored
 * keeps its own: an undo puts it back as it was.
 */
export function storeReturnedSandbox(
  returned: ReturnedSandbox | StoredReturnedSandbox,
): StoredReturnedSandbox {
  return {
    target: returned.target,
    clientRequestId: returned.clientRequestId,
    userId:
      "userId" in returned
        ? returned.userId
        : (useAuthStore.getState().contextMetadata?.userId ?? null),
  };
}

/** The draft's returned sandbox if `userId`'s account returned it, else null. */
export function returnedSandboxFor(
  stored: StoredReturnedSandbox | null,
  userId: string | null,
): StoredReturnedSandbox | null {
  return stored !== null && userId !== null && stored.userId === userId
    ? stored
    : null;
}

const supersedeBySurface = new Map<string, () => void>();

/**
 * The active composer on `surfaceKey` forgets its draft's returned sandbox
 * when the person picks a placement there. Returns the unsubscribe.
 */
export function onReturnedSandboxSuperseded(
  surfaceKey: string,
  forget: () => void,
): () => void {
  supersedeBySurface.set(surfaceKey, forget);
  return () => {
    if (supersedeBySurface.get(surfaceKey) === forget)
      supersedeBySurface.delete(surfaceKey);
  };
}

/**
 * The returned sandbox a composer restored onto each surface. Only a stage
 * restored there is ever released; a pick drops the mark. In memory only, as
 * composer stages are: a reload restores, and marks, again.
 */
const restoredBySurface = new Map<string, ReturnedSandbox>();

/** A placement the person picked on `surfaceKey` supersedes a returned sandbox. */
export function supersedeReturnedSandbox(surfaceKey: string): void {
  restoredBySurface.delete(surfaceKey);
  supersedeBySurface.get(surfaceKey)?.();
}

/** Records that `returned` was restored onto `surfaceKey`. */
export function markReturnedSandboxRestored(
  surfaceKey: string,
  returned: ReturnedSandbox,
): void {
  restoredBySurface.set(surfaceKey, returned);
}

/** Whether the stage on `surfaceKey` was restored, not picked. */
export function returnedSandboxRestoredOn(surfaceKey: string): boolean {
  return restoredBySurface.has(surfaceKey);
}

/**
 * Takes the surface's mark if it is `returned`'s, and says whether it was. A
 * different one is a newer restore's, and stays for it to release.
 */
export function takeReturnedSandboxRestored(
  surfaceKey: string,
  returned: ReturnedSandbox,
): boolean {
  if (!sameReturnedSandbox(restoredBySurface.get(surfaceKey) ?? null, returned))
    return false;
  restoredBySurface.delete(surfaceKey);
  return true;
}

/**
 * Whether a stage is the returned destination, not a pick of the person's. A
 * sandbox not yet created is known by its create key; one whose create was
 * never sent has none, and is the unstarted stage of the same request.
 */
export function stageIsReturnedSandbox(
  stage: StagedSandbox | null,
  returned: ReturnedSandbox,
): boolean {
  if (stage === null) return false;
  const { target } = stage;
  if (returned.target.kind === "existing")
    return (
      target.kind === "existing" &&
      target.sandboxId === returned.target.sandboxId
    );
  if (target.kind !== "new") return false;
  if (returned.clientRequestId !== null)
    return stage.clientRequestId === returned.clientRequestId;
  return (
    stage.clientRequestId === null &&
    JSON.stringify(target) === JSON.stringify(returned.target)
  );
}

/** Whether two returned sandboxes name the same destination and create key. */
export function sameReturnedSandbox(
  a: ReturnedSandbox | null,
  b: ReturnedSandbox | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.clientRequestId === b.clientRequestId &&
    JSON.stringify(a.target) === JSON.stringify(b.target)
  );
}

/** The same destination, returned under the same account. */
export function sameStoredReturnedSandbox(
  a: StoredReturnedSandbox | null,
  b: StoredReturnedSandbox | null,
): boolean {
  return sameReturnedSandbox(a, b) && a?.userId === b?.userId;
}

/** The destination as plain JSON, for a store that takes no interfaces. */
export function returnedSandboxToJson(
  returned: StoredReturnedSandbox,
): DesktopJsonValue {
  const { target } = returned;
  const configuration: DesktopJsonValue =
    target.configuration.kind === "personal"
      ? { kind: "personal" }
      : {
          kind: "team",
          teamId: target.configuration.teamId,
          teamName: target.configuration.teamName,
        };
  return {
    target:
      target.kind === "existing"
        ? {
            kind: "existing",
            hostId: target.hostId,
            sandboxId: target.sandboxId,
            name: target.name,
            configuration,
            verb: target.verb,
          }
        : {
            kind: "new",
            configuration,
            shape: { ...target.shape },
            name: target.name,
            wakeString: target.wakeString,
          },
    clientRequestId: returned.clientRequestId,
    userId: returned.userId,
  };
}

/**
 * Rebuilds a persisted destination field by field: storage is untrusted. One
 * kept without an account is no account's, and is never restored.
 */
export function parseReturnedSandbox(
  value: unknown,
): StoredReturnedSandbox | null {
  if (!isRecord(value)) return null;
  const target = parseTarget(value.target);
  if (target === null) return null;
  return {
    target,
    clientRequestId:
      typeof value.clientRequestId === "string" ? value.clientRequestId : null,
    userId: typeof value.userId === "string" ? value.userId : null,
  };
}

function parseTarget(value: unknown): StagedSandboxTarget | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  const configuration = parseConfiguration(value.configuration);
  if (configuration === null) return null;
  if (value.kind === "existing") {
    if (
      typeof value.hostId !== "string" ||
      typeof value.sandboxId !== "string" ||
      (value.verb !== "resume" && value.verb !== "start")
    )
      return null;
    return {
      kind: "existing",
      hostId: value.hostId,
      sandboxId: value.sandboxId,
      name: value.name,
      configuration,
      verb: value.verb,
    };
  }
  if (value.kind !== "new") return null;
  const shape = parseShape(value.shape);
  if (shape === null) return null;
  return {
    kind: "new",
    configuration,
    shape,
    name: value.name,
    wakeString: typeof value.wakeString === "string" ? value.wakeString : null,
  };
}

function parseConfiguration(value: unknown): StageConfiguration | null {
  if (!isRecord(value)) return null;
  if (value.kind === "personal") return { kind: "personal" };
  if (
    value.kind === "team" &&
    typeof value.teamId === "string" &&
    typeof value.teamName === "string"
  )
    return { kind: "team", teamId: value.teamId, teamName: value.teamName };
  return null;
}

function parseShape(value: unknown): StageShape | null {
  if (
    !isRecord(value) ||
    (value.os !== "linux" && value.os !== "windows") ||
    typeof value.cpus !== "number" ||
    typeof value.memoryMb !== "number" ||
    typeof value.region !== "string" ||
    typeof value.idleMinutes !== "number"
  )
    return null;
  return {
    os: value.os,
    cpus: value.cpus,
    memoryMb: value.memoryMb,
    diskMb: typeof value.diskMb === "number" ? value.diskMb : null,
    region: value.region,
    idleMinutes: value.idleMinutes,
    destroyAfterRestingMinutes:
      typeof value.destroyAfterRestingMinutes === "number"
        ? value.destroyAfterRestingMinutes
        : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
