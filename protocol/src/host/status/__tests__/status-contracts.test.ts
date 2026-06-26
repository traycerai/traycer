import { describe, expect, it } from "vitest";
import { placeholderDiagnosticsStatus } from "@traycer/protocol/config/diagnostics-schema";
import { diagnosticsStatusSchema } from "../contracts";

describe("host status contracts", () => {
  it("keeps the diagnostics status schema aligned with the shared placeholder", () => {
    const status = placeholderDiagnosticsStatus({
      supported: false,
      source: "unsupported",
      readStatus: null,
      configPath: "",
      configMtimeMs: null,
      hostVersion: "1.2.3",
      activeSlot: null,
      logPath: null,
    });

    expect(diagnosticsStatusSchema.parse(status)).toEqual(status);
  });
});
