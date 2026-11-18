import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST_START_ORIGIN,
  HOST_START_ORIGINS,
  hostStartOriginFromOption,
  parseHostStartOrigin,
} from "../lifecycle-origin";

describe("parseHostStartOrigin", () => {
  it.each(HOST_START_ORIGINS)("round-trips the valid value %s", (origin) => {
    expect(parseHostStartOrigin(origin)).toBe(origin);
  });

  it.each([undefined, null, 0, 1, NaN, "bogus", "", "Desktop", " terminal"])(
    "returns null for %p",
    (value) => {
      expect(parseHostStartOrigin(value)).toBeNull();
    },
  );
});

describe("hostStartOriginFromOption", () => {
  it.each(HOST_START_ORIGINS)(
    "passes a valid value %s through unchanged",
    (origin) => {
      expect(hostStartOriginFromOption(origin)).toBe(origin);
    },
  );

  it.each([undefined, null, 0, "bogus", ""])(
    "falls back to DEFAULT_HOST_START_ORIGIN for %p",
    (value) => {
      expect(hostStartOriginFromOption(value)).toBe(DEFAULT_HOST_START_ORIGIN);
    },
  );

  it("DEFAULT_HOST_START_ORIGIN is 'terminal'", () => {
    expect(DEFAULT_HOST_START_ORIGIN).toBe("terminal");
  });
});
