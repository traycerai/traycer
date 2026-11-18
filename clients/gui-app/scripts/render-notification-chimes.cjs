// From clients/desktop: bunx electron ../gui-app/scripts/render-notification-chimes.cjs
// OfflineAudioContext never opens an output device. Do not import this in the app.
const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const CHIME_VOICES = {
  classic: [
    {
      attack: 0.01,
      delay: 0,
      duration: 0.32,
      endFrequency: 880,
      frequencyRampDuration: 0.32,
      gain: 1,
      startFrequency: 880,
      type: "sine",
    },
    {
      attack: 0.004,
      delay: 0,
      duration: 0.14,
      endFrequency: 1760,
      frequencyRampDuration: 0.14,
      gain: 0.22,
      startFrequency: 1760,
      type: "sine",
    },
  ],
  prism: [
    {
      attack: 0.005,
      delay: 0,
      duration: 0.17,
      endFrequency: 659.25,
      frequencyRampDuration: 0.17,
      gain: 0.7,
      startFrequency: 659.25,
      type: "triangle",
    },
    {
      attack: 0.005,
      delay: 0.09,
      duration: 0.17,
      endFrequency: 880,
      frequencyRampDuration: 0.17,
      gain: 0.8,
      startFrequency: 880,
      type: "triangle",
    },
    {
      attack: 0.005,
      delay: 0.18,
      duration: 0.22,
      endFrequency: 1108.73,
      frequencyRampDuration: 0.22,
      gain: 0.9,
      startFrequency: 1108.73,
      type: "triangle",
    },
  ],
  ripple: [
    {
      attack: 0.003,
      delay: 0,
      duration: 0.26,
      endFrequency: 880,
      frequencyRampDuration: 0.09,
      gain: 1,
      startFrequency: 440,
      type: "sine",
    },
    {
      attack: 0.003,
      delay: 0.17,
      duration: 0.24,
      endFrequency: 659.25,
      frequencyRampDuration: 0.09,
      gain: 0.3,
      startFrequency: 330,
      type: "sine",
    },
  ],
  ember: [
    {
      attack: 0.012,
      delay: 0,
      duration: 0.42,
      endFrequency: 440,
      frequencyRampDuration: 0.42,
      gain: 0.9,
      startFrequency: 440,
      type: "triangle",
    },
    {
      attack: 0.012,
      delay: 0,
      duration: 0.3,
      endFrequency: 659.25,
      frequencyRampDuration: 0.3,
      gain: 0.3,
      startFrequency: 659.25,
      type: "sine",
    },
  ],
  orbit: [
    {
      attack: 0.005,
      delay: 0,
      duration: 0.16,
      endFrequency: 880,
      frequencyRampDuration: 0.16,
      gain: 0.9,
      startFrequency: 880,
      type: "sine",
    },
    {
      attack: 0.005,
      delay: 0.17,
      duration: 0.28,
      endFrequency: 659.25,
      frequencyRampDuration: 0.28,
      gain: 1,
      startFrequency: 659.25,
      type: "sine",
    },
    {
      attack: 0.005,
      delay: 0.17,
      duration: 0.28,
      endFrequency: 661,
      frequencyRampDuration: 0.28,
      gain: 0.35,
      startFrequency: 661,
      type: "sine",
    },
  ],
  rift: [
    {
      attack: 0.005,
      delay: 0,
      duration: 0.16,
      endFrequency: 659.25,
      frequencyRampDuration: 0.16,
      gain: 0.62,
      startFrequency: 659.25,
      type: "triangle",
      decayStart: 0.005,
      decayTimeConstant: 0.06,
    },
    {
      attack: 0.005,
      delay: 0.1,
      duration: 0.2,
      endFrequency: 622.25,
      frequencyRampDuration: 0.2,
      gain: 0.7,
      startFrequency: 622.25,
      type: "triangle",
      decayStart: 0.005,
      decayTimeConstant: 0.075,
    },
    {
      attack: 0.008,
      delay: 0.2,
      duration: 0.19,
      endFrequency: 440,
      frequencyRampDuration: 0.19,
      gain: 0.3,
      startFrequency: 440,
      type: "sine",
      decayStart: 0.008,
      decayTimeConstant: 0.08,
    },
  ],
  coin: [
    {
      attack: 0.003,
      delay: 0,
      duration: 0.085,
      endFrequency: 988,
      frequencyRampDuration: 0.085,
      gain: 0.5,
      startFrequency: 988,
      type: "square",
      decayStart: 0.082,
      decayTimeConstant: 0.004,
    },
    {
      attack: 0.003,
      delay: 0.085,
      duration: 0.25,
      endFrequency: 1319,
      frequencyRampDuration: 0.25,
      gain: 0.5,
      startFrequency: 1319,
      type: "square",
      decayStart: 0.003,
      decayTimeConstant: 0.09,
    },
  ],
  bloop: [
    {
      attack: 0.003,
      delay: 0,
      duration: 0.24,
      endFrequency: 900,
      frequencyRampDuration: 0.17,
      frequencyWaypoints: [{ frequency: 350, time: 0.07 }],
      gain: 1,
      startFrequency: 700,
      type: "sine",
      decayStart: 0.003,
      decayTimeConstant: 0.07,
    },
  ],
  cuckoo: [
    {
      attack: 0.005,
      delay: 0,
      duration: 0.15,
      endFrequency: 784,
      frequencyRampDuration: 0.15,
      gain: 1,
      startFrequency: 784,
      type: "sine",
      decayStart: 0.005,
      decayTimeConstant: 0.06,
    },
    {
      attack: 0.005,
      delay: 0,
      duration: 0.15,
      endFrequency: 1176,
      frequencyRampDuration: 0.15,
      gain: 0.15,
      startFrequency: 1176,
      type: "sine",
      decayStart: 0.005,
      decayTimeConstant: 0.06,
    },
    {
      attack: 0.005,
      delay: 0.2,
      duration: 0.22,
      endFrequency: 622,
      frequencyRampDuration: 0.22,
      gain: 1,
      startFrequency: 622,
      type: "sine",
      decayStart: 0.005,
      decayTimeConstant: 0.09,
    },
    {
      attack: 0.005,
      delay: 0.2,
      duration: 0.22,
      endFrequency: 933,
      frequencyRampDuration: 0.22,
      gain: 0.15,
      startFrequency: 933,
      type: "sine",
      decayStart: 0.005,
      decayTimeConstant: 0.09,
    },
  ],
  "ta-da": [
    {
      attack: 0.004,
      delay: 0,
      duration: 0.07,
      endFrequency: 440,
      frequencyRampDuration: 0.025,
      gain: 0.38,
      startFrequency: 415.3,
      type: "triangle",
      decayStart: 0.004,
      decayTimeConstant: 0.025,
    },
    {
      attack: 0.004,
      delay: 0.07,
      duration: 0.075,
      endFrequency: 554.37,
      frequencyRampDuration: 0.025,
      gain: 0.42,
      startFrequency: 523.25,
      type: "triangle",
      decayStart: 0.004,
      decayTimeConstant: 0.028,
    },
    {
      attack: 0.004,
      delay: 0.145,
      duration: 0.25,
      endFrequency: 659.25,
      frequencyRampDuration: 0.25,
      gain: 0.55,
      startFrequency: 659.25,
      type: "triangle",
      decayStart: 0.004,
      decayTimeConstant: 0.1,
    },
    {
      attack: 0.004,
      delay: 0.145,
      duration: 0.27,
      endFrequency: 880,
      frequencyRampDuration: 0.27,
      gain: 0.6,
      startFrequency: 880,
      type: "triangle",
      decayStart: 0.004,
      decayTimeConstant: 0.11,
    },
    {
      attack: 0.004,
      delay: 0.145,
      duration: 0.22,
      endFrequency: 1108.73,
      frequencyRampDuration: 0.22,
      gain: 0.35,
      startFrequency: 1108.73,
      type: "sine",
      decayStart: 0.004,
      decayTimeConstant: 0.09,
    },
    {
      attack: 0.003,
      delay: 0.155,
      duration: 0.11,
      endFrequency: 1760,
      frequencyRampDuration: 0.11,
      gain: 0.12,
      startFrequency: 1760,
      type: "sine",
      decayStart: 0.003,
      decayTimeConstant: 0.035,
    },
  ],
  beacon: [
    {
      attack: 0.003,
      delay: 0,
      duration: 0.09,
      endFrequency: 1047,
      frequencyRampDuration: 0.09,
      gain: 1,
      startFrequency: 1047,
      type: "sine",
      decayStart: 0.003,
      decayTimeConstant: 0.045,
    },
    {
      attack: 0.003,
      delay: 0.26,
      duration: 0.09,
      endFrequency: 1047,
      frequencyRampDuration: 0.09,
      gain: 0.3,
      startFrequency: 1047,
      type: "sine",
      decayStart: 0.003,
      decayTimeConstant: 0.045,
    },
    {
      attack: 0.003,
      delay: 0.44,
      duration: 0.09,
      endFrequency: 1047,
      frequencyRampDuration: 0.09,
      gain: 0.12,
      startFrequency: 1047,
      type: "sine",
      decayStart: 0.003,
      decayTimeConstant: 0.045,
    },
  ],
};

