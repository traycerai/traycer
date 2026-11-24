import type {
  StageConfiguration,
  StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import type { SandboxCreateRequest } from "@traycer/protocol/host/sandbox-control";
import { z } from "zod";
import { v5 as uuidv5 } from "uuid";
import { sandboxCreateKey } from "@/lib/sandboxes/sandbox-create-key";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { useAuthStore } from "@/stores/auth/auth-store";
import type {
  StagedSandbox,
  StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";

/**
 * The sandbox a draft's given-back message was going to, kept with that
 * draft: its composer stages it again when it holds no pick of its own, so
 * the draft's Send goes there even after a reload.
 */
export interface ReturnedSandbox {
  readonly target: StagedSandboxTarget;
  /** The stage's stable identity and original create key. */
  readonly clientRequestId: string | null;
  /** A later create's key, when a retry has moved on from the original key. */
  readonly lastCreateKey?: string;
  /** The exact request that went out under that key. */
  readonly lastRetryCreate?: SandboxCreateRequest;
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

export type ReturnedSandboxDraft = (
  | { readonly kind: "landing"; readonly draftId: string }
  | {
      readonly kind: "task";
      readonly draftId: string | null;
      readonly epicId: string;
    }
) & {
  readonly userId: string;
  readonly stageId: string;
};

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
    ...(returned.lastCreateKey === undefined
      ? {}
      : { lastCreateKey: returned.lastCreateKey }),
    ...(returned.lastRetryCreate === undefined
      ? {}
      : { lastRetryCreate: returned.lastRetryCreate }),
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

/** A legacy return derives a stage identity from its durable draft occurrence. */
export function returnedSandboxForDraft(
  stored: StoredReturnedSandbox | null,
  userId: string | null,
  kind: "task" | "landing",
  draftId: string | null,
): StoredReturnedSandbox | null {
  const returned = returnedSandboxFor(stored, userId);
  if (
    returned === null ||
    returned.target.kind === "existing" ||
    returned.clientRequestId !== null
  )
    return returned;
  if (draftId === null)
    return returned.lastCreateKey === undefined
      ? null
      : { ...returned, clientRequestId: returned.lastCreateKey };
  return {
    ...returned,
    clientRequestId: sandboxCreateKey(
      "stage",
      uuidv5(`returned-sandbox:${kind}:${draftId}`, uuidv5.URL),
    ),
  };
}

export function returnedSandboxWithCreate(
  stored: StoredReturnedSandbox | null,
  origin: ReturnedSandboxDraft,
  request: SandboxCreateRequest,
): StoredReturnedSandbox | null {
  const key = request.clientRequestId;
  if (key === null) return null;
  const current = returnedSandboxForDraft(
    stored,
    origin.userId,
    origin.kind,
    origin.draftId,
  );
  if (
    current?.clientRequestId !== origin.stageId ||
    current.target.kind !== "new"
  )
    return null;
  if (
    current.lastRetryCreate?.clientRequestId === key &&
    JSON.stringify(current.lastRetryCreate) !== JSON.stringify(request)
  )
    return null;
  return { ...current, lastCreateKey: key, lastRetryCreate: request };
}

export function returnedSandboxCreateMatches(
  saved: StoredReturnedSandbox | null | undefined,
  origin: ReturnedSandboxDraft,
  request: SandboxCreateRequest,
): boolean {
  return (
    saved?.userId === origin.userId &&
    saved.clientRequestId === origin.stageId &&
    saved.lastCreateKey === request.clientRequestId &&
    JSON.stringify(saved.lastRetryCreate) === JSON.stringify(request)
  );
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

/** A payload update is part of the same restore, including its cleanup mark. */
export function updateReturnedSandboxRestore(
  surfaceKey: string,
  next: StoredReturnedSandbox,
): void {
  const restored = restoredBySurface.get(surfaceKey);
  if (restored?.clientRequestId === next.clientRequestId)
    restoredBySurface.set(surfaceKey, next);
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
 * sandbox not yet created is known by its create key. Legacy returned
 * drafts without a key can only match their original pick.
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
  return JSON.stringify(target) === JSON.stringify(returned.target);
}

/** Whether two returned sandboxes name the same destination and last create. */
export function sameReturnedSandbox(
  a: ReturnedSandbox | null,
  b: ReturnedSandbox | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.clientRequestId === b.clientRequestId &&
    a.lastCreateKey === b.lastCreateKey &&
    JSON.stringify(a.lastRetryCreate) === JSON.stringify(b.lastRetryCreate) &&
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
    ...(returned.lastCreateKey === undefined
      ? {}
      : { lastCreateKey: returned.lastCreateKey }),
    ...(returned.lastRetryCreate === undefined
      ? {}
      : { lastRetryCreate: { ...returned.lastRetryCreate } }),
    userId: returned.userId,
  };
}

const createKeySchema = z.string().min(1).max(64);
const lastRetryCreateSchema: z.ZodType<SandboxCreateRequest> = z.object({
  os: z.enum(["linux", "windows"]),
  cpus: z.number().positive().max(1024),
  memoryMb: z.number().int().positive(),
  diskMb: z.number().int().positive().nullable(),
  region: z.string().min(1).max(32).nullable(),
  displayName: z.string().min(1).max(191),
  idleMinutes: z.number().int().positive().nullable(),
  burst: z.literal(false),
  createdByHostId: z.null(),
  createdByAgentId: z.null(),
  environmentId: z.string().min(1).nullable(),
  destroyAfterRestingMinutes: z.number().int().nonnegative().nullable(),
  createdByTaskId: z.string().min(1).max(64).nullable(),
  clientRequestId: createKeySchema,
});

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
  const lastCreateKey = createKeySchema.safeParse(value.lastCreateKey);
  const lastRetryCreate = lastRetryCreateSchema.safeParse(
    value.lastRetryCreate,
  );
  return {
    target,
    clientRequestId:
      typeof value.clientRequestId === "string" ? value.clientRequestId : null,
    ...(target.kind === "new" && lastCreateKey.success
      ? {
          lastCreateKey: lastCreateKey.data,
          ...(lastRetryCreate.success &&
          lastRetryCreate.data.clientRequestId === lastCreateKey.data
            ? { lastRetryCreate: lastRetryCreate.data }
            : {}),
        }
      : {}),
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
