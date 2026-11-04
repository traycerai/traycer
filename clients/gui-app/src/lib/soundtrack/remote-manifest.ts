import { z } from "zod";
import type { SoundtrackManifest } from "./manifest";

/**
 * The published form of a track set, v1: the definitions travel with the stems,
 * so a set needs no app change. Both ways a manifest reaches the app read it
 * here, the development server's and the desktop's. Stem files are paths
 * relative to the manifest as published, and whatever a reader has made of them
 * by the time it parses.
 *
 * A manifest either plays or is refused whole, because the engine trusts what
 * it is given: it throws on a state that does not fit its track, and a zero grid
 * would never advance. Everything below is something it relies on.
 */

const name = z.string().min(1);
const seconds = z.number().nonnegative();
const count = z.number().int().nonnegative();
const positiveCount = z.number().int().positive();

function rangeOf(bound: z.ZodNumber) {
  return z
    .tuple([bound, bound])
    .refine(([min, max]) => min <= max, "A range's min is above its max");
}

const secondsRange = rangeOf(seconds);
const pan = z.number().min(-1).max(1).nullable();

const layerFields = {
  name,
  sublayers: positiveCount,
  sublayerStartingOffset: secondsRange.nullable(),
  pan,
};

const pooledLayer = z.strictObject({ ...layerFields, variants: positiveCount });

const groupedLayer = z.strictObject({
  ...layerFields,
  groups: z.array(z.strictObject({ name, variants: positiveCount })).min(1),
  sequence: z.array(name).min(1),
});

const layerProperties = z.strictObject({
  enabled: z.boolean().nullable(),
  startPause: secondsRange,
  sequenceLength: rangeOf(positiveCount),
  pauseBetweenSamples: secondsRange,
  pauseBetweenRepetitions: z.union([
    secondsRange,
    z
      .array(z.strictObject({ range: secondsRange, weight: seconds }))
      .refine(
        (rows) => rows.some((row) => row.weight > 0),
        "A pause table has no row to pick",
      ),
  ]),
  playsPerRun: positiveCount.nullable(),
});

const state = z.strictObject({
  name,
  layersProperties: z.array(layerProperties),
  numberOfEnabledLayers: rangeOf(count),
});

const phase = z.strictObject({
  afterSeconds: secondsRange,
  state: name,
  fadeSeconds: seconds,
});

const bookend = z.strictObject({ name, variants: positiveCount, pan });

const trackShape = z.strictObject({
  name,
  title: z.string(),
  lengthSeconds: z.number().positive(),
  alignmentSeconds: z.number().positive(),
  layers: z.array(z.union([pooledLayer, groupedLayer])).min(1),
  states: z.array(state).min(1),
  intro: bookend.nullable(),
  outro: bookend.nullable(),
  phases: z.array(phase),
});

type ParsedTrack = z.infer<typeof trackShape>;

function repeatedNames(names: readonly string[]): readonly string[] {
  return names.filter((item, index) => names.indexOf(item) !== index);
}

function trackProblems(parsed: ParsedTrack): readonly string[] {
  const label = `Track "${parsed.name}"`;
  const stateNames = parsed.states.map((item) => item.name);
  return [
    ...repeatedNames(parsed.layers.map((layer) => layer.name)).map(
      (layerName) => `${label} has two layers named "${layerName}"`,
    ),
    ...repeatedNames(stateNames).map(
      (stateName) => `${label} has two states named "${stateName}"`,
    ),
    ...parsed.states
      .filter((item) => item.layersProperties.length !== parsed.layers.length)
      .map(
        (item) =>
          `${label} state "${item.name}" has ${String(item.layersProperties.length)} layer properties for ${String(parsed.layers.length)} layers`,
      ),
    ...parsed.phases
      .filter((item) => !stateNames.includes(item.state))
      .map((item) => `${label} has a phase naming no state: "${item.state}"`),
    ...parsed.layers.flatMap((layer) => {
      if (!("groups" in layer)) return [];
      const groupNames = layer.groups.map((group) => group.name);
      return [
        ...repeatedNames(groupNames).map(
          (groupName) =>
            `${label} layer "${layer.name}" has two groups named "${groupName}"`,
        ),
        ...layer.sequence
          .filter((groupName) => !groupNames.includes(groupName))
          .map(
            (groupName) =>
              `${label} layer "${layer.name}" has a sequence naming no group: "${groupName}"`,
          ),
      ];
    }),
  ];
}

