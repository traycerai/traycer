import type {
  SandboxCatalogue,
  SandboxSummary,
  SandboxShapeRung,
} from "@traycer/protocol/host/sandbox-control";

const GIB = 1024;
const GROWS_TO = { cpus: 16, memoryMb: 64 * GIB } as const;

export const AUTO_SIZING_GROWING_SUMMARY_OVERRIDES: Partial<SandboxSummary> = {
  cpus: 2,
  memoryMb: 4 * GIB,
  diskMb: 50 * GIB,
  grows: GROWS_TO,
  priceMcPerHour: {
    // A 2/4 start, last awake at 4/8.
    awakeMc: 263,
    suspendedMc: 7,
    stoppedMc: 7,
    offer: { startAwakeMc: 135, ceilingAwakeMc: 1_444 },
  },
};

export const AUTO_SIZING_RUNGS: readonly SandboxShapeRung[] = [
  {
    cpus: 2,
    memoryMb: 4 * GIB,
    diskMb: 50 * GIB,
    default: true,
    grows: GROWS_TO,
  },
  {
    cpus: 4,
    memoryMb: 8 * GIB,
    diskMb: 50 * GIB,
    default: false,
    grows: GROWS_TO,
  },
  {
    cpus: 8,
    memoryMb: 16 * GIB,
    diskMb: 50 * GIB,
    default: false,
    grows: GROWS_TO,
  },
  {
    cpus: 8,
    memoryMb: 32 * GIB,
    diskMb: 50 * GIB,
    default: false,
    grows: GROWS_TO,
  },
  {
    cpus: 16,
    memoryMb: 32 * GIB,
    diskMb: 50 * GIB,
    default: false,
    grows: GROWS_TO,
  },
  {
    cpus: 16,
    memoryMb: 64 * GIB,
    diskMb: 50 * GIB,
    default: false,
    grows: GROWS_TO,
  },
];

export function autoSizingCatalogue(): SandboxCatalogue {
  return {
    providers: [
      {
        provider: "firecracker",
        os: ["linux"],
        shape: {
          cpuMin: 2,
          cpuMax: 16,
          cpuStep: 2,
          memoryPerCpuMinMb: 2048,
          memoryPerCpuMaxMb: 8192,
          memoryMinMb: 4096,
          memoryMaxMb: 65536,
          memoryStepMb: 1024,
          diskMinMb: 10 * GIB,
          diskMaxMb: 200 * GIB,
          diskDefaultMb: 50 * GIB,
        },
        shapes: AUTO_SIZING_RUNGS,
        suspendFidelity: "disk",
        stoppedStorage: "disk",
        wakeClass: "resume",
        dockerInGuest: true,
        creatable: true,
        notCreatableReason: null,
        regions: [
          {
            id: "us-east",
            label: "US East",
            pricing: {
              vcpuHourMillicredits: 37.8,
              memoryGbHourMillicredits: 13,
              diskGbHourMillicredits: 0.137,
              suspendedMemoryGbHourMillicredits: 0,
              awakeDiskGbHourMillicredits: 0,
              multiplier: 1,
            },
            fromPriceMcPerHour: { awakeMc: 135, suspendedMc: 7, stoppedMc: 7 },
          },
        ],
      },
    ],
  };
}

export function autoSizingListedNoRatesCatalogue(): SandboxCatalogue {
  const catalogue = autoSizingCatalogue();
  const [provider] = catalogue.providers;
  const [region] = provider.regions;
  return {
    ...catalogue,
    providers: [
      {
        ...provider,
        regions: [
          {
            ...region,
            pricing: null,
            shapePrices: [
              {
                cpus: 2,
                memoryMb: 4_096,
                diskMb: 51_200,
                priceMcPerHour: {
                  awakeMc: 140,
                  suspendedMc: 9,
                  stoppedMc: 9,
                  offer: { startAwakeMc: 140, ceilingAwakeMc: 1_500 },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
