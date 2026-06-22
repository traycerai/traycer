import { describe, expect, it } from "vitest";
import { serviceLabelFor, windowsTaskName } from "../label";

describe("serviceLabelFor", () => {
  it("uses the production service label for production", () => {
    const label = serviceLabelFor("production");

    expect(label).toEqual({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment: "production",
    });
    expect(windowsTaskName(label)).toBe("\\Traycer\\Host");
  });

  it("shares the non-production service label while preserving the runtime environment", () => {
    const label = serviceLabelFor("staging");

    expect(label).toEqual({
      id: "ai.traycer.host.dev",
      displayName: "Traycer Host (Dev)",
      environment: "staging",
    });
    expect(windowsTaskName(label)).toBe("\\Traycer\\Host-Dev");
  });
});
