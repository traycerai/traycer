export const speechQueryKeys = {
  /** Whether the shell's own recognizer can transcribe `language`. */
  deviceAvailability: (language: string) =>
    ["speech.deviceAvailability", language] as const,
};
