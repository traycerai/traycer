/**
 * Deterministic per-agent looks for the office view.
 *
 * The same agent must render identically in every window, on every device and
 * across restarts, so nothing here is stored: an appearance is a pure function
 * of the agent id (plus its kind, which salts the hash) and its harness.
 */
import type { GuiHarnessId } from "@traycer/protocol/persistence/epic/foundation";
import type { CommGraphAgentKind } from "@/lib/comm-graph/comm-graph-model";
import type { OfficeAppearance } from "@/lib/comm-graph/office/office-types";

/**
 * Brand tint per harness. Drives the envelope color of a message that agent
 * sends and the accent stripe on its desk.
 *
 * Every harness the app can run needs an entry, so the record is keyed by the
 * whole enum rather than by the subset that happens to be on a floor: a missing
 * key would resolve to `undefined` and paint an agent's envelopes with nothing
 * at all. A brand whose own mark is near-black is deliberately lightened here -
 * the accent is drawn on a dark floor and an unreadable tint is not a brand.
 */
export const HARNESS_ACCENT: Readonly<Record<GuiHarnessId, string>> = {
  claude: "#d97757",
  codex: "#10a37f",
  opencode: "#f5a524",
  traycer: "#3b82f6",
  cursor: "#7c7cff",
  grok: "#6b7280",
  qwen: "#6f42c1",
  kiro: "#a855f7",
  droid: "#f97316",
  kimi: "#1f6feb",
  copilot: "#8957e5",
  kilocode: "#22c55e",
  openrouter: "#6366f1",
  amp: "#e11d48",
  devin: "#0ea5e9",
  pi: "#14b8a6",
  hermes: "#eab308",
  omp: "#ef4444",
  huggingface: "#facc15",
  reasonix: "#0891b2",
};

/** A chat has no harness, so it carries the app's own accent instead. */
export const OFFICE_CHAT_ACCENT = "#3b82f6";

const SKIN_TONES: ReadonlyArray<string> = [
  "#f5d3ba",
  "#e8b894",
  "#d09a6e",
  "#a9714b",
  "#7a4a2e",
  "#4e2f1c",
];

const HAIR_COLORS: ReadonlyArray<string> = [
  "#2b2118",
  "#4a3223",
  "#7a4b28",
  "#a9673a",
  "#c98f4b",
  "#e0c078",
  "#8d8d95",
  "#d8d8de",
  "#6b3f6e",
  "#3b5f8a",
];

/**
 * Shirt colors deliberately skip the greens and sages the floor and wall
 * palettes occupy, so a seated character never dissolves into the room.
 */
const SHIRT_COLORS: ReadonlyArray<string> = [
  "#3b6fd6",
  "#5a8de8",
  "#d64c3b",
  "#e0705a",
  "#b5478f",
  "#7c5cd6",
  "#2f9bb5",
  "#e0a33b",
  "#c9603f",
  "#4b4f6b",
  "#d9d3c4",
  "#9b3b52",
];

const PANTS_COLORS: ReadonlyArray<string> = [
  "#3a4055",
  "#4d4238",
  "#2f3a44",
  "#6b6558",
];

const HAIR_STYLES: ReadonlyArray<0 | 1 | 2 | 3> = [0, 1, 2, 3];

/** FNV-1a, 32-bit. Stable across engines because every step stays in uint32. */
export function hashAgentId(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Decorrelates one hash into independent draws. Without it, consecutive ids
 * would pick neighbouring entries in every list at once and a floor of agents
 * created back to back would read as a uniform.
 */
function mix(seed: number, salt: number): number {
  let hash = (seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

function pickColor(list: ReadonlyArray<string>, seed: number): string {
  return list[seed % list.length];
}

/**
 * The look of one agent. `kind` salts the hash rather than selecting anything:
 * two agents that happen to share an id prefix should still differ, and the
 * accent is the only field the caller's metadata decides outright.
 */
export function agentAppearance(
  agentId: string,
  kind: CommGraphAgentKind,
  harnessId: GuiHarnessId | null,
): OfficeAppearance {
  const seed = hashAgentId(`${kind}:${agentId}`);
  return {
    skin: pickColor(SKIN_TONES, mix(seed, 1)),
    hair: pickColor(HAIR_COLORS, mix(seed, 2)),
    hairStyle: HAIR_STYLES[mix(seed, 3) % HAIR_STYLES.length],
    shirt: pickColor(SHIRT_COLORS, mix(seed, 4)),
    pants: pickColor(PANTS_COLORS, mix(seed, 5)),
    accent: harnessId === null ? OFFICE_CHAT_ACCENT : HARNESS_ACCENT[harnessId],
  };
}