async function renderChime(voices) {
  const sampleRate = 48000;
  const duration =
    voices.length === 0
      ? 0.02
      : Math.max(...voices.map((voice) => voice.delay + voice.duration)) +
        0.025;
  const context = new OfflineAudioContext(
    1,
    Math.ceil(duration * sampleRate),
    sampleRate,
  );
  const chimeStartsAt = 0.005;
  const SILENCE_GAIN = 0.0001;
  const master = context.createGain();
  master.gain.setValueAtTime(0.12, chimeStartsAt);
  master.connect(context.destination);
  voices.forEach((voice) => {
    const startsAt = chimeStartsAt + voice.delay;
    const endsAt = startsAt + voice.duration;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = voice.type;
    oscillator.frequency.setValueAtTime(voice.startFrequency, startsAt);
    voice.frequencyWaypoints?.forEach((waypoint) => {
      oscillator.frequency.exponentialRampToValueAtTime(
        waypoint.frequency,
        startsAt + waypoint.time,
      );
    });
    oscillator.frequency.exponentialRampToValueAtTime(
      voice.endFrequency,
      startsAt + voice.frequencyRampDuration,
    );
    gain.gain.setValueAtTime(SILENCE_GAIN, startsAt);
    if (
      voice.decayStart !== undefined &&
      voice.decayTimeConstant !== undefined
    ) {
      gain.gain.linearRampToValueAtTime(voice.gain, startsAt + voice.attack);
      gain.gain.setTargetAtTime(
        SILENCE_GAIN,
        startsAt + voice.decayStart,
        voice.decayTimeConstant,
      );
      gain.gain.exponentialRampToValueAtTime(SILENCE_GAIN, endsAt);
    } else {
      gain.gain.exponentialRampToValueAtTime(
        voice.gain,
        startsAt + voice.attack,
      );
      gain.gain.exponentialRampToValueAtTime(SILENCE_GAIN, endsAt);
    }
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(startsAt);
    oscillator.stop(endsAt + 0.02);
  });
  const audio = await context.startRendering();
  const samples = audio.getChannelData(0);
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, "RIFF"],
    [8, "WAVE"],
    [12, "fmt "],
    [36, "data"],
  ]) {
    for (let i = 0; i < text.length; i++)
      bytes[offset + i] = text.charCodeAt(i);
  }
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) =>
    view.setInt16(
      44 + i * 2,
      Math.round(Math.max(-1, Math.min(1, sample)) * 32767),
      true,
    ),
  );
  return Array.from(bytes);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  try {
    await window.loadURL(
      "data:text/html,<title>Offline chime renderer</title>",
    );
    const directory = path.join(__dirname, "../src/lib/notifications/chimes");
    mkdirSync(directory, { recursive: true });
    for (const [sound, voices] of Object.entries({
      ...CHIME_VOICES,
      silence: [],
    })) {
      const bytes = await window.webContents.executeJavaScript(
        `(${renderChime.toString()})(${JSON.stringify(voices)})`,
      );
      writeFileSync(path.join(directory, `${sound}.wav`), Buffer.from(bytes));
      console.log(`${sound}: ${bytes.length} bytes`);
    }
  } finally {
    app.quit();
  }
});
