const SAMPLE_RATE = 1000;

/**
 * jsdom has no `AudioBuffer`. This implements the whole interface over an
 * empty channel, so `length` can stand for a large decoded file without
 * allocating it.
 */
export function makeAudioBuffer(
  durationSeconds: number,
  length: number,
): AudioBuffer {
  const channel = new Float32Array(0);
  return {
    duration: durationSeconds,
    length,
    numberOfChannels: 1,
    sampleRate: SAMPLE_RATE,
    getChannelData: () => channel,
    copyFromChannel: (destination) => {
      destination.set(channel.subarray(0, destination.length));
    },
    copyToChannel: (source) => {
      channel.set(source.subarray(0, channel.length));
    },
  };
}
