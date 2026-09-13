import { describe, expect, it } from "vitest";
import { hostUsageSummaryDowngradeV20ToV10 } from "@traycer/protocol/host/usage-analytics/contracts";
import {
  hostUsageSummaryRequestSchema,
  hostUsageSummaryRequestSchemaV10,
} from "@traycer/protocol/host/usage-analytics/schemas";

const VALID_REQUEST = {
  timezone: "UTC",
  windowDays: 7,
  epicId: null as string | null,
};

describe("host.usage.summary request compatibility", () => {
  it("has a valid v1 request fixture before proving v1 rejects the local-only selector", () => {
    const withoutPlane =
      hostUsageSummaryRequestSchemaV10.safeParse(VALID_REQUEST);
    const withPlane = hostUsageSummaryRequestSchemaV10.safeParse({
      ...VALID_REQUEST,
      plane: "local-only",
    });

    expect(withoutPlane.success).toBe(true);
    expect(withPlane.success).toBe(false);
  });

  it("refuses a 2-to-1 downgrade when the request carries local-only plane", () => {
    const request = hostUsageSummaryRequestSchema.parse({
      ...VALID_REQUEST,
      plane: "local-only",
    });

    expect(hostUsageSummaryDowngradeV20ToV10.downgradeRequest(request)).toEqual(
      {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "The local-only usage plane selector has no representation in host.usage.summary@1.0",
        },
      },
    );
  });

  it("downgrades a selector-free 2.0 request field-for-field without inventing a plane key", () => {
    const request = hostUsageSummaryRequestSchema.parse(VALID_REQUEST);
    const downgraded =
      hostUsageSummaryDowngradeV20ToV10.downgradeRequest(request);

    expect(downgraded).toEqual({ ok: true, value: request });
    if (!downgraded.ok) throw new Error("Expected selector-free downgrade");
    expect(Object.hasOwn(downgraded.value, "plane")).toBe(false);
    expect(downgraded.value).toEqual(request);
  });
});
