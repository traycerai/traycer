import { describe, expect, it } from "vitest";

import { createOpaqueRedirectResponse } from "../opaque-redirect";

/**
 * Pins the fixture to what a browser hands back for a redirect it was told not
 * to follow, so a site that reads `ok` before `status` sees a failure, as it
 * would in the app.
 */
describe("createOpaqueRedirectResponse", () => {
  it("is a status-0, opaque-redirect, not-ok response", () => {
    const response = createOpaqueRedirectResponse();

    expect(response.status).toBe(0);
    expect(response.type).toBe("opaqueredirect");
    expect(response.ok).toBe(false);
  });
});
