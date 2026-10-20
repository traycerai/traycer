import { describe, expect, it } from "vitest";
import {
  ViewReplicaService,
  type ViewReplicaLocalContribution,
} from "@traycer-clients/shared/view-replica/service";
import { ACCOUNT_ROW_SCOPE } from "@traycer-clients/shared/view-replica/row-scope";

type Page = readonly string[];

function createService(): ViewReplicaService<Page> {
  return new ViewReplicaService<Page>({
    service: "test.list",
    canonicalVersion: "1.0",
    split: (page) => ({
      shell: null,
      rows: page.map((value) => ({ scope: ACCOUNT_ROW_SCOPE, value })),
    }),
    join: (_shell, rows) =>
      rows.filter((row): row is string => typeof row === "string"),
    asCached: (page) => page,
  });
}

const withLocalRow: ViewReplicaLocalContribution<Page> = {
  apply: (page) => [...page, "local"],
};

describe("ViewReplicaService paint gate", () => {
  it("paints the cached page as it is when no contribution is registered", () => {
    const service = createService();

    expect(service.paintableFrom(service.admitFirstPaint(["cached"]))).toEqual([
      "cached",
    ]);
  });

  it("paints the page with the registered contribution applied", () => {
    const service = createService();
    service.registerLocalContribution(withLocalRow);

    expect(service.paintableFrom(service.admitFirstPaint(["cached"]))).toEqual([
      "cached",
      "local",
    ]);
  });

  it("refuses a paint admitted before a contribution was registered", () => {
    const service = createService();
    const admission = service.admitFirstPaint(["cached"]);

    service.registerLocalContribution(withLocalRow);

    expect(service.paintableFrom(admission)).toBeNull();
  });

  it("refuses a paint admitted under a registration that has since been removed", () => {
    const service = createService();
    const registration = service.registerLocalContribution(withLocalRow);
    const admission = service.admitFirstPaint(["cached"]);
    expect(service.paintableFrom(admission)).not.toBeNull();

    registration.unregister();

    expect(service.paintableFrom(admission)).toBeNull();
  });

  it("refuses a page whose contribution is not yet available", () => {
    const service = createService();
    service.registerLocalContribution({ apply: () => null });

    const admission = service.admitFirstPaint(["cached"]);

    expect(admission).toEqual({
      admitted: false,
      reason: "contribution-unavailable",
    });
    expect(service.paintableFrom(admission)).toBeNull();
  });

  it("throws when a second contribution is registered", () => {
    const service = createService();
    service.registerLocalContribution(withLocalRow);

    expect(() => service.registerLocalContribution(withLocalRow)).toThrow(
      /already has a local contribution/,
    );
  });

  it("notifies subscribers when the registration changes", () => {
    const service = createService();
    let notified = 0;
    service.subscribe(() => {
      notified += 1;
    });

    const registration = service.registerLocalContribution(withLocalRow);
    registration.changed();
    registration.unregister();

    expect(notified).toBe(3);
  });
});
