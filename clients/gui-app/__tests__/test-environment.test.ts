import { expect, it } from "vitest";

it("keeps Vitest import mode defaults after the worker scrub", () => {
  expect(import.meta.env.MODE).toBe("test");
  expect(import.meta.env.DEV).toBe(true);
  expect(import.meta.env.PROD).toBe(false);
});
