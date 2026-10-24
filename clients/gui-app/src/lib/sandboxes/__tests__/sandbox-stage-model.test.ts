import { describe, expect, it } from "vitest";
import {
  consequenceClauses,
  type ConsequenceClause,
  consequencesShownSubject,
  defaultStageShape,
  priceClause,
  stagePrice,
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
    price: { awakeMcPerHour: 120, exact: true },
    needsCredits: false,
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
      priceClause(input({ price: { awakeMcPerHour: 120, exact: false } })).text,
    ).toBe("from $0.12 an hour while awake · uses your credits");
  });

  it("asks for credits at a zero or short balance", () => {
    expect(priceClause(input({ needsCredits: true })).text).toBe(
      "Add credits to start a sandbox · from $0.12 an hour while awake",
    );
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
    expect(clauses[1].text).toContain("MacBook");
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
    expect(clauses[0].text).toMatch(/^Add credits to start a sandbox/);
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
          multiplier: 1.1,
        },
        "linux",
      ),
      STAGED,
    );
    // (2 × 50 + 4 × 25 + 20 × 0.5) × 1.1
    expect(price).toEqual({ awakeMcPerHour: 231, exact: true });
  });

  it("quotes the smallest shape exactly without the rates, but a larger disk only as from", () => {
    const smallest = { ...STAGED, cpus: 1, memoryMb: 1024, diskMb: 10240 };
    expect(stagePrice(catalogue(null, "linux"), smallest)).toEqual({
      awakeMcPerHour: 80,
      exact: true,
    });
    expect(
      stagePrice(catalogue(null, "linux"), { ...smallest, diskMb: 20480 }),
    ).toEqual({ awakeMcPerHour: 80, exact: false });
  });

  it("quotes the smallest shape's price as a from price without the rates", () => {
    expect(stagePrice(catalogue(null, "linux"), STAGED)).toEqual({
      awakeMcPerHour: 80,
      exact: false,
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
