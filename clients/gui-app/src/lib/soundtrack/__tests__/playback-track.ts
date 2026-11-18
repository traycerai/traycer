import type { VariableTrack } from "../variable-sound";

/**
 * A track of `lengthSeconds` with two layers on one state that rolls one of
 * them on, each sample coming round after 4 s of pause.
 */
export function playbackTrack(
  name: string,
  lengthSeconds: number,
): VariableTrack {
  const properties = {
    enabled: null,
    startPause: [0, 0],
    sequenceLength: [1, 1],
    pauseBetweenSamples: [0, 0],
    pauseBetweenRepetitions: [4, 4],
    playsPerRun: null,
  } as const;
  return {
    name,
    title: name,
    lengthSeconds,
    alignmentSeconds: 0.5,
    layers: ["A", "B"].map((layerName) => ({
      name: layerName,
      variants: 1,
      role: null,
      sublayers: 1,
      sublayerStartingOffset: null,
      pan: null,
    })),
    states: [
      {
        name: "only",
        layersProperties: [properties, properties],
        numberOfEnabledLayers: [1, 1],
      },
    ],
    intro: null,
    outro: null,
    phases: [],
  };
}
