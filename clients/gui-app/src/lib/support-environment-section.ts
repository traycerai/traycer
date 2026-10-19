import type {
  EnvironmentReachDiagnosticsResponse,
  EnvironmentSecretsRotationResponse,
  EnvironmentStatusResponse,
  SetupAttempt,
} from "@traycer/protocol/host/environment-schemas";

/**
 * The environment section of a support report: what the selected host says
 * about its environment, as closed codes, typed numbers and the person's own
 * item and secret names. A CLOSED key set: Electron main mirrors every record
 * below with a `contractKeySet` and rejects any other key (`support-ipc.ts`),
 * so a field added here fails there until it is added on purpose.
 *
 * Never a key, by ruling: pending uploads, local overrides, setup script or
 * output, any value, `snapshot.json`, the policy body, profile, cost, routes,
 * private agents, the team name or any owner's label, connector detail.
 */
export interface SupportEnvironmentSection {
  /** The selected host, an opaque reference. */
  readonly hostId: string;
  /** The host's principal as a category only, never the team's name. */
  readonly principal: "personal" | "team" | null;
  readonly reachability: string;
  readonly bindingGeneration: number | null;
  readonly desiredRevision: number | null;
  readonly receivedRevision: number | null;
  readonly appliedRevision: number | null;
  readonly receiptAgeMs: number | null;
  readonly items: readonly SupportEnvironmentItem[];
  /** `null` until the host's setup attempts were read. */
  readonly setupAttempts: readonly SupportEnvironmentSetupAttempt[] | null;
  /** `null` until the account policy was read. Never its body. */
  readonly policy: SupportEnvironmentPolicy | null;
  /** `null` until the host's secrets were listed. */
  readonly rotations: readonly SupportEnvironmentRotation[] | null;
  /**
   * The host's recent same-principal refusals, newest first; `null` until read
   * or on a host that serves none.
   */
  readonly reachDenials: readonly SupportEnvironmentReachDenial[] | null;
  /**
   * The selected task with the principal categories of its other hosts;
   * `null` until read, with no task selected, or on a host that serves none.
   */
  readonly servedTask: SupportEnvironmentServedTask | null;
}

/**
 * One refusal: opaque host and task references and principal categories,
 * never a label, a team's name or an owner's id.
 */
export interface SupportEnvironmentReachDenial {
  readonly denialId: string;
  readonly at: number;
  readonly sourceHostRef: string;
  readonly targetHostRef: string;
  readonly taskRef: string | null;
  readonly reason: string;
  readonly sourcePrincipal: string;
  readonly targetPrincipal: string;
  readonly count: number;
}

export interface SupportEnvironmentServedTask {
  readonly taskRef: string;
  readonly otherHostPrincipals: readonly string[];
}

export interface SupportEnvironmentItem {
  readonly kind: string;
  /** The item's own name (a variable's name, a server's), never its value. */
  readonly key: string;
  readonly os: string;
  readonly status: string;
  readonly code: string;
  readonly args: SupportEnvironmentItemArgs;
}

export interface SupportEnvironmentItemArgs {
  readonly exitStatus: number | null;
  readonly stage: string | null;
  readonly durationMs: number | null;
  readonly kind: string | null;
}

/** A typed setup attempt: never the script, never its output. */
export interface SupportEnvironmentSetupAttempt {
  readonly attemptId: string;
  readonly scriptHash: string;
  readonly trigger: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly exitStatus: number | null;
  readonly stageReached: string | null;
  readonly result: string | null;
}

export interface SupportEnvironmentPolicy {
  readonly source: string;
  readonly readState: string;
  /**
   * A team host's policy state (`none`, `applied`, `lapsed`); null on a
   * personal host or a host older than `autoPolicy.get@1.1`.
   */
  readonly teamState: string | null;
  /** The applied team policy's version (its row revision), or null. */
  readonly teamPolicyVersion: string | null;
}

/** One secret's current rotation, in the `secret.rotated` payload's shape. */
export interface SupportEnvironmentRotation {
  readonly secretName: string;
  readonly state: string;
  readonly producers: readonly SupportEnvironmentRotationProducer[];
}

/**
 * The `secret.rotated` payload's producer (`hostNotificationRotationProducer
 * Schema`), with `hostName` always null: a host travels as its opaque id.
 */
export interface SupportEnvironmentRotationProducer {
  readonly producer: string;
  readonly workerClass: string | null;
  readonly hostId: string | null;
  readonly hostName: null;
  readonly status: string;
  readonly evidence: readonly SupportEnvironmentRotationEvidence[] | null;
}

export interface SupportEnvironmentRotationEvidence {
  readonly kind: string;
  readonly count: number | null;
}

/**
 * The longest each text field may be. The two names are the person's own:
 * an item key is bounded by the account's item routes (3072), a secret name
 * by the account's secret name rule (128); the protocol wire leaves both
 * open. Every other text field is a closed code, a hash or an opaque id.
 * Electron main holds the same table and refuses a longer value.
 */
export const SUPPORT_ENVIRONMENT_TEXT_MAX = {
  itemKey: 3072,
  secretName: 128,
  code: 64,
  hash: 128,
  id: 256,
} as const;

