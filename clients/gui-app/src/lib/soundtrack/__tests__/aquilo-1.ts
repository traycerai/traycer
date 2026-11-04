import type { VariableTrack } from "../variable-sound";

/** `aquilo-1.lua` from Space Age, transcribed. Numbers only, no audio. */
export const AQUILO_1: VariableTrack = {
  name: "aquilo-1",
  title: "Aquilo 1 - -77.7  Celsius",
  lengthSeconds: 300,
  alignmentSeconds: 1,
  layers: [
    {
      name: "A",
      variants: 1,
      sublayers: 1,
      sublayerStartingOffset: null,
      pan: null,
    },
    {
      name: "B",
      variants: 4,
      sublayers: 1,
      sublayerStartingOffset: null,
      pan: null,
    },
    {
      name: "C",
      variants: 16,
      sublayers: 2,
      sublayerStartingOffset: [10, 15],
      pan: null,
    },
    {
      name: "D",
      variants: 8,
      sublayers: 1,
      sublayerStartingOffset: null,
      pan: null,
    },
  ],
  states: [
    {
      name: "begin",
      layersProperties: [
        {
          enabled: null,
          startPause: [0, 15],
          sequenceLength: [1, 1],
          pauseBetweenSamples: [0, 0],
          pauseBetweenRepetitions: [0, 3],
          playsPerRun: null,
        },
        {
          enabled: null,
          startPause: [0, 15],
          sequenceLength: [1, 4],
          pauseBetweenSamples: [0, 3],
          pauseBetweenRepetitions: [10, 15],
          playsPerRun: null,
        },
        {
          enabled: null,
          startPause: [0, 15],
          sequenceLength: [2, 4],
          pauseBetweenSamples: [0, 3],
          pauseBetweenRepetitions: [15, 30],
          playsPerRun: null,
        },
        {
          enabled: null,
          startPause: [0, 15],
          sequenceLength: [1, 1],
          pauseBetweenSamples: [0, 0],
          pauseBetweenRepetitions: [5, 10],
          playsPerRun: null,
        },
      ],
      numberOfEnabledLayers: [2, 4],
    },
  ],
  intro: null,
  outro: null,
  phases: [],
};
