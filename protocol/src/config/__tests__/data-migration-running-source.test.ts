import { describe, expect, it } from "vitest";
import {
  maintenanceBlockerSchema,
  maintenanceErrorCodeSchema,
} from "../data-migration-contracts";

describe("maintenance `running-source` code", () => {
  it("maintenanceErrorCodeSchema accepts running-source and the neighbouring codes", () => {
    for (const code of [
      "running-source",
      "busy-source",
      "unauthorized",
      "protocol-mismatch",
      "unsupported-format",
      "integrity-mismatch",
    ]) {
      expect(maintenanceErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it("maintenanceErrorCodeSchema still rejects unknown codes", () => {
    for (const code of [
      "running",
      "running_source",
      "RUNNING-SOURCE",
      "",
      "stopped-source",
    ]) {
      expect(maintenanceErrorCodeSchema.safeParse(code).success).toBe(false);
    }
    expect(maintenanceErrorCodeSchema.safeParse(1).success).toBe(false);
    expect(maintenanceErrorCodeSchema.safeParse(null).success).toBe(false);
  });

  it("maintenanceBlockerSchema accepts a running-source blocker", () => {
    const parsed = maintenanceBlockerSchema.safeParse({
      code: "running-source",
      storeKey: "host/host-id",
      message: "a host is running",
    });
    expect(parsed.success).toBe(true);
  });

  it("maintenanceBlockerSchema rejects an unknown code and extra fields", () => {
    expect(
      maintenanceBlockerSchema.safeParse({
        code: "bogus",
        storeKey: null,
        message: "x",
      }).success,
    ).toBe(false);
    expect(
      maintenanceBlockerSchema.safeParse({
        code: "running-source",
        storeKey: null,
        message: "x",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
