import { describe, expect, it } from "vitest";

import { createOpaqueRedirectResponse } from "../opaque-redirect";

describe("createOpaqueRedirectResponse", () => {
  it("is a status-0, opaque-redirect, not-ok response", () => {
    const response = createOpaqueRedirectResponse();

    expect(response.status).toBe(0);
    expect(response.type).toBe("opaqueredirect");
    expect(response.ok).toBe(false);
  });
});
