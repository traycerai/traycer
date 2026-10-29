import type {
  StageConfiguration,
  StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import type { DesktopJsonValue } from "@/lib/windows/types";
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

export function sameReturnedSandbox(
  a: ReturnedSandbox | null,
  b: ReturnedSandbox | null,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The destination as plain JSON, for a store that takes no interfaces. */
export function returnedSandboxToJson(
  returned: ReturnedSandbox,
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
  };
}

/** Rebuilds a persisted destination field by field: storage is untrusted. */
export function parseReturnedSandbox(value: unknown): ReturnedSandbox | null {
  if (!isRecord(value)) return null;
  const target = parseTarget(value.target);
  if (target === null) return null;
  return {
    target,
    clientRequestId:
      typeof value.clientRequestId === "string" ? value.clientRequestId : null,
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