const track = trackShape.superRefine((parsed, context) => {
  for (const message of trackProblems(parsed)) {
    context.addIssue({ code: "custom", message });
  }
});

const stemFiles = z.strictObject({ name, files: z.array(z.string().min(1)) });

const stemLayer = z.union([
  stemFiles,
  z.strictObject({ name, groups: z.array(stemFiles) }),
]);

const stemManifest = z.strictObject({
  tracks: z.array(z.strictObject({ name, layers: z.array(stemLayer) })),
});

type ParsedStemTrack = z.infer<typeof stemManifest>["tracks"][number];

/** A sample every variant can be found by; a wrong count is a wrong sample. */
function stemProblems(
  parsed: ParsedTrack,
  stems: ParsedStemTrack | undefined,
): readonly string[] {
  const label = `Track "${parsed.name}"`;
  if (stems === undefined) return [`${label} has no stems`];
  const entryOf = (entryName: string) =>
    stems.layers.find((entry) => entry.name === entryName);
  const filesMismatch = (
    subject: string,
    files: readonly string[] | undefined,
    variants: number,
  ): readonly string[] =>
    files?.length === variants
      ? []
      : [
          `${label} ${subject} has ${String(files?.length ?? 0)} stem files for ${String(variants)} variants`,
        ];
  return [
    ...parsed.layers.flatMap((layer) => {
      const entry = entryOf(layer.name);
      const subject = `layer "${layer.name}"`;
      if (!("groups" in layer)) {
        const files = entry !== undefined && "files" in entry ? entry : null;
        return filesMismatch(subject, files?.files, layer.variants);
      }
      const groups = entry !== undefined && "groups" in entry ? entry : null;
      return layer.groups.flatMap((group) =>
        filesMismatch(
          `${subject} group "${group.name}"`,
          groups?.groups.find((item) => item.name === group.name)?.files,
          group.variants,
        ),
      );
    }),
    ...[parsed.intro, parsed.outro].flatMap((edge) => {
      if (edge === null) return [];
      const entry = entryOf(edge.name);
      return filesMismatch(
        `intro or outro "${edge.name}"`,
        entry !== undefined && "files" in entry ? entry.files : undefined,
        edge.variants,
      );
    }),
  ];
}

const viewTracks = z.array(name);

const remoteManifest = z
  .strictObject({
    version: z.literal(1),
    tracks: z.array(track),
    views: z.strictObject({
      home: viewTracks,
      task: viewTracks,
      bot: viewTracks,
      settings: viewTracks,
    }),
    stems: stemManifest,
  })
  .superRefine((parsed, context) => {
    const trackNames = parsed.tracks.map((item) => item.name);
    const problems = [
      ...repeatedNames(trackNames).map(
        (trackName) => `Two tracks are named "${trackName}"`,
      ),
      ...Object.entries(parsed.views).flatMap(([view, names]) =>
        names
          .filter((trackName) => !trackNames.includes(trackName))
          .map((trackName) => `View "${view}" names no track: "${trackName}"`),
      ),
      ...parsed.tracks.flatMap((item) =>
        stemProblems(
          item,
          parsed.stems.tracks.find((stems) => stems.name === item.name),
        ),
      ),
    ];
    for (const message of problems) {
      context.addIssue({ code: "custom", message });
    }
  });

/** Throws, naming what is wrong, on a manifest the engine cannot play. */
export function parseRemoteManifest(value: unknown): SoundtrackManifest {
  const { tracks, views, stems } = remoteManifest.parse(value);
  return { tracks, views, stems };
}