function capped(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function code(value: string): string {
  return capped(value, SUPPORT_ENVIRONMENT_TEXT_MAX.code);
}

function nullableCode(value: string | null): string | null {
  return value === null ? null : code(value);
}

function id(value: string): string {
  return capped(value, SUPPORT_ENVIRONMENT_TEXT_MAX.id);
}

/** One secret's name with its rotation read, as the bridge collects them. */
export interface SupportEnvironmentRotationRead {
  readonly secretName: string;
  readonly rotation: EnvironmentSecretsRotationResponse["rotation"];
}

export interface SupportEnvironmentReads {
  readonly hostId: string;
  readonly status: EnvironmentStatusResponse;
  readonly setupAttempts: readonly SetupAttempt[] | null;
  /** The account policy's source and read state, as its panel reads them. */
  readonly policy: SupportEnvironmentPolicy | null;
  /** `null` until listed; a secret with no rotation is left out. */
  readonly rotations: readonly SupportEnvironmentRotationRead[] | null;
  /** `null` until read, or on a host older than the read. */
  readonly reachDiagnostics: EnvironmentReachDiagnosticsResponse | null;
}

type RotationProducerRead = NonNullable<
  EnvironmentSecretsRotationResponse["rotation"]
>["producers"][number];

function rotationProducer(
  producer: RotationProducerRead,
): SupportEnvironmentRotationProducer {
  const evidence =
    producer.evidence === null
      ? null
      : producer.evidence.map((entry) => ({
          kind: code(entry.kind),
          count: entry.count,
        }));
  if (producer.producer === "worker") {
    return {
      producer: "worker",
      workerClass: code(producer.workerClass),
      hostId: null,
      hostName: null,
      status: code(producer.status),
      evidence,
    };
  }
  return {
    producer: "host",
    workerClass: null,
    hostId: id(producer.hostId),
    hostName: null,
    status: code(producer.status),
    evidence,
  };
}

/** Builds the section from the selected host's reads, field by field. */
export function supportEnvironmentSection(
  reads: SupportEnvironmentReads,
): SupportEnvironmentSection {
  const { status } = reads;
  return {
    hostId: id(reads.hostId),
    principal: status.principal === null ? null : status.principal.kind,
    reachability: code(status.reachability),
    bindingGeneration: status.bindingGeneration,
    desiredRevision: status.desiredRevision,
    receivedRevision: status.receivedRevision,
    appliedRevision: status.appliedRevision,
    receiptAgeMs: status.receiptAgeMs,
    items: status.items.map((item) => {
      // Destructured, not `item.key` / `item.code`: the keyboard-read
      // inventory counts a `.key` read beside a `.code` read as a key event.
      const { key, code: itemCode } = item;
      return {
        kind: code(item.kind),
        key: capped(key, SUPPORT_ENVIRONMENT_TEXT_MAX.itemKey),
        os: code(item.os),
        status: code(item.status),
        code: code(itemCode),
        args: {
          exitStatus: item.args.exitStatus,
          stage: nullableCode(item.args.stage),
          durationMs: item.args.durationMs,
          kind: nullableCode(item.args.kind),
        },
      };
    }),
    setupAttempts:
      reads.setupAttempts === null
        ? null
        : reads.setupAttempts.map((attempt) => ({
            attemptId: id(attempt.attemptId),
            scriptHash: capped(
              attempt.scriptHash,
              SUPPORT_ENVIRONMENT_TEXT_MAX.hash,
            ),
            trigger: code(attempt.trigger),
            startedAt: attempt.startedAt,
            endedAt: attempt.endedAt,
            exitStatus: attempt.exitStatus,
            stageReached: nullableCode(attempt.stageReached),
            result: nullableCode(attempt.result),
          })),
    policy:
      reads.policy === null
        ? null
        : {
            source: code(reads.policy.source),
            readState: code(reads.policy.readState),
            teamState: nullableCode(reads.policy.teamState),
            teamPolicyVersion: nullableCode(reads.policy.teamPolicyVersion),
          },
    rotations:
      reads.rotations === null
        ? null
        : reads.rotations.flatMap((read) =>
            read.rotation === null
              ? []
              : [
                  {
                    secretName: capped(
                      read.secretName,
                      SUPPORT_ENVIRONMENT_TEXT_MAX.secretName,
                    ),
                    state: code(read.rotation.state),
                    producers: read.rotation.producers.map(rotationProducer),
                  },
                ],
          ),
    reachDenials:
      reads.reachDiagnostics === null
        ? null
        : reads.reachDiagnostics.denials.map((denial) => ({
            denialId: id(denial.denialId),
            at: denial.at,
            sourceHostRef: id(denial.sourceHostRef),
            targetHostRef: id(denial.targetHostRef),
            taskRef: denial.taskRef === null ? null : id(denial.taskRef),
            reason: code(denial.reason),
            sourcePrincipal: code(denial.sourcePrincipal),
            targetPrincipal: code(denial.targetPrincipal),
            count: denial.count,
          })),
    servedTask:
      reads.reachDiagnostics === null ||
      reads.reachDiagnostics.servedTask === null
        ? null
        : {
            taskRef: id(reads.reachDiagnostics.servedTask.taskRef),
            otherHostPrincipals:
              reads.reachDiagnostics.servedTask.otherHostPrincipals.map(code),
          },
  };
}
