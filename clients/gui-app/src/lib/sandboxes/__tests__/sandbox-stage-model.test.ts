import { sandboxReadinessLine } from "@/lib/sandboxes/sandbox-readiness";
import { describe, expect, it } from "vitest";
import {
  consequenceClauses,
  type ConsequenceClause,
  consequencesShownSubject,
  defaultStageShape,
  priceClause,
  configurationStageShape,
  rememberedOrConfigurationStageShape,
  stagePrice,
  stageShapeDefaults,
  stageProviderForShape,
  stageSmallestShape,
  type ConsequencesInput,
} from "@/lib/sandboxes/sandbox-stage-model";
import type {
  SandboxCatalogue,
  SandboxCataloguePricing,
  SandboxOs,
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
    },
    needsCredits: false,
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
    expect(priceClause(input({ configuration: ACME })).text).toBe(
      "$0.12 an hour while awake · uses your Acme credits",
    );
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
    expect(
      priceClause(
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
          },
          needsCredits: true,
          shortfallMc: 210,
        }),
      ).text,
    ).toBe(
      "Your pool-e2e-fixture allowance is short $0.21. $0.21 more starts this sandbox for an hour.",
    );
    expect(
      priceClause(
        input({
          price: {
            awakeMcPerHour: 210,
            suspendedMcPerHour: 4,
            stoppedMcPerHour: 2,
            exact: false,
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

  it("adds the team, resting-storage and shared-use clauses on a team", () => {
    const clauses = consequenceClauses(input({ configuration: ACME }));
    expect(kinds(clauses)).toEqual([
      "price",
      "team",
      "resting-storage",
      "shared-use",
    ]);
    expect(clauses[1].text).toContain("Acme");
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
      "shared-use",
      "move",
    ]);
  });

  it("puts the add-credits price first, ahead of the rest", () => {
    const clauses = consequenceClauses(
      input({ configuration: ACME, needsCredits: true }),
    );
    expect(clauses[0].text).toMatch(/^Your Acme allowance is short/);
    expect(clauses).toHaveLength(4);
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
        provider: "tensorlake",
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
    });
  });

  it("quotes the smallest shape's price as a from price without the rates", () => {
    expect(stagePrice(catalogue(null, "linux"), STAGED)).toEqual({
      awakeMcPerHour: 80,
      suspendedMcPerHour: 4,
      stoppedMcPerHour: 2,
      exact: false,
    });
  });
});

describe("stageProviderForShape", () => {
  it("prices the provider offering the selected region rather than the first OS match", () => {
    const [first] = catalogue(null, "linux").providers;
    const selected = {
      ...first,
      provider: "daytona" as const,
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
  const STAGED = {
    os: "linux",
    region: "us-east",
    cpus: 2,
    memoryMb: 4096,
    diskMb: 20480,
    idleMinutes: 30,
    destroyAfterRestingMinutes: null,
  } as const;

  function listed(pricing: SandboxCataloguePricing | null): SandboxCatalogue {
    const [provider] = catalogue(pricing, "linux").providers;
    return {
      providers: [{ ...provider, shapes: [LARGE, MIDDLE, SMALLEST] }],
    };
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
    });
    expect(sandboxReadinessLine(offered, SIZE)).toBe("2 ready now.");
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
    });
    expect(sandboxReadinessLine(offered, size)).toBe("2 ready now.");
  });

  it("keeps a nondefault disk quote from an older server as a lower bound when its step is unknown", () => {
    const [provider] = catalogue(RATES, "linux").providers;
    const { diskStepMb: _step, ...shape } = provider.shape;
    const older = { providers: [{ ...provider, shape }] };
    expect(stagePrice(older, SIZE)?.exact).toBe(false);
    expect(stagePrice(older, { ...SIZE, diskMb: null })?.exact).toBe(true);
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
    });
    expect(stagePrice(source, { ...SIZE, diskMb: 30720 })).toEqual({
      awakeMcPerHour: 80,
      suspendedMcPerHour: 21,
      stoppedMcPerHour: 20,
      exact: false,
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
