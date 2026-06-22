import { describe, expect, it } from "vitest";
import { createAppRouter } from "@/router";

describe("createAppRouter", () => {
  it("boots from the desktop initial route without relying on the URL hash", () => {
    const router = createAppRouter("/epics/epic-a", null);

    expect(router.state.location.pathname).toBe("/epics/epic-a");
  });
});
