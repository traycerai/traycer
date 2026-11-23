import { sandboxReadinessLine } from "@/lib/sandboxes/sandbox-readiness";
import { READY_SENTENCE } from "@/lib/sandboxes/__tests__/sandbox-catalogue-fixture";
import {
  AUTO_SIZING_RUNGS,
  autoSizingAlternateRegion,
  autoSizingCatalogue,
  autoSizingCatalogueWithRegions,
  autoSizingListedNoRatesCatalogue,
  autoSizingScalarNoRatesCatalogue,
} from "@/lib/sandboxes/__tests__/sandbox-auto-sizing-fixture";
import { describe, expect, it } from "vitest";
import {
  consequenceClauses,
  configurationShapeOptions,
  type ConsequenceClause,
  consequencesShownSubject,
  defaultStageShape,
  priceClause,
  configurationStageShape,
  rememberedOrConfigurationStageShape,
  stageGrowth,
  stageNeedsCredits,
  stagePrice,
  stageQuotedSize,
  stageShapeDefaults,
  stageProviderForShape,
  stageSmallestShape,
  type ConsequencesInput,
  type StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  sandboxCatalogueSchema,
  type SandboxCatalogue,
  type SandboxCataloguePricing,
  type SandboxCatalogueRegion,
  type SandboxOs,
} from "@traycer/protocol/host/sandbox-control";

const PERSONAL = { kind: "personal" } as const;
const ACME = { kind: "team", teamId: "team-acme", teamName: "Acme" } as const;

function input(overrides: Partial<ConsequencesInput>): ConsequencesInput {
  return {
    configuration: PERSONAL,
    price: {
      awakeMcPerHour: 120,
      suspendedMcPerHour: 4,
      stoppedMcPerHour: 2,
      exact: true,
      offer: null,
    },
    needsCredits: false,
    billingStarted: false,
    shortfallMc: 120,
    audience: "private",
    reachHost: null,
    unmovedComputer: null,
    ...overrides,
  };
}

function kinds(clauses: readonly ConsequenceClause[]) {
  return clauses.map((clause) => clause.kind);
}

describe("priceClause", () => {
  it("says the hourly price and whose credits pay", () => {
    expect(priceClause(input({})).text).toBe(
      "$0.12 an hour while awake · uses your credits",
    );
    const team = priceClause(input({ configuration: ACME })).text;
    expect(team).toBe("$0.12 an hour while awake · uses Acme's credits");
    expect(team).not.toContain("your Acme");
  });

  it("prefixes `from` for a price that is only a lower bound", () => {
    expect(
      priceClause(
        input({
          price: {
            awakeMcPerHour: 120,
            suspendedMcPerHour: 4,
            stoppedMcPerHour: 2,
            exact: false,
            offer: null,
          },
        }),
      ).text,
    ).toBe("from $0.12 an hour while awake · uses your credits");
  });

  it("asks for credits at a zero or short balance", () => {
    expect(priceClause(input({ needsCredits: true })).text).toBe(
      "Not enough credits. $0.12 more starts this sandbox for an hour.",
    );
  });

  it("names the team's credits when a team is short, and Personal's without a name", () => {
    const team = priceClause(
      input({
        configuration: {
          kind: "team",
          teamId: "team-pool",
          teamName: "pool-e2e-fixture",
        },
        price: {
          awakeMcPerHour: 210,
          suspendedMcPerHour: 4,
          stoppedMcPerHour: 2,
          exact: false,
          offer: null,
        },
        needsCredits: true,
        shortfallMc: 210,
      }),
    ).text;
    expect(team).toBe(
      "pool-e2e-fixture's credits are short $0.21. $0.21 more starts this sandbox for an hour.",
    );
    expect(team).not.toContain("allowance");
    expect(
      priceClause(
        input({
          price: {
            awakeMcPerHour: 210,
            suspendedMcPerHour: 4,
            stoppedMcPerHour: 2,
            exact: false,
            offer: null,
          },
          needsCredits: true,
          shortfallMc: 210,
        }),
      ).text,
    ).toBe("Not enough credits. $0.21 more starts this sandbox for an hour.");
  });

  it("says what it bills by when the server prices no shape", () => {
    expect(priceClause(input({ price: null })).text).toBe(
      "Billed by the hour while awake · uses your credits",
    );
  });
});

