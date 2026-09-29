import { describe, expect, it } from "vitest";
import { scanPackageJson, scanSource } from "../check-ui-migration.mjs";

// Contract for `scripts/check-ui-migration.mjs`, written ahead of the
// implementation (D17/T09): `scanSource(source, file)` returns one string
// per finding (empty when clean), and `scanPackageJson(json)` does the same
// over a parsed package.json. Every finding string is expected to name the
// file it came from, so a caller aggregating across files can report each
// hit without re-deriving context.

describe("scanSource - banned imports", () => {
  it("flags a static import of radix-ui", () => {
    const findings = scanSource(
      'import { Dialog } from "radix-ui";',
      "src/components/ui/dialog.tsx",
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join("\n")).toContain("src/components/ui/dialog.tsx");
  });

  it("flags a static import of a scoped @radix-ui/* package", () => {
    const findings = scanSource(
      'import * as Popover from "@radix-ui/react-popover";',
      "src/components/ui/popover.tsx",
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags a dynamic import()", () => {
    const findings = scanSource(
      'const mod = await import("@radix-ui/react-dialog");',
      "src/lib/lazy.ts",
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags a re-export", () => {
    const findings = scanSource(
      'export { Root, Trigger } from "vaul";',
      "src/components/ui/drawer.tsx",
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags a require() call", () => {
    const findings = scanSource(
      'const cmdk = require("cmdk");',
      "scripts/some-tool.cjs",
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it("does not flag an unrelated import", () => {
    const findings = scanSource(
      'import { useState } from "react";\nimport { cn } from "@/lib/utils";',
      "src/components/ui/button.tsx",
    );
    expect(findings).toEqual([]);
  });

  it("does not flag a package name that merely contains the substring, like a comment mentioning cmdk-adjacent tooling", () => {
    const findings = scanSource(
      'import { vendoredCommandScore } from "@/lib/command-score";',
      "src/lib/command-score.ts",
    );
    expect(findings).toEqual([]);
  });
});

describe("scanSource - legacy API scan", () => {
  it("flags a JSX asChild prop", () => {
    const findings = scanSource(
      "<DropdownMenuTrigger asChild><Button>Open</Button></DropdownMenuTrigger>",
      "src/components/example.tsx",
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags onSelect on a menu item", () => {
    const findings = scanSource(
      "<DropdownMenuItem onSelect={() => choose()}>Pick</DropdownMenuItem>",
      "src/components/example.tsx",
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags onSelect on an aliased menu item import", () => {
    const findings = scanSource(
      'import { DropdownMenuItem as Item } from "@/components/ui/dropdown-menu";\n<Item onSelect={() => choose()}>Pick</Item>',
      "src/components/example.tsx",
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it("does not flag onSelect on a non-menu element, like a text input's native selection event", () => {
    const findings = scanSource(
      "<input onSelect={(event) => trackSelection(event)} />",
      "src/components/text-field.tsx",
    );
    expect(findings).toEqual([]);
  });

  it("flags a legacy --radix- CSS variable in a class string", () => {
    const findings = scanSource(
      'className="w-[var(--radix-dropdown-menu-trigger-width)]"',
      "src/components/example.tsx",
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags Radix data-state values in a selector", () => {
    const findings = scanSource(
      "document.querySelector('[data-state=\"open\"]')",
      "src/components/example.tsx",
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags each Radix data-state value in the checked/unchecked/active/inactive family, in a selector string", () => {
    for (const value of [
      "open",
      "closed",
      "active",
      "inactive",
      "checked",
      "unchecked",
    ]) {
      const findings = scanSource(
        `document.querySelector(\`[data-state='${value}']\`);`,
        "src/components/__tests__/example.test.tsx",
      );
      expect(findings.length).toBeGreaterThan(0);
    }
  });

  it("flags a legacy state selector built from a ternary with literal Radix alternatives", () => {
    const findings = scanSource(
      'document.querySelector(`[data-state="${open ? "open" : "closed"}"]`)',
      "src/components/example.tsx",
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags a legacy state selector built from string concatenation", () => {
    const findings = scanSource(
      "document.querySelector('[data-state=\"' + \"open\" + '\"]')",
      "src/components/example.tsx",
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it("conservatively flags a data-state selector whose value cannot be resolved statically", () => {
    const findings = scanSource(
      'document.querySelector(`[data-state="${currentState}"]`)',
      "src/components/example.tsx",
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it("does not flag a composed data-state selector whose every literal branch is app-owned, not Radix's vocabulary", () => {
    const findings = scanSource(
      'document.querySelector(`[data-state="${bound ? "binding" : "unbound"}"]`)',
      "src/components/settings/panels/__tests__/host-port-forwards-card.test.tsx",
    );
    expect(findings).toEqual([]);
  });

  it("does not flag an app-owned data-state selector value outside the Radix vocabulary", () => {
    const findings = scanSource(
      "document.querySelector(`[data-state='binding']`);",
      "src/components/settings/panels/__tests__/host-port-forwards-card.test.tsx",
    );
    expect(findings).toEqual([]);
  });

  it("does not flag a plain JS attribute assertion, only selector/class strings", () => {
    const findings = scanSource(
      'expect(row.getAttribute("data-state")).toBe("active");',
      "src/components/settings/panels/__tests__/host-port-forwards-card.test.tsx",
    );
    expect(findings).toEqual([]);
  });

  it("exempts a vendored license header or history comment naming Radix", () => {
    const findings = scanSource(
      [
        "/**",
        " * Vendored from cmdk v1.1.1, cmdk/src/command-score.ts.",
        " * https://github.com/pacocoursey/cmdk/blob/v1.1.1/cmdk/src/command-score.ts",
        " */",
      ].join("\n"),
      "src/lib/command-score.ts",
    );
    expect(findings).toEqual([]);
  });

  it("exempts a plain history comment that only mentions Radix in prose", () => {
    const findings = scanSource(
      "// Radix's own Enter handling used to unmount the portal here; Base does the same.",
      "src/components/example.tsx",
    );
    expect(findings).toEqual([]);
  });
});

describe("scanPackageJson", () => {
  it("flags a radix-ui dependency", () => {
    const findings = scanPackageJson({
      name: "@traycer-clients/gui-app",
      dependencies: { "radix-ui": "1.0.0" },
    });
    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags a scoped @radix-ui/* devDependency", () => {
    const findings = scanPackageJson({
      name: "@traycer-clients/gui-app",
      devDependencies: { "@radix-ui/react-dialog": "1.0.0" },
    });
    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags vaul and cmdk in dependencies", () => {
    const findings = scanPackageJson({
      name: "@traycer-clients/gui-app",
      dependencies: { vaul: "1.0.0", cmdk: "1.0.0" },
    });
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it("flags an override/resolution pinning a Radix package", () => {
    const findings = scanPackageJson({
      name: "@traycer-clients/gui-app",
      overrides: { "@radix-ui/react-focus-scope": "1.2.3" },
    });
    expect(findings.length).toBeGreaterThan(0);
  });

  it("does not flag an exempt chain dependency like @lobehub/icons or @lobehub/ui", () => {
    const findings = scanPackageJson({
      name: "@traycer-clients/gui-app",
      dependencies: { "@lobehub/icons": "1.0.0", "@lobehub/ui": "1.0.0" },
    });
    expect(findings).toEqual([]);
  });

  it("returns no findings for a package.json with none of the retired packages", () => {
    const findings = scanPackageJson({
      name: "@traycer-clients/gui-app",
      dependencies: { react: "19.0.0", "@base-ui/react": "1.8.0" },
    });
    expect(findings).toEqual([]);
  });
});

describe("scanSource - CSS @import", () => {
  it("flags a bare @import of radix-ui's stylesheet", () => {
    const findings = scanSource(
      '@import "radix-ui/styles.css";',
      "src/index.css",
    );
    expect(findings.length).toBeGreaterThan(0);
  });
  it("flags a url(...) @import of a Radix package stylesheet", () => {
    const findings = scanSource(
      '@import url("@radix-ui/react-tooltip/dist/tooltip.css");',
      "src/index.css",
    );
    expect(findings.length).toBeGreaterThan(0);
  });
});
describe("scanSource - TS type-only import", () => {
  it("flags a type-only inline import of a Radix package", () => {
    const findings = scanSource(
      'type Props = import("@radix-ui/react-dialog").DialogProps;',
      "src/components/ui/dialog.tsx",
    );
    expect(findings.length).toBeGreaterThan(0);
  });
  it("flags a top-level import type of a Radix package", () => {
    const findings = scanSource(
      'import type { DialogProps } from "@radix-ui/react-dialog";',
      "src/components/ui/dialog.tsx",
    );
    expect(findings.length).toBeGreaterThan(0);
  });
});
describe("scanPackageJson - wildcard resolutions/overrides", () => {
  it("flags a retired package keyed by a wildcard resolution path", () => {
    const findings = scanPackageJson({
      name: "@traycer-clients/gui-app",
      resolutions: { "**/cmdk": "1.1.1" },
    });
    expect(findings.length).toBeGreaterThan(0);
  });
  it("flags a retired package keyed by a wildcard override path", () => {
    const findings = scanPackageJson({
      name: "@traycer-clients/gui-app",
      overrides: { "**/some-dep/vaul": "1.0.0" },
    });
    expect(findings.length).toBeGreaterThan(0);
  });
});
