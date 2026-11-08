/**
 * The v1 manifest both the dev server and the desktop answer: accepted whole or
 * refused whole, because the engine trusts what it is given.
 */
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseRemoteManifest } from "../remote-manifest";
import type { LayerProperties, VariableTrack } from "../variable-sound";
import { AQUILO_1 } from "./aquilo-1";

function files(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}/${String(index + 1)}.opus`,
  );
}

const SLASH = "A name may hold only A-Z a-z 0-9 . _ -";

const EMPTY_VIEWS = { home: [], task: [], bot: [], settings: [] };

function aquiloStems() {
  return {
    name: "aquilo-1",
    layers: [
      { name: "A", files: files("aquilo-1/A", 1) },
      { name: "B", files: files("aquilo-1/B", 4) },
      { name: "C", files: files("aquilo-1/C", 16) },
      { name: "D", files: files("aquilo-1/D", 8) },
    ],
  };
}

function aquiloManifest() {
  return {
    version: 1,
    tracks: [AQUILO_1],
    views: { ...EMPTY_VIEWS, home: ["aquilo-1"] },
    stems: { tracks: [aquiloStems()] },
  };
}

function pausing(): LayerProperties {
  return {
    enabled: true,
    startPause: [0, 2],
    sequenceLength: [1, 2],
    pauseBetweenSamples: [0, 1],
    pauseBetweenRepetitions: [
      { range: [1, 2], weight: 3 },
      { range: [5, 9], weight: 1 },
    ],
    playsPerRun: 2,
  };
}

const SUITE: VariableTrack = {
  name: "suite",
  title: "Suite",
  lengthSeconds: 60,
  alignmentSeconds: 2,
  layers: [
    {
      name: "pool",
      variants: 2,
      role: null,
      sublayers: 1,
      sublayerStartingOffset: null,
      pan: -0.5,
    },
    {
      name: "set",
      groups: [
        { name: "x", variants: 2 },
        { name: "y", variants: 1 },
      ],
      sequence: ["x", "y", "x"],
      role: null,
      sublayers: 1,
      sublayerStartingOffset: null,
      pan: null,
    },
  ],
  states: [
    {
      name: "open",
      layersProperties: [pausing(), pausing()],
      numberOfEnabledLayers: [1, 2],
    },
    {
      name: "late",
      layersProperties: [pausing(), pausing()],
      numberOfEnabledLayers: [2, 2],
    },
  ],
  intro: { name: "intro", variants: 2, pan: null },
  outro: { name: "outro", variants: 1, pan: 0.25 },
  phases: [{ afterSeconds: [20, 30], state: "late", fadeSeconds: 4 }],
};

function suiteManifest() {
  return {
    version: 1,
    tracks: [SUITE],
    views: { ...EMPTY_VIEWS, task: ["suite"] },
    stems: {
      tracks: [
        {
          name: "suite",
          layers: [
            { name: "pool", files: files("suite/pool", 2) },
            {
              name: "set",
              groups: [
                { name: "x", files: files("suite/x", 2) },
                { name: "y", files: files("suite/y", 1) },
              ],
            },
            { name: "intro", files: files("suite/intro", 2) },
            { name: "outro", files: files("suite/outro", 1) },
          ],
        },
      ],
    },
  };
}

function issueMessages(value: unknown): readonly string[] {
  try {
    parseRemoteManifest(value);
  } catch (error) {
    if (error instanceof ZodError) {
      return error.issues.map((issue) => issue.message);
    }
    throw error;
  }
  return [];
}

function generative(value: unknown): VariableTrack {
  const [first] = parseRemoteManifest(value).tracks;
  if (first.kind !== "generative") {
    throw new Error("Expected a generative track");
  }
  return first;
}

describe("parseRemoteManifest", () => {
  it("accepts the dev manifest in v1 form, without its version", () => {
    const { version: _version, ...expected } = aquiloManifest();

    expect(parseRemoteManifest(aquiloManifest())).toEqual({
      ...expected,
      tracks: [{ ...AQUILO_1, kind: "generative" }],
    });
  });

  // A role a layer names comes through in the exact check above.
  it("reads a layer published with no role as one with none", () => {
    const unroled = {
      ...aquiloManifest(),
      tracks: [
        {
          ...AQUILO_1,
          layers: AQUILO_1.layers.map(({ role: _role, ...layer }) => layer),
        },
      ],
    };

    expect(generative(unroled).layers.map((layer) => layer.role)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("accepts a track using groups, an intro, an outro and phases", () => {
    const { version: _version, ...expected } = suiteManifest();

    expect(parseRemoteManifest(suiteManifest())).toEqual({
      ...expected,
      tracks: [{ ...SUITE, kind: "generative" }],
    });
  });

  it("accepts dots, underscores and dashes in a track and a layer name", () => {
    const manifest = suiteManifest();
    const renamed = {
      ...manifest,
      tracks: [
        {
          ...SUITE,
          name: "A.b_c-1",
          layers: [{ ...SUITE.layers[0], name: "L.b_c-1" }, SUITE.layers[1]],
        },
      ],
      views: { ...EMPTY_VIEWS, task: ["A.b_c-1"] },
      stems: {
        tracks: [
          {
            ...manifest.stems.tracks[0],
            name: "A.b_c-1",
            layers: [
              { name: "L.b_c-1", files: files("suite/pool", 2) },
              ...manifest.stems.tracks[0].layers.slice(1),
            ],
          },
        ],
      },
    };

    expect(generative(renamed).layers[0].name).toBe("L.b_c-1");
  });

  it("accepts a space in a state name, which no stem path carries", () => {
    const manifest = {
      ...suiteManifest(),
      tracks: [
        {
          ...SUITE,
          states: [{ ...SUITE.states[0], name: "late night" }, SUITE.states[1]],
        },
      ],
    };

    expect(generative(manifest).states[0].name).toBe("late night");
  });

  const refused: readonly (readonly [string, string, () => unknown])[] = [
    [
      "a view naming no track",
      'View "task" names no track: "ghost"',
      () => ({
        ...aquiloManifest(),
        views: { ...EMPTY_VIEWS, task: ["ghost"] },
      }),
    ],
    [
      "a phase naming a missing state",
      'Track "suite" has a phase naming no state: "nowhere"',
      () => ({
        ...suiteManifest(),
        tracks: [
          {
            ...SUITE,
            phases: [
              { afterSeconds: [1, 2], state: "nowhere", fadeSeconds: 1 },
            ],
          },
        ],
      }),
    ],
    [
      "a state whose layer properties differ in count from the layers",
      'Track "aquilo-1" state "begin" has 1 layer properties for 4 layers',
      () => ({
        ...aquiloManifest(),
        tracks: [
          {
            ...AQUILO_1,
            states: [
              {
                ...AQUILO_1.states[0],
                layersProperties: [AQUILO_1.states[0].layersProperties[0]],
              },
            ],
          },
        ],
      }),
    ],
    [
      "a range with min above max",
      "A range's min is above its max",
      () => ({
        ...aquiloManifest(),
        tracks: [
          {
            ...AQUILO_1,
            states: [{ ...AQUILO_1.states[0], numberOfEnabledLayers: [4, 2] }],
          },
        ],
      }),
    ],
    [
      "an alignment of zero seconds",
      "Too small: expected number to be >0",
      () => ({
        ...aquiloManifest(),
        tracks: [{ ...AQUILO_1, alignmentSeconds: 0 }],
      }),
    ],
    [
      "a pause table with no positive weight",
      "A pause table has no row to pick",
      () => ({
        ...suiteManifest(),
        tracks: [
          {
            ...SUITE,
            states: [
              {
                ...SUITE.states[0],
                layersProperties: [
                  {
                    ...pausing(),
                    pauseBetweenRepetitions: [{ range: [1, 2], weight: 0 }],
                  },
                  pausing(),
                ],
              },
              SUITE.states[1],
            ],
          },
        ],
      }),
    ],
    [
      "a sequence naming no group",
      'Track "suite" layer "set" has a sequence naming no group: "z"',
      () => ({
        ...suiteManifest(),
        tracks: [
          {
            ...SUITE,
            layers: [
              SUITE.layers[0],
              { ...SUITE.layers[1], sequence: ["x", "z"] },
            ],
          },
        ],
      }),
    ],
    [
      "a layer with no stems",
      'Track "aquilo-1" layer "B" has 0 stem files for 4 variants',
      () => {
        const stems = aquiloStems();
        return {
          ...aquiloManifest(),
          stems: {
            tracks: [
              {
                ...stems,
                layers: stems.layers.filter((layer) => layer.name !== "B"),
              },
            ],
          },
        };
      },
    ],
    [
      "a wrong file count",
      'Track "aquilo-1" layer "C" has 15 stem files for 16 variants',
      () => {
        const stems = aquiloStems();
        return {
          ...aquiloManifest(),
          stems: {
            tracks: [
              {
                ...stems,
                layers: stems.layers.map((layer) =>
                  layer.name === "C"
                    ? { ...layer, files: files("aquilo-1/C", 15) }
                    : layer,
                ),
              },
            ],
          },
        };
      },
    ],
    [
      "a layer with both variants and groups",
      "Invalid input",
      () => ({
        ...suiteManifest(),
        tracks: [
          {
            ...SUITE,
            layers: [SUITE.layers[0], { ...SUITE.layers[1], variants: 3 }],
          },
        ],
      }),
    ],
    [
      "a slash in a layer name beside a group that would join to the same path",
      SLASH,
      () => ({
        ...suiteManifest(),
        tracks: [
          {
            ...SUITE,
            layers: [
              { ...SUITE.layers[0], name: "set/x" },
              {
                ...SUITE.layers[1],
                name: "set",
                groups: [{ name: "x", variants: 1 }],
                sequence: ["x"],
              },
            ],
          },
        ],
      }),
    ],
    [
      "a slash in a track name",
      SLASH,
      () => ({ ...suiteManifest(), tracks: [{ ...SUITE, name: "su/ite" }] }),
    ],
    [
      "a slash in a group name",
      SLASH,
      () => ({
        ...suiteManifest(),
        tracks: [
          {
            ...SUITE,
            layers: [
              SUITE.layers[0],
              {
                ...SUITE.layers[1],
                groups: [{ name: "x/y", variants: 2 }],
                sequence: ["x/y"],
              },
            ],
          },
        ],
      }),
    ],
    [
      "a slash in an intro name",
      SLASH,
      () => ({
        ...suiteManifest(),
        tracks: [
          { ...SUITE, intro: { name: "in/tro", variants: 2, pan: null } },
        ],
      }),
    ],
    [
      "a slash in an outro name",
      SLASH,
      () => ({
        ...suiteManifest(),
        tracks: [
          { ...SUITE, outro: { name: "out/ro", variants: 1, pan: null } },
        ],
      }),
    ],
    [
      "a layer role that is none of the four",
      "Invalid input",
      () => ({
        ...aquiloManifest(),
        tracks: [
          {
            ...AQUILO_1,
            layers: AQUILO_1.layers.map((layer) => ({
              ...layer,
              role: "bass",
            })),
          },
        ],
      }),
    ],
    [
      "version 2",
      "A v2 track needs a kind",
      () => ({ ...aquiloManifest(), version: 2 }),
    ],
  ];

  it.each(refused)("refuses %s", (_label, message, build) => {
    expect(issueMessages(build())).toContain(message);
  });
});
