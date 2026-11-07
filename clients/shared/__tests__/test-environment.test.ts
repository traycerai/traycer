import { expect, it } from "vitest";

it("keeps the literal OSS repository import environment after the scrub", () => {
  expect(process.env.MODE).toBe("test");
  expect(import.meta.env.VITE_TRAYCER_OSS_REPO).toBe(
    "https://github.com/traycerai/traycer",
  );
});
