import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";

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
