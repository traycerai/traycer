/** A bot's colour as it is saved: `#rrggbb`, lowercase. */
export const BOT_COLOR_HEX_PATTERN = /^#[0-9a-f]{6}$/;

/**
 * Whether `value` is a saved bot colour. A response at an equal method
 * version reaches a reader unparsed, so a reader checks before drawing.
 */
export function isBotColorHex(value: unknown): value is string {
  return typeof value === "string" && BOT_COLOR_HEX_PATTERN.test(value);
}

/**
 * The colours a bot's settings offer and a new bot is given one of. A bot
 * saves the colour itself, never its place here, so this list can change
 * without recolouring a bot.
 */
export const BOT_COLOR_LINE_UP = [
  { name: "Red", hex: "#f04c4c" },
  { name: "Orange", hex: "#f08f4c" },
  { name: "Amber", hex: "#f0b34c" },
  { name: "Emerald", hex: "#4df0ba" },
  { name: "Cyan", hex: "#4cd8f0" },
  { name: "Blue", hex: "#4c8af0" },
  { name: "Violet", hex: "#7e4cf0" },
  { name: "Pink", hex: "#ed4f9d" },
  { name: "Teal", hex: "#93bdc8" },
] as const;

/** The colour a bot without one is drawn in, and a personal assistant is created with. */
export const BOT_DEFAULT_COLOR: string = BOT_COLOR_LINE_UP[8].hex;

/**
 * The colour a new bot is created with: one of {@link BOT_COLOR_LINE_UP},
 * picked by FNV-1a (32-bit) over the create's request key, so a repeated
 * create picks the same one. It selects a colour and identifies nothing: two
 * keys often share one.
 */
export function botCreationColor(requestKey: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(requestKey)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return BOT_COLOR_LINE_UP[(hash >>> 0) % BOT_COLOR_LINE_UP.length].hex;
}
