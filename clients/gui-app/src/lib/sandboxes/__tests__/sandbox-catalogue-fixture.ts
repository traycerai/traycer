import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import type { StageSize } from "@/lib/sandboxes/sandbox-stage-model";

export function budgetCatalogue(createBudgetMs: number): SandboxCatalogue {
  return {
    providers: [
      {
        provider: "tensorlake",
        os: ["linux"],
        createBudgetMs,
        shape: {
          cpuMin: 1,
          cpuMax: 16,
          cpuStep: 1,
          memoryPerCpuMinMb: 1024,
          memoryPerCpuMaxMb: 8192,
          memoryMinMb: 1024,
          memoryMaxMb: 65536,
          memoryStepMb: 1024,
          diskMinMb: 10240,
          diskStepMb: 1024,
          diskMaxMb: 102400,
          diskDefaultMb: 20480,
        },
        shapes: null,
        suspendFidelity: "memory",
        stoppedStorage: "snapshot",
        wakeClass: "resume",
        dockerInGuest: true,
        creatable: true,
        notCreatableReason: null,
        regions: [
          {
            id: "us-east",
            label: "US East",
            pricing: null,
            fromPriceMcPerHour: { awakeMc: 80, suspendedMc: 4, stoppedMc: 2 },
          },
        ],
      },
    ],
  };
}

/** The staged size every readiness fixture answers: the fixture's default 2 vCPU · 4 GB · 20 GB rung. */
export const READINESS_SIZE: StageSize = {
  os: "linux",
  cpus: 2,
  memoryMb: 4096,
  diskMb: null,
  region: "us-east",
};

const MS_PER_MINUTE = 60_000;

/**
 * One provider whose served contextual readiness answers `READINESS_SIZE`
 * and whose create duration is whatever the server sent: a number, `null`
 * (nothing recorded), or `undefined` (the field absent, as an older server
 * sends it).
 */
export function readinessCatalogue(input: {
  readonly warm: number | null;
  readonly coldCreateMeasuredMs: number | null | undefined;
}): SandboxCatalogue {
  const [provider] = budgetCatalogue(480_000).providers;
  return {
    providers: [
      {
        ...provider,
        ...(input.coldCreateMeasuredMs === undefined
          ? {}
          : { coldCreateMeasuredMs: input.coldCreateMeasuredMs }),
        readiness: {
          request: {
            os: "linux",
            shape: { cpus: 2, memoryMb: 4096, diskMb: 20480 },
            region: "us-east",
            generationId: null,
            launchForm: {
              kind: "template",
              object: "gs://templates/platform-v1/manifest.json",
              digest: "a".repeat(64),
            },
          },
          result: { warm: input.warm },
        },
      },
    ],
  };
}

/** The sentence a whole number of served minutes reads as. */
export function durationSentence(servedMs: number): string {
  const minutes = servedMs / MS_PER_MINUTE;
  return `This create takes about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

export const READY_SENTENCE = "Ready to start.";

/** A whole number of minutes, in the unit the server serves. */
export function servedMinutes(minutes: number): number {
  return minutes * MS_PER_MINUTE;
}