describe("consequenceClauses", () => {
  it("is the price alone for a private personal task with nothing to reach or move", () => {
    expect(kinds(consequenceClauses(input({})))).toEqual(["price"]);
  });

  it("adds the audience clause only when the task is shared", () => {
    expect(kinds(consequenceClauses(input({ audience: "shared" })))).toEqual([
      "price",
      "audience",
    ]);
  });

  it("adds the reach clause when the task holds a host of another configuration, naming it", () => {
    const clauses = consequenceClauses(input({ reachHost: "Build box" }));
    expect(kinds(clauses)).toEqual(["price", "reach"]);
    expect(clauses[1].text).toContain("Build box");
  });

  it("adds the team and resting-storage clauses on a team", () => {
    const clauses = consequenceClauses(input({ configuration: ACME }));
    expect(kinds(clauses)).toEqual(["price", "team", "resting-storage"]);
    expect(clauses[1].text).toBe(
      "Everyone in Acme can use it; another member's agent can read what yours can.",
    );
  });

  it("adds the move clause when a computer's settings have not moved, naming it", () => {
    const clauses = consequenceClauses(input({ unmovedComputer: "MacBook" }));
    expect(kinds(clauses)).toEqual(["price", "move"]);
    expect(clauses[1].text).toBe(
      "Starts with Personal's settings. MacBook's are not in Personal yet.",
    );
  });

  it("keeps the spec's order when every clause applies", () => {
    expect(
      kinds(
        consequenceClauses(
          input({
            configuration: ACME,
            audience: "shared",
            reachHost: "Build box",
            unmovedComputer: "MacBook",
          }),
        ),
      ),
    ).toEqual([
      "price",
      "audience",
      "reach",
      "team",
      "resting-storage",
      "move",
    ]);
  });

  it("puts the add-credits price first, ahead of the rest", () => {
    const clauses = consequenceClauses(
      input({ configuration: ACME, needsCredits: true }),
    );
    expect(clauses[0].text).toMatch(/^Acme's credits are short/);
    expect(clauses[0].text).not.toContain("allowance");
    expect(clauses).toHaveLength(3);
  });
});

describe("consequencesShownSubject", () => {
  it("differs by configuration, audience and wording version, and is stable otherwise", () => {
    const base = consequencesShownSubject(PERSONAL, "private", 1);
    expect(consequencesShownSubject(PERSONAL, "private", 1)).toBe(base);
    expect(consequencesShownSubject(ACME, "private", 1)).not.toBe(base);
    expect(consequencesShownSubject(PERSONAL, "shared", 1)).not.toBe(base);
    expect(consequencesShownSubject(PERSONAL, "private", 2)).not.toBe(base);
  });
});

function catalogue(
  pricing: SandboxCataloguePricing | null,
  os: SandboxOs,
): SandboxCatalogue {
  return {
    providers: [
      {
        provider: os === "windows" ? "gce-windows" : "firecracker",
        os: [os],
        shape: {
          cpuMin: 1,
          cpuMax: 16,
          cpuStep: 1,
          memoryPerCpuMinMb: 1024,
          memoryPerCpuMaxMb: 8192,
          memoryMinMb: 1024,
          memoryMaxMb: 65536,
          memoryStepMb: 512,
          diskMinMb: 10240,
          diskStepMb: 1024,
          diskMaxMb: 102400,
          diskDefaultMb: 20480,
        },
        suspendFidelity: "memory",
        stoppedStorage: "snapshot",
        wakeClass: "resume",
        shapes: null,
        dockerInGuest: true,
        creatable: true,
        notCreatableReason: null,
        regions: [
          {
            id: "us-east",
            label: "US East",
            fromPriceMcPerHour: { awakeMc: 80, suspendedMc: 4, stoppedMc: 2 },
            pricing,
          },
        ],
      },
    ],
  };
}

describe("stagePrice", () => {
  const STAGED = {
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: null,
    region: "us-east",
    idleMinutes: 30,
    destroyAfterRestingMinutes: null,
  } as const;

  it("prices the staged shape exactly from the region's per-unit rates", () => {
    const price = stagePrice(
      catalogue(
        {
          vcpuHourMillicredits: 50,
          memoryGbHourMillicredits: 25,
          diskGbHourMillicredits: 0.5,
          multiplier: 1.25,
        },
        "linux",
      ),
      STAGED,
    );
    // Null disk selects the provider default: 20 GiB.
    expect(price).toEqual({
      awakeMcPerHour: 250,
      suspendedMcPerHour: 15,
      stoppedMcPerHour: 13,
      exact: true,
      offer: null,
    });
  });

  it("prices at the billed rate: compute at its rates times the margin, rounded up, the disk adding nothing", () => {
    const windows = catalogue(
      {
        vcpuHourMillicredits: 136.2,
        memoryGbHourMillicredits: 16.2,
        diskGbHourMillicredits: 0.108,
        multiplier: 1.25,
      },
      "windows",
    );
    const staged = { ...STAGED, os: "windows" } as const;
    // ceil((2 × 136.2 + 8 × 16.2) × 1.25) = ceil(502.5)
    expect(
      stagePrice(windows, {
        ...staged,
        cpus: 2,
        memoryMb: 8192,
        diskMb: 20480,
      }),
    ).toEqual({
      awakeMcPerHour: 503,
      suspendedMcPerHour: 4,
      stoppedMcPerHour: 3,
      exact: true,
      offer: null,
    });
    // ceil((136.2 + 4 × 16.2) × 1.25) = ceil(251.25)
    expect(
      stagePrice(windows, {
        ...staged,
        cpus: 1,
        memoryMb: 4096,
        diskMb: 102400,
      }),
    ).toEqual({
      awakeMcPerHour: 252,
      suspendedMcPerHour: 15,
      stoppedMcPerHour: 14,
      exact: true,
      offer: null,
    });
  });

  it.each([
    { diskMb: null, awake: 300, suspended: 163, stopped: 13 },
    { diskMb: 102400, awake: 500, suspended: 213, stopped: 63 },
  ])(
    "reproduces differing memory and disk bill rates for disk $diskMb",
    ({ diskMb, awake, suspended, stopped }) => {
      expect(
        stagePrice(
          catalogue(
            {
              vcpuHourMillicredits: 50,
              memoryGbHourMillicredits: 25,
              diskGbHourMillicredits: 0.5,
              suspendedMemoryGbHourMillicredits: 30,
              awakeDiskGbHourMillicredits: 2,
              multiplier: 1.25,
            },
            "linux",
          ),
          { ...STAGED, diskMb },
        ),
      ).toEqual({
        awakeMcPerHour: awake,
        suspendedMcPerHour: suspended,
        stoppedMcPerHour: stopped,
        exact: true,
        offer: null,
      });
    },
  );

  it.each([
    {
      suspendedMemoryGbHourMillicredits: null,
      awakeDiskGbHourMillicredits: null,
      suspended: 15,
    },
    {
      suspendedMemoryGbHourMillicredits: 0,
      awakeDiskGbHourMillicredits: 0,
      suspended: 13,
    },
  ])(
    "distinguishes null fallback rates from explicitly free memory",
    (rates) => {
      expect(
        stagePrice(
          catalogue(
            {
              vcpuHourMillicredits: 50,
              memoryGbHourMillicredits: 25,
              diskGbHourMillicredits: 0.5,
              suspendedMemoryGbHourMillicredits:
                rates.suspendedMemoryGbHourMillicredits,
              awakeDiskGbHourMillicredits: rates.awakeDiskGbHourMillicredits,
              multiplier: 1.25,
            },
            "linux",
          ),
          STAGED,
        ),
      ).toEqual({
        awakeMcPerHour: 250,
        suspendedMcPerHour: rates.suspended,
        stoppedMcPerHour: 13,
        exact: true,
        offer: null,
      });
    },
  );

  it("does not price a smaller disk from the server's default-disk source quote", () => {
    const smallest = { ...STAGED, cpus: 1, memoryMb: 1024, diskMb: 10240 };
    expect(stagePrice(catalogue(null, "linux"), smallest)).toBeNull();
    expect(
      stagePrice(catalogue(null, "linux"), { ...smallest, diskMb: 20480 }),
    ).toEqual({
      awakeMcPerHour: 80,
      suspendedMcPerHour: 4,
      stoppedMcPerHour: 2,
      exact: true,
      offer: null,
    });
  });

  it("quotes the smallest shape's price as a from price without the rates", () => {
    expect(stagePrice(catalogue(null, "linux"), STAGED)).toEqual({
      awakeMcPerHour: 80,
      suspendedMcPerHour: 4,
      stoppedMcPerHour: 2,
      exact: false,
      offer: null,
    });
  });
});

describe("stageProviderForShape", () => {
  it("prices the provider offering the selected region rather than the first OS match", () => {
    const [first] = catalogue(null, "linux").providers;
    const selected = {
      ...first,
      provider: "eu-region-test-provider" as const,
      createBudgetMs: 480_000,
      regions: [
        {
          ...first.regions[0],
          id: "eu",
          pricing: {
            vcpuHourMillicredits: 50,
            memoryGbHourMillicredits: 25,
            diskGbHourMillicredits: 0.5,
            multiplier: 1.25,
          },
        },
      ],
    };
    const offered = { providers: [first, selected] };
    const shape = {
      os: "linux" as const,
      cpus: 2,
      memoryMb: 4096,
      diskMb: null,
      region: "eu",
    };
    expect(stageProviderForShape(offered, shape)).toBe(selected);
    expect(stagePrice(offered, shape)).toEqual({
      awakeMcPerHour: 250,
      suspendedMcPerHour: 15,
      stoppedMcPerHour: 13,
      exact: true,
      offer: null,
    });
  });
});

describe("defaultStageShape", () => {
  it("stages Linux when it is offered, and Windows when only Windows is", () => {
    expect(defaultStageShape(catalogue(null, "linux"))?.os).toBe("linux");
    expect(defaultStageShape(catalogue(null, "windows"))).toMatchObject({
      os: "windows",
      cpus: 2,
      memoryMb: 4096,
      region: "us-east",
    });
  });

  it("stages the provider's default listed shape, not the bounds' 2 vCPU / 4 GB", () => {
    const base = catalogue(null, "linux");
    const [provider] = base.providers;
    const listed = {
      providers: [
        {
          ...provider,
          shapes: [
            { cpus: 2, memoryMb: 4096, diskMb: 20480, default: false },
            { cpus: 4, memoryMb: 8192, diskMb: 40960, default: true },
          ],
        },
      ],
    };
    expect(defaultStageShape(listed)).toMatchObject({
      cpus: 4,
      memoryMb: 8192,
      diskMb: 40960,
    });
  });
});

describe("listed shapes", () => {
  const RATES: SandboxCataloguePricing = {
    vcpuHourMillicredits: 10,
    memoryGbHourMillicredits: 5,
    diskGbHourMillicredits: 1,
    multiplier: 1,
  };
  const LARGE = { cpus: 4, memoryMb: 8192, diskMb: 40960, default: false };
  const MIDDLE = { cpus: 2, memoryMb: 8192, diskMb: 20480, default: false };
  const SMALLEST = { cpus: 2, memoryMb: 4096, diskMb: 20480, default: true };
  const CPU_SIBLING = {
    cpus: 4,
    memoryMb: 4096,
    diskMb: 20480,
    default: false,
  };
  const DISK_SIBLING = {
    cpus: 2,
    memoryMb: 4096,
    diskMb: 40960,
    default: false,
  };
  const STAGED = {
    os: "linux",
    region: "us-east",
    cpus: 2,
    memoryMb: 4096,
    diskMb: 20480,
    idleMinutes: 30,
    destroyAfterRestingMinutes: null,
  } as const;

  it("uses the exact price of a non-smallest staged rung over conflicting unit rates", () => {
    const parsed = exactCatalogue(RATES);

    expect(
      stagePrice(parsed, {
        ...STAGED,
        cpus: MIDDLE.cpus,
        memoryMb: MIDDLE.memoryMb,
        diskMb: MIDDLE.diskMb,
      }),
    ).toEqual({
      awakeMcPerHour: 1000,
      suspendedMcPerHour: 6,
      stoppedMcPerHour: 2,
      exact: true,
      offer: null,
    });
  });

  it("matches all dimensions for stagePrice and preserves a zero exact price", () => {
    const parsed = exactCatalogue(RATES);

    expect(stagePrice(parsed, STAGED)).toEqual({
      awakeMcPerHour: 0,
      suspendedMcPerHour: 5,
      stoppedMcPerHour: 1,
      exact: true,
      offer: null,
    });
  });

  it("matches all dimensions for stageSmallestShape and preserves a zero exact price", () => {
    const parsed = exactCatalogue(RATES);

    expect(stageSmallestShape(parsed, STAGED)).toEqual({
      isStaged: true,
      awakeMcPerHour: 0,
    });
  });

  it("uses exact shape prices when the region has no unit rates", () => {
    const parsed = exactCatalogue(null);

    expect(
      stagePrice(parsed, {
        ...STAGED,
        cpus: MIDDLE.cpus,
        memoryMb: MIDDLE.memoryMb,
        diskMb: MIDDLE.diskMb,
      }),
    ).toEqual({
      awakeMcPerHour: 1000,
      suspendedMcPerHour: 6,
      stoppedMcPerHour: 2,
      exact: true,
      offer: null,
    });
    expect(stageSmallestShape(parsed, STAGED)).toEqual({
      isStaged: true,
      awakeMcPerHour: 0,
    });
  });

  it("keeps older parsed catalogues on their existing unit-price fallback", () => {
    const legacy = sandboxCatalogueSchema.parse(listed(RATES));

    expect(stagePrice(legacy, STAGED)).toEqual({
      awakeMcPerHour: 40,
      suspendedMcPerHour: 24,
      stoppedMcPerHour: 20,
      exact: true,
      offer: null,
    });
    expect(stageSmallestShape(legacy, STAGED)).toEqual({
      isStaged: true,
      awakeMcPerHour: 40,
    });
  });

  function listed(pricing: SandboxCataloguePricing | null): SandboxCatalogue {
    const [provider] = catalogue(pricing, "linux").providers;
    return {
      providers: [
        {
          ...provider,
          shapes: [LARGE, MIDDLE, CPU_SIBLING, DISK_SIBLING, SMALLEST],
        },
      ],
    };
  }

  function exactCatalogue(
    pricing: SandboxCataloguePricing | null,
  ): SandboxCatalogue {
    const shapePrices = [
      {
        cpus: LARGE.cpus,
        memoryMb: LARGE.memoryMb,
        diskMb: LARGE.diskMb,
        priceMcPerHour: { awakeMc: 1200, suspendedMc: 7, stoppedMc: 3 },
      },
      {
        cpus: MIDDLE.cpus,
        memoryMb: MIDDLE.memoryMb,
        diskMb: MIDDLE.diskMb,
        priceMcPerHour: { awakeMc: 1000, suspendedMc: 6, stoppedMc: 2 },
      },
      {
        cpus: CPU_SIBLING.cpus,
        memoryMb: CPU_SIBLING.memoryMb,
        diskMb: CPU_SIBLING.diskMb,
        priceMcPerHour: { awakeMc: 700, suspendedMc: 5, stoppedMc: 2 },
      },
      {
        cpus: DISK_SIBLING.cpus,
        memoryMb: DISK_SIBLING.memoryMb,
        diskMb: DISK_SIBLING.diskMb,
        priceMcPerHour: { awakeMc: 777, suspendedMc: 8, stoppedMc: 4 },
      },
      {
        cpus: SMALLEST.cpus,
        memoryMb: SMALLEST.memoryMb,
        diskMb: SMALLEST.diskMb,
        priceMcPerHour: { awakeMc: 0, suspendedMc: 5, stoppedMc: 1 },
      },
    ];
    const base = listed(pricing);
    return sandboxCatalogueSchema.parse({
      ...base,
      providers: base.providers.map((provider) => ({
        ...provider,
        regions: provider.regions.map((region) => ({
          ...region,
          shapePrices,
        })),
      })),
    });
  }

  // The bounds (3 vCPU, 6 GB, 30 GB) admit the unlisted size, so only the list rejects it.
  it("keeps a remembered listed shape and drops an unlisted one inside the bounds", () => {
    const remembered = { ...STAGED, cpus: 4, memoryMb: 8192, diskMb: 40960 };
    expect(
      rememberedOrConfigurationStageShape(listed(null), remembered, null),
    ).toBe(remembered);
    expect(
      rememberedOrConfigurationStageShape(
        listed(null),
        { ...STAGED, cpus: 3, memoryMb: 6144, diskMb: 30720 },
        null,
      ),
    ).toMatchObject({ cpus: 2, memoryMb: 4096, diskMb: 20480 });
  });

  it("falls back to the configuration's defaults, not the spec's, when the remembered shape is withdrawn", () => {
    const defaults = {
      os: "linux",
      cpus: 4,
      memoryMb: 8192,
      diskMb: 40960,
      idleMinutes: 2,
      restingMinutes: 120,
    } as const;
    expect(
      rememberedOrConfigurationStageShape(
        listed(null),
        { ...STAGED, cpus: 3, memoryMb: 6144, diskMb: 30720 },
        defaults,
      ),
    ).toMatchObject({
      cpus: 4,
      memoryMb: 8192,
      idleMinutes: 2,
      destroyAfterRestingMinutes: 120,
    });
  });

  it("stages the configuration's shape and periods while offered, the spec's shape under its periods once withdrawn", () => {
    const defaults = {
      os: "linux",
      cpus: 4,
      memoryMb: 8192,
      diskMb: 40960,
      idleMinutes: 2,
      restingMinutes: null,
    } as const;
    expect(configurationStageShape(listed(null), defaults)).toMatchObject({
      os: "linux",
      cpus: 4,
      memoryMb: 8192,
      diskMb: 40960,
      region: "us-east",
      idleMinutes: 2,
      destroyAfterRestingMinutes: null,
    });
    expect(
      configurationStageShape(listed(null), {
        ...defaults,
        cpus: 3,
        memoryMb: 6144,
        diskMb: 30720,
      }),
    ).toMatchObject({ cpus: 2, memoryMb: 4096, idleMinutes: 2 });
    expect(configurationStageShape(listed(null), null)).toEqual(
      defaultStageShape(listed(null)),
    );
  });

  it("prices the smallest listed shape from the region's rates, else its from price", () => {
    // 2 × 10 + 4 × 5: no disk term
    expect(stageSmallestShape(listed(RATES), STAGED)).toEqual({
      isStaged: true,
      awakeMcPerHour: 40,
    });
    expect(
      stageSmallestShape(listed(RATES), { ...STAGED, ...LARGE }),
    ).toMatchObject({ isStaged: false });
    expect(stageSmallestShape(listed(null), STAGED)).toBeNull();
  });
});

const SERVED_LAUNCH_FORM = {
  kind: "template" as const,
  object: "gs://templates/platform-v1/manifest.json",
  digest: "a".repeat(64),
};

describe("growing Linux starting sizes", () => {
  const catalogue = autoSizingCatalogue();

  function catalogueWithRegion(
    region: SandboxCatalogueRegion,
  ): SandboxCatalogue {
    const base = autoSizingCatalogue();
    const [provider] = base.providers;
    return {
      ...base,
      providers: [{ ...provider, regions: [region] }],
    };
  }

  function size(cpus: number, memoryGb: number, diskGb: number) {
    return sizeInRegion(cpus, memoryGb, diskGb, "us-east");
  }

  function sizeInRegion(
    cpus: number,
    memoryGb: number,
    diskGb: number,
    region: string,
  ) {
    return {
      os: "linux" as const,
      cpus,
      memoryMb: memoryGb * 1024,
      diskMb: diskGb * 1024,
      region,
    };
  }

  it("resolves legacy defaults to the growing rung's disk and keeps its periods", () => {
    expect(
      configurationStageShape(catalogue, {
        os: "linux",
        cpus: 2,
        memoryMb: 4_096,
        diskMb: 20_480,
        idleMinutes: 30,
        restingMinutes: null,
      }),
    ).toMatchObject({
      os: "linux",
      cpus: 2,
      memoryMb: 4_096,
      diskMb: 51_200,
      idleMinutes: 30,
      destroyAfterRestingMinutes: null,
    });

    // A fixed ladder lists its disk as part of the shape: a default at a
    // disk it does not list is no longer offered, and falls back.
    const [provider] = catalogue.providers;
    const fixed: SandboxCatalogue = {
      providers: [
        {
          ...provider,
          shapes: AUTO_SIZING_RUNGS.map((rung) => ({
            cpus: rung.cpus,
            memoryMb: rung.memoryMb,
            diskMb: rung.diskMb,
            default: rung.default,
          })),
        },
      ],
    };
    expect(
      configurationStageShape(fixed, {
        os: "linux",
        cpus: 4,
        memoryMb: 8_192,
        diskMb: 20_480,
        idleMinutes: 30,
        restingMinutes: null,
      }),
    ).toMatchObject({ cpus: 2, memoryMb: 4_096, diskMb: 51_200 });
  });

  it("falls back to the catalogue default when saved defaults name an unoffered OS", () => {
    expect(
      configurationStageShape(catalogue, {
        os: "windows",
        cpus: 4,
        memoryMb: 8_192,
        diskMb: 40_960,
        idleMinutes: 45,
        restingMinutes: null,
      }),
    ).toEqual({
      os: "linux",
      cpus: 2,
      memoryMb: 4_096,
      diskMb: 51_200,
      region: "us-east",
      idleMinutes: 45,
      destroyAfterRestingMinutes: null,
    });
  });

  it("uses the first listed disk when growing rungs share a saved start", () => {
    const [provider] = catalogue.providers;
    const shapes = provider.shapes;
    if (shapes === null) {
      throw new Error("Expected listed growing sizes");
    }
    const first = shapes[0];
    const repeated = {
      ...first,
      diskMb: 80 * 1024,
      default: false,
    };
    const duplicated = {
      ...catalogue,
      providers: [{ ...provider, shapes: [first, repeated] }],
    };

    expect(
      configurationStageShape(duplicated, {
        os: "linux",
        cpus: 2,
        memoryMb: 4_096,
        diskMb: 80 * 1024,
        idleMinutes: 30,
        restingMinutes: null,
      }),
    ).toEqual({
      os: "linux",
      cpus: 2,
      memoryMb: 4_096,
      diskMb: 50 * 1024,
      region: "us-east",
      idleMinutes: 30,
      destroyAfterRestingMinutes: null,
    });
  });

  it("keeps a remembered growing start at its chosen disk", () => {
    const remembered: StageShape = {
      ...size(4, 8, 30),
      idleMinutes: 30,
      destroyAfterRestingMinutes: 10_080,
    };
    expect(
      rememberedOrConfigurationStageShape(catalogue, remembered, null),
    ).toBe(remembered);
  });

  it.each([
    [2, 4, 135],
    [4, 8, 263],
    [8, 16, 518],
    [8, 32, 726],
    [16, 32, 1_028],
    [16, 64, 1_444],
  ])(
    "prices the %i/%i start and its 16/64 ceiling at 50 GB",
    (cpus, memory, start) => {
      expect(stagePrice(catalogue, size(cpus, memory, 50))).toMatchObject({
        awakeMcPerHour: start,
        suspendedMcPerHour: 7,
        stoppedMcPerHour: 7,
        exact: true,
        offer: { startAwakeMc: start, ceilingAwakeMc: 1_444 },
      });
    },
  );

  it("uses the selected or rung disk for prices and matches the smallest start", () => {
    const thirtyGb = size(4, 8, 30);
    expect(stagePrice(catalogue, thirtyGb)).toMatchObject({
      awakeMcPerHour: 261,
      offer: { startAwakeMc: 261, ceilingAwakeMc: 1_442 },
    });
    expect(stagePrice(catalogue, size(2, 4, 200))?.offer).toEqual({
      startAwakeMc: 156,
      ceilingAwakeMc: 1_465,
    });
    expect(stagePrice(catalogue, { ...size(2, 4, 50), diskMb: null })).toEqual({
      awakeMcPerHour: 135,
      suspendedMcPerHour: 7,
      stoppedMcPerHour: 7,
      exact: true,
      offer: { startAwakeMc: 135, ceilingAwakeMc: 1_444 },
    });
    // A disk must be whole GB within the bounds to be priced.
    expect(stagePrice(catalogue, size(2, 4, 30.5))).toBeNull();
    expect(stageSmallestShape(catalogue, size(4, 8, 30))).toEqual({
      isStaged: false,
      awakeMcPerHour: 133,
    });
    expect(stageSmallestShape(catalogue, size(2, 4, 30))).toEqual({
      isStaged: true,
      awakeMcPerHour: 133,
    });
  });

  it("does not mark a growing shape staged when only one dimension matches the minimum", () => {
    const [provider] = catalogue.providers;
    const shapes = provider.shapes;
    if (shapes === null) {
      throw new Error("Expected listed growing sizes");
    }
    const minimum = shapes[0];
    const siblings = {
      ...catalogue,
      providers: [
        {
          ...provider,
          shapes: [
            minimum,
            { ...minimum, memoryMb: 8 * 1024, default: false },
            { ...minimum, cpus: 4, default: false },
          ],
        },
      ],
    };

    expect(stageSmallestShape(siblings, size(2, 8, 50))?.isStaged).toBe(false);
    expect(stageSmallestShape(siblings, size(4, 4, 50))?.isStaged).toBe(false);
  });

  it("applies the pricing multiplier to compute and storage", () => {
    const [provider] = catalogue.providers;
    const [region] = provider.regions;
    const rates = region.pricing;
    if (rates === null) throw new Error("Expected auto-sizing unit rates");
    const doubled = catalogueWithRegion({
      ...region,
      pricing: { ...rates, multiplier: 2 },
      fromPriceMcPerHour: { awakeMc: 270, suspendedMc: 14, stoppedMc: 14 },
    });

    expect(stagePrice(doubled, size(4, 8, 30))).toEqual({
      awakeMcPerHour: 520,
      suspendedMcPerHour: 9,
      stoppedMcPerHour: 9,
      exact: true,
      offer: { startAwakeMc: 520, ceilingAwakeMc: 2_883 },
    });
  });

  it("uses the region's varied unit rates for a growing start and ceiling", () => {
    const [provider] = catalogue.providers;
    const [east] = provider.regions;
    const varied = autoSizingCatalogueWithRegions([
      east,
      autoSizingAlternateRegion(),
    ]);

    expect(stagePrice(varied, sizeInRegion(4, 8, 30, "us-west"))).toEqual({
      awakeMcPerHour: 286,
      suspendedMcPerHour: 6,
      stoppedMcPerHour: 6,
      exact: true,
      offer: { startAwakeMc: 286, ceilingAwakeMc: 1_606 },
    });
  });

  it("selects the Linux provider when a Windows provider is listed first", () => {
    const [linux] = catalogue.providers;
    const [region] = linux.regions;
    const windows = {
      ...linux,
      provider: "windows-test",
      os: ["windows"] as const,
      shapes: null,
      regions: [
        {
          ...region,
          pricing: null,
          shapePrices: [],
          fromPriceMcPerHour: {
            awakeMc: 900,
            suspendedMc: 90,
            stoppedMc: 90,
          },
        },
      ],
    };
    const mixed: SandboxCatalogue = {
      ...catalogue,
      providers: [windows, linux],
    };

    expect(stagePrice(mixed, size(4, 8, 50))).toMatchObject({
      awakeMcPerHour: 263,
      offer: { startAwakeMc: 263, ceilingAwakeMc: 1_444 },
    });
  });

  it("prices growing starts at changed provider disk bounds", () => {
    const [provider] = catalogue.providers;
    const bounded: SandboxCatalogue = {
      ...catalogue,
      providers: [
        {
          ...provider,
          shape: {
            ...provider.shape,
            diskMinMb: 20 * 1024,
            diskMaxMb: 100 * 1024,
          },
        },
      ],
    };

    expect(stagePrice(bounded, size(2, 4, 20))).toMatchObject({
      awakeMcPerHour: 131,
      suspendedMcPerHour: 3,
      stoppedMcPerHour: 3,
    });
    expect(stagePrice(bounded, size(2, 4, 100))).toMatchObject({
      awakeMcPerHour: 142,
      suspendedMcPerHour: 14,
      stoppedMcPerHour: 14,
    });
    expect(stagePrice(bounded, size(2, 4, 19))).toBeNull();
    expect(stagePrice(bounded, size(2, 4, 101))).toBeNull();
  });

  it("uses the served offer at its listed disk and rates at an unlisted disk", () => {
    const [provider] = catalogue.providers;
    const [region] = provider.regions;
    const offer = { startAwakeMc: 140, ceilingAwakeMc: 1_500 };
    const listedPrice = {
      awakeMc: 140,
      suspendedMc: 9,
      stoppedMc: 8,
      offer,
    };
    const served = catalogueWithRegion({
      ...region,
      shapePrices: [
        {
          cpus: 2,
          memoryMb: 4_096,
          diskMb: 51_200,
          priceMcPerHour: listedPrice,
        },
      ],
    });

    expect(stagePrice(served, size(2, 4, 50))).toEqual({
      awakeMcPerHour: 140,
      suspendedMcPerHour: 9,
      stoppedMcPerHour: 8,
      exact: true,
      offer,
    });
    expect(stagePrice(served, size(2, 4, 30))).toEqual({
      awakeMcPerHour: 133,
      suspendedMcPerHour: 5,
      stoppedMcPerHour: 5,
      exact: true,
      offer: { startAwakeMc: 133, ceilingAwakeMc: 1_442 },
    });
  });

  it("matches a fixed sibling at its named disk regardless of rung order", () => {
    for (const growingFirst of [true, false]) {
      const [provider] = catalogue.providers;
      const growing = AUTO_SIZING_RUNGS[0];
      const fixed = {
        cpus: growing.cpus,
        memoryMb: growing.memoryMb,
        diskMb: 80 * 1024,
        default: false,
      };
      const rungs = growingFirst ? [growing, fixed] : [fixed, growing];
      const [region] = provider.regions;
      const offered: SandboxCatalogue = {
        ...catalogue,
        providers: [
          {
            ...provider,
            shapes: rungs,
            regions: [
              {
                ...region,
                shapePrices: [
                  {
                    cpus: fixed.cpus,
                    memoryMb: fixed.memoryMb,
                    diskMb: fixed.diskMb,
                    priceMcPerHour: {
                      awakeMc: 222,
                      suspendedMc: 11,
                      stoppedMc: 3,
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      expect(stageGrowth(offered, size(2, 4, 80))).toBeNull();
      expect(
        configurationStageShape(offered, {
          os: "linux",
          cpus: 2,
          memoryMb: 4_096,
          diskMb: 80 * 1024,
          idleMinutes: 30,
          restingMinutes: null,
        })?.diskMb,
      ).toBe(80 * 1024);
      expect(stagePrice(offered, size(2, 4, 80))).toEqual({
        awakeMcPerHour: 222,
        suspendedMcPerHour: 11,
        stoppedMcPerHour: 3,
        exact: true,
        offer: null,
      });
    }
  });

  it("keeps a listed scalar price without inventing a range from rates", () => {
    const [provider] = catalogue.providers;
    const [region] = provider.regions;
    const listed = catalogueWithRegion({
      ...region,
      shapePrices: [
        {
          cpus: 2,
          memoryMb: 4_096,
          diskMb: 50 * 1024,
          priceMcPerHour: { awakeMc: 140, suspendedMc: 9, stoppedMc: 8 },
        },
      ],
    });
    const price = stagePrice(listed, size(2, 4, 50));

    expect(price).toEqual({
      awakeMcPerHour: 140,
      suspendedMcPerHour: 9,
      stoppedMcPerHour: 8,
      exact: true,
      offer: null,
    });
    expect(stageNeedsCredits(137, price)).toBe(true);
  });

  it("uses one scalar exact price when the growing start is also its cap", () => {
    const [region] = catalogue.providers[0].regions;
    const capped = catalogueWithRegion({
      ...region,
      shapePrices: [
        {
          cpus: 16,
          memoryMb: 64 * 1024,
          diskMb: 50 * 1024,
          priceMcPerHour: { awakeMc: 1_200, suspendedMc: 7, stoppedMc: 7 },
        },
      ],
    });

    expect(stagePrice(capped, size(16, 64, 50))).toEqual({
      awakeMcPerHour: 1_200,
      suspendedMcPerHour: 7,
      stoppedMcPerHour: 7,
      exact: true,
      offer: null,
    });
  });

  it("uses the from price for a fixed rung above a growing no-rates minimum", () => {
    const [provider] = catalogue.providers;
    const [region] = provider.regions;
    const noRates: SandboxCatalogue = {
      ...catalogue,
      providers: [
        {
          ...provider,
          shapes: [
            AUTO_SIZING_RUNGS[0],
            {
              cpus: 4,
              memoryMb: 8 * 1024,
              diskMb: 80 * 1024,
              default: false,
            },
          ],
          regions: [
            {
              ...region,
              pricing: null,
              shapePrices: [],
              fromPriceMcPerHour: {
                awakeMc: 140,
                suspendedMc: 9,
                stoppedMc: 9,
              },
            },
          ],
        },
      ],
    };

    expect(stageSmallestShape(noRates, size(4, 8, 80))).toEqual({
      isStaged: false,
      awakeMcPerHour: 140,
    });
  });

  it("prices the staged growing minimum instead of its smaller fixed sibling", () => {
    const [provider] = catalogue.providers;
    const [region] = provider.regions;
    const overlap: SandboxCatalogue = {
      ...catalogue,
      providers: [
        {
          ...provider,
          shapes: [
            { ...AUTO_SIZING_RUNGS[0], diskMb: 80 * 1024 },
            {
              cpus: 2,
              memoryMb: 4 * 1024,
              diskMb: 50 * 1024,
              default: false,
            },
          ],
          regions: [
            {
              ...region,
              shapePrices: [
                {
                  cpus: 2,
                  memoryMb: 4 * 1024,
                  diskMb: 50 * 1024,
                  priceMcPerHour: {
                    awakeMc: 100,
                    suspendedMc: 7,
                    stoppedMc: 7,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    expect(stageSmallestShape(overlap, size(2, 4, 30))).toEqual({
      isStaged: true,
      awakeMcPerHour: 133,
    });
  });

  it("compares a staged fixed sibling with the rated growing minimum", () => {
    const [provider] = catalogue.providers;
    const [region] = provider.regions;
    const offered: SandboxCatalogue = {
      ...catalogue,
      providers: [
        {
          ...provider,
          shapes: [
            AUTO_SIZING_RUNGS[0],
            {
              cpus: 2,
              memoryMb: 4 * 1024,
              diskMb: 80 * 1024,
              default: false,
            },
          ],
          regions: [
            {
              ...region,
              shapePrices: [
                {
                  cpus: 2,
                  memoryMb: 4 * 1024,
                  diskMb: 80 * 1024,
                  priceMcPerHour: {
                    awakeMc: 222,
                    suspendedMc: 9,
                    stoppedMc: 9,
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const staged = size(2, 4, 80);

    expect(stageSmallestShape(offered, staged)).toEqual({
      isStaged: false,
      awakeMcPerHour: 135,
    });
    expect(stageNeedsCredits(130, stagePrice(offered, staged))).toBe(true);
  });

  it("offers one duplicate default size and resolves its price by first-listed rung", () => {
    const [provider] = catalogue.providers;
    const [region] = provider.regions;
    const growing = AUTO_SIZING_RUNGS[0];
    const fixed = {
      cpus: growing.cpus,
      memoryMb: growing.memoryMb,
      diskMb: growing.diskMb,
      default: false,
    };
    for (const [shapes, shouldGrow] of [
      [[growing, fixed], true],
      [[fixed, growing], false],
    ] as const) {
      const offered: SandboxCatalogue = {
        ...catalogue,
        providers: [
          {
            ...provider,
            shapes,
            regions: [
              {
                ...region,
                shapePrices: [
                  {
                    cpus: fixed.cpus,
                    memoryMb: fixed.memoryMb,
                    diskMb: fixed.diskMb,
                    priceMcPerHour: {
                      awakeMc: 100,
                      suspendedMc: 7,
                      stoppedMc: 7,
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      const options = configurationShapeOptions(offered);
      const [option] = options;

      expect(options).toHaveLength(1);
      expect(stageGrowth(offered, option)).toEqual(
        shouldGrow ? growing.grows : null,
      );
      expect(stagePrice(offered, option)).toEqual({
        awakeMcPerHour: 100,
        suspendedMcPerHour: 7,
        stoppedMcPerHour: 7,
        exact: true,
        offer: null,
      });
    }
  });

  it("uses a listed offer without rates and gives only a larger unlisted disk a lower bound", () => {
    const listed = autoSizingListedNoRatesCatalogue();
    const [provider] = listed.providers;
    const [region] = provider.regions;
    const offer = { startAwakeMc: 140, ceilingAwakeMc: 1_500 };

    expect(stagePrice(listed, size(2, 4, 50))).toEqual({
      awakeMcPerHour: 140,
      suspendedMcPerHour: 9,
      stoppedMcPerHour: 9,
      exact: true,
      offer,
    });
    expect(stagePrice(listed, size(2, 4, 30))).toBeNull();
    expect(stagePrice(listed, size(2, 4, 80))).toEqual({
      awakeMcPerHour: 140,
      suspendedMcPerHour: 9,
      stoppedMcPerHour: 9,
      exact: false,
      offer: null,
    });
    expect(
      stagePrice(
        catalogueWithRegion({ ...region, shapePrices: undefined }),
        size(2, 4, 50),
      ),
    ).toBeNull();
    expect(
      stagePrice(autoSizingScalarNoRatesCatalogue(), size(2, 4, 50)),
    ).toEqual({
      awakeMcPerHour: 135,
      suspendedMcPerHour: 7,
      stoppedMcPerHour: 7,
      exact: true,
      offer: null,
    });
  });

  it("quotes allocated disk for a growing rung and refuses it for a fixed-only rung", () => {
    const [provider] = catalogue.providers;
    expect(
      stageQuotedSize(provider, {
        cpus: 4,
        memoryMb: 8 * 1024,
        diskMb: 30 * 1024,
      }),
    ).toEqual({
      shape: { cpus: 4, memoryMb: 8 * 1024, diskMb: 30 * 1024 },
      exact: true,
      grows: { cpus: 16, memoryMb: 64 * 1024 },
      listedDiskMb: 50 * 1024,
    });

    const fixedOnly: SandboxCatalogue = {
      ...catalogue,
      providers: [
        {
          ...provider,
          shapes: [
            {
              cpus: 4,
              memoryMb: 8 * 1024,
              diskMb: 50 * 1024,
              default: true,
            },
          ],
        },
      ],
    };
    expect(stagePrice(fixedOnly, size(4, 8, 30))).toBeNull();
  });
});

describe("quoted freeform geometry", () => {
  const SIZE = {
    os: "linux" as const,
    cpus: 2,
    memoryMb: 4096,
    diskMb: 45057,
    region: "us-east",
  };
  const RATES = {
    vcpuHourMillicredits: 50,
    memoryGbHourMillicredits: 25,
    diskGbHourMillicredits: 1,
    suspendedMemoryGbHourMillicredits: 30,
    awakeDiskGbHourMillicredits: 2,
    multiplier: 1,
  };
  it("prices and matches readiness using the quoted 45GiB disk instead of the unrounded request", () => {
    const [provider] = catalogue(RATES, "linux").providers;
    const offered = {
      providers: [
        {
          ...provider,
          readiness: {
            request: {
              os: "linux" as const,
              shape: { cpus: 2, memoryMb: 4096, diskMb: 46080 },
              region: "us-east",
              generationId: null,
              launchForm: SERVED_LAUNCH_FORM,
            },
            result: { warm: 2 },
          },
        },
      ],
    };
    expect(stagePrice(offered, SIZE)).toEqual({
      awakeMcPerHour: 290,
      suspendedMcPerHour: 165,
      stoppedMcPerHour: 45,
      exact: true,
      offer: null,
    });
    expect(sandboxReadinessLine(offered, SIZE)).toBe(READY_SENTENCE);
  });
  it("quotes the nondefault listed rung's own disk when its request leaves disk unset", () => {
    const [provider] = catalogue(RATES, "linux").providers;
    const offered = {
      providers: [
        {
          ...provider,
          shapes: [
            { cpus: 2, memoryMb: 4096, diskMb: 20480, default: true },
            { cpus: 4, memoryMb: 8192, diskMb: 40960, default: false },
          ],
          readiness: {
            request: {
              os: "linux" as const,
              shape: { cpus: 4, memoryMb: 8192, diskMb: 40960 },
              region: "us-east",
              generationId: null,
              launchForm: SERVED_LAUNCH_FORM,
            },
            result: { warm: 2 },
          },
        },
      ],
    };
    const size = { ...SIZE, cpus: 4, memoryMb: 8192, diskMb: null };
    expect(stagePrice(offered, size)).toEqual({
      awakeMcPerHour: 480,
      suspendedMcPerHour: 280,
      stoppedMcPerHour: 40,
      exact: true,
      offer: null,
    });
    expect(sandboxReadinessLine(offered, size)).toBe(READY_SENTENCE);
  });

  it("keeps a nondefault disk quote from an older server as a lower bound when its step is unknown", () => {
    const [provider] = catalogue(RATES, "linux").providers;
    const { diskStepMb: _step, ...shape } = provider.shape;
    const older = { providers: [{ ...provider, shape }] };
    expect(stagePrice(older, SIZE)?.exact).toBe(false);
    expect(stagePrice(older, { ...SIZE, diskMb: null })?.exact).toBe(true);
  });
});

describe("served exact per-shape prices", () => {
  const GIB = 1024;
  const SMALL = { cpus: 1, memoryMb: GIB, diskMb: 10 * GIB };
  const MIDDLE = { cpus: 2, memoryMb: 4 * GIB, diskMb: 20 * GIB };
  const LARGE = { cpus: 4, memoryMb: 8 * GIB, diskMb: 40 * GIB };
  const size = (geometry: typeof SMALL) => ({
    os: "linux" as const,
    ...geometry,
    region: "us-east",
  });
  // Rates that disagree with every served exact price on purpose.
  const CONFLICTING_RATES = {
    vcpuHourMillicredits: 50,
    memoryGbHourMillicredits: 25,
    diskGbHourMillicredits: 1,
    multiplier: 1,
  };
  const SERVED_SMALL = { awakeMc: 111, suspendedMc: 0, stoppedMc: 0 };
  const SERVED_MIDDLE = { awakeMc: 333, suspendedMc: 44, stoppedMc: 5 };

  function parsed(): SandboxCatalogue {
    const [provider] = catalogue(CONFLICTING_RATES, "linux").providers;
    return sandboxCatalogueSchema.parse({
      providers: [
        {
          ...provider,
          shapes: [
            { ...SMALL, default: false },
            { ...MIDDLE, default: true },
            { ...LARGE, default: false },
          ],
          regions: [
            {
              ...provider.regions[0],
              shapePrices: [
                { ...SMALL, priceMcPerHour: SERVED_SMALL },
                { ...MIDDLE, priceMcPerHour: SERVED_MIDDLE },
              ],
            },
          ],
        },
      ],
    });
  }

  it("prices a selected shape from the served exact rung over conflicting unit rates, zero siblings included", () => {
    const served = parsed();

    expect(stagePrice(served, size(MIDDLE))).toEqual({
      awakeMcPerHour: SERVED_MIDDLE.awakeMc,
      suspendedMcPerHour: SERVED_MIDDLE.suspendedMc,
      stoppedMcPerHour: SERVED_MIDDLE.stoppedMc,
      exact: true,
      offer: null,
    });
    expect(stagePrice(served, size(SMALL))).toEqual({
      awakeMcPerHour: SERVED_SMALL.awakeMc,
      suspendedMcPerHour: 0,
      stoppedMcPerHour: 0,
      exact: true,
      offer: null,
    });
  });

  it("prices a rung the server gave no exact price from the unit rates", () => {
    // 4 vCPU × 50 + 8 GB × 25: no served exact price names this rung.
    expect(stagePrice(parsed(), size(LARGE))?.awakeMcPerHour).toBe(400);
  });

  it("takes the smallest shape's price from its served exact rung, not the rates", () => {
    expect(stageSmallestShape(parsed(), size(MIDDLE))).toEqual({
      isStaged: false,
      awakeMcPerHour: SERVED_SMALL.awakeMc,
    });
    expect(stageSmallestShape(parsed(), size(SMALL))).toEqual({
      isStaged: true,
      awakeMcPerHour: SERVED_SMALL.awakeMc,
    });
  });
});

describe("a request with no disk among sibling rungs of the same cpu and memory", () => {
  const GIB = 1024;
  const SMALL_DISK = { cpus: 2, memoryMb: 4 * GIB, diskMb: 10 * GIB };
  const DEFAULT_DISK = { cpus: 2, memoryMb: 4 * GIB, diskMb: 20 * GIB };
  const LATER_DISK = { cpus: 2, memoryMb: 4 * GIB, diskMb: 30 * GIB };
  const OTHER_DEFAULT = { cpus: 4, memoryMb: 8 * GIB, diskMb: 20 * GIB };
  const NO_DISK = {
    os: "linux" as const,
    cpus: 2,
    memoryMb: 4 * GIB,
    diskMb: null,
    region: "us-east",
  };
  // Prices that tell the siblings apart: each rung's awake price is its disk in GiB.
  const priced = (geometry: typeof SMALL_DISK) => ({
    ...geometry,
    priceMcPerHour: {
      awakeMc: geometry.diskMb / GIB,
      suspendedMc: 1,
      stoppedMc: 1,
    },
  });

  function served(
    rungs: ReadonlyArray<{
      readonly geometry: typeof SMALL_DISK;
      readonly default: boolean;
    }>,
    readinessOf: typeof SMALL_DISK | null,
  ): SandboxCatalogue {
    const [provider] = catalogue(null, "linux").providers;
    return sandboxCatalogueSchema.parse({
      providers: [
        {
          ...provider,
          shapes: rungs.map((rung) => ({
            ...rung.geometry,
            default: rung.default,
          })),
          regions: [
            {
              ...provider.regions[0],
              shapePrices: rungs.map((rung) => priced(rung.geometry)),
            },
          ],
          ...(readinessOf === null
            ? {}
            : {
                readiness: {
                  request: {
                    os: "linux",
                    shape: readinessOf,
                    region: "us-east",
                    generationId: "gen-one",
                    launchForm: null,
                  },
                  result: { warm: 2 },
                },
              }),
        },
      ],
    });
  }

  const SIBLINGS_DEFAULT_LAST = [
    { geometry: SMALL_DISK, default: false },
    { geometry: DEFAULT_DISK, default: true },
    { geometry: LATER_DISK, default: false },
  ];

  it("prices the default rung's geometry, not a nondefault sibling listed before it", () => {
    expect(
      stagePrice(served(SIBLINGS_DEFAULT_LAST, null), NO_DISK)?.awakeMcPerHour,
    ).toBe(DEFAULT_DISK.diskMb / GIB);
  });

  it("matches readiness to the default rung's geometry, not the sibling listed before it", () => {
    expect(
      sandboxReadinessLine(
        served(SIBLINGS_DEFAULT_LAST, DEFAULT_DISK),
        NO_DISK,
      ),
    ).toBe(READY_SENTENCE);
    expect(
      sandboxReadinessLine(served(SIBLINGS_DEFAULT_LAST, SMALL_DISK), NO_DISK),
    ).toBeNull();
  });

  it("keeps the first exact match when the disk is named", () => {
    const sibling = served(SIBLINGS_DEFAULT_LAST, null);
    expect(
      stagePrice(sibling, { ...NO_DISK, diskMb: SMALL_DISK.diskMb })
        ?.awakeMcPerHour,
    ).toBe(SMALL_DISK.diskMb / GIB);
    expect(
      stagePrice(sibling, { ...NO_DISK, diskMb: LATER_DISK.diskMb })
        ?.awakeMcPerHour,
    ).toBe(LATER_DISK.diskMb / GIB);
  });

  it("takes the first matching rung when no matching rung is the default", () => {
    const noMatchingDefault = [
      { geometry: SMALL_DISK, default: false },
      { geometry: LATER_DISK, default: false },
      { geometry: OTHER_DEFAULT, default: true },
    ];
    expect(
      stagePrice(served(noMatchingDefault, null), NO_DISK)?.awakeMcPerHour,
    ).toBe(SMALL_DISK.diskMb / GIB);
    expect(
      sandboxReadinessLine(served(noMatchingDefault, SMALL_DISK), NO_DISK),
    ).toBe(READY_SENTENCE);
  });
});

describe("served source geometry without unit rates", () => {
  const SIZE = {
    os: "linux" as const,
    cpus: 1,
    memoryMb: 1024,
    diskMb: 20480,
    region: "us-east",
  };
  function offered() {
    const [provider] = catalogue(null, "linux").providers;
    return {
      providers: [
        {
          ...provider,
          regions: [
            {
              ...provider.regions[0],
              fromPriceMcPerHour: {
                awakeMc: 80,
                suspendedMc: 21,
                stoppedMc: 20,
              },
            },
          ],
        },
      ],
    };
  }
  it("keeps the smaller disk unpriced, the source exact, and a larger disk a lower bound", () => {
    const source = offered();
    expect(stagePrice(source, { ...SIZE, diskMb: 10240 })).toBeNull();
    expect(stagePrice(source, SIZE)).toEqual({
      awakeMcPerHour: 80,
      suspendedMcPerHour: 21,
      stoppedMcPerHour: 20,
      exact: true,
      offer: null,
    });
    expect(stagePrice(source, { ...SIZE, diskMb: 30720 })).toEqual({
      awakeMcPerHour: 80,
      suspendedMcPerHour: 21,
      stoppedMcPerHour: 20,
      exact: false,
      offer: null,
    });
    expect(stageSmallestShape(source, SIZE)).toBeNull();
  });
  it("computes minimum affordability from actual minimum geometry when rates include awake disk", () => {
    const [provider] = offered().providers;
    const source = {
      providers: [
        {
          ...provider,
          regions: [
            {
              ...provider.regions[0],
              pricing: {
                vcpuHourMillicredits: 50,
                memoryGbHourMillicredits: 25,
                diskGbHourMillicredits: 1,
                awakeDiskGbHourMillicredits: 2,
                multiplier: 1,
              },
            },
          ],
        },
      ],
    };
    expect(stageSmallestShape(source, { ...SIZE, diskMb: 10240 })).toEqual({
      isStaged: true,
      awakeMcPerHour: 95,
    });
    expect(stageSmallestShape(source, SIZE)).toEqual({
      isStaged: false,
      awakeMcPerHour: 95,
    });
  });
  it("uses the first fixed rung as source even when another rung is default and smaller", () => {
    const [provider] = offered().providers;
    const source = {
      providers: [
        {
          ...provider,
          shapes: [
            { cpus: 4, memoryMb: 8192, diskMb: 40960, default: false },
            { cpus: 2, memoryMb: 4096, diskMb: 20480, default: true },
          ],
        },
      ],
    };
    expect(
      stagePrice(source, { ...SIZE, cpus: 4, memoryMb: 8192, diskMb: 40960 })
        ?.exact,
    ).toBe(true);
    expect(stagePrice(source, { ...SIZE, cpus: 2, memoryMb: 4096 })).toBeNull();
    expect(
      stageSmallestShape(source, { ...SIZE, cpus: 2, memoryMb: 4096 }),
    ).toBeNull();
  });
  it("does not re-round the served source when a valid default disk is not aligned to its step", () => {
    const [provider] = offered().providers;
    const source = {
      providers: [
        { ...provider, shape: { ...provider.shape, diskDefaultMb: 25000 } },
      ],
    };
    expect(stagePrice(source, { ...SIZE, diskMb: null })?.exact).toBe(false);
  });
  it("saves the nondefault rung's quoted disk as configuration defaults", () => {
    const [provider] = offered().providers;
    const source = {
      providers: [
        {
          ...provider,
          shapes: [
            { cpus: 2, memoryMb: 4096, diskMb: 20480, default: true },
            { cpus: 4, memoryMb: 8192, diskMb: 40960, default: false },
          ],
        },
      ],
    };
    expect(
      stageShapeDefaults(source, {
        ...SIZE,
        cpus: 4,
        memoryMb: 8192,
        diskMb: null,
        idleMinutes: 30,
        destroyAfterRestingMinutes: 120,
      }),
    ).toEqual({
      os: "linux",
      cpus: 4,
      memoryMb: 8192,
      diskMb: 40960,
      idleMinutes: 30,
      restingMinutes: 120,
    });
  });
});
