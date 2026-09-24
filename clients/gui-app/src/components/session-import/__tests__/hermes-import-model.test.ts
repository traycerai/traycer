/**
 * Pure-state coverage for the Hermes import model: default selection
 * (bundled skills unticked, everything else ticked, unreadable rows never
 * selectable), the counts and summary sentence built from a selection, the
 * request `hermesRunRequest` builds for the wire, and the submittable gate.
 */
import { describe, expect, it } from "vitest";
import type { AgentIdentityHermesScanItem } from "@traycer/protocol/host/agent-identity/unary-schemas";
import {
  countHermesSelection,
  defaultHermesIdentityTitle,
  defaultHermesSelection,
  hermesImportSummary,
  hermesRunRequest,
  hermesRunSubmittable,
  hermesTargetMemoryForScan,
  hermesTargetOfKind,
  rememberHermesTarget,
  type HermesImportTarget,
} from "@/components/session-import/hermes-import-model";

const SOUL: AgentIdentityHermesScanItem = { kind: "soul", characters: 120 };
const MEMORY_MAIN: AgentIdentityHermesScanItem = {
  kind: "memory",
  relPath: "memories/MEMORY.md",
  entries: 3,
};
const MEMORY_USER: AgentIdentityHermesScanItem = {
  kind: "memory",
  relPath: "memories/USER.md",
  entries: 1,
};
const SKILL_BUNDLED: AgentIdentityHermesScanItem = {
  kind: "skill",
  name: "Bundled Skill",
  relPath: "skills/bundled/SKILL.md",
  description: "Shipped with Hermes",
  bundled: true,
};
const SKILL_USER: AgentIdentityHermesScanItem = {
  kind: "skill",
  name: "User Skill",
  relPath: "skills/custom/SKILL.md",
  description: null,
  bundled: false,
};
const UNREADABLE: AgentIdentityHermesScanItem = {
  kind: "unreadable",
  relPath: "skills/broken/SKILL.md",
  reason: "source_unreadable",
  detail: "Permission denied",
};

const ALL_ITEMS: readonly AgentIdentityHermesScanItem[] = [
  SOUL,
  MEMORY_MAIN,
  MEMORY_USER,
  SKILL_BUNDLED,
  SKILL_USER,
  UNREADABLE,
];

function newTarget(title: string): HermesImportTarget {
  return { kind: "new", title };
}

function existingTarget(identityId: string): HermesImportTarget {
  return { kind: "existing", identityId };
}

describe("defaultHermesSelection", () => {
  it("ticks the soul and memory files, unticks a bundled skill, ticks a non-bundled skill, and never ticks an unreadable row", () => {
    const selection = defaultHermesSelection(ALL_ITEMS);

    expect(selection.has("SOUL.md")).toBe(true);
    expect(selection.has("memories/MEMORY.md")).toBe(true);
    expect(selection.has("memories/USER.md")).toBe(true);
    expect(selection.has("skills/bundled/SKILL.md")).toBe(false);
    expect(selection.has("skills/custom/SKILL.md")).toBe(true);
    expect(selection.has("skills/broken/SKILL.md")).toBe(false);
    expect(selection.size).toBe(4);
  });

  it("returns an empty selection for an empty scan", () => {
    expect(defaultHermesSelection([]).size).toBe(0);
  });
});

describe("countHermesSelection", () => {
  it("counts only the selected rows, splitting bundled skills out of the skill total", () => {
    const selected = defaultHermesSelection(ALL_ITEMS);

    expect(countHermesSelection(ALL_ITEMS, selected)).toEqual({
      soul: true,
      memories: 2,
      skills: 1,
      bundledSkills: 0,
    });
  });

  it("counts a ticked bundled skill in both skills and bundledSkills", () => {
    const selected = new Set([
      "SOUL.md",
      "skills/bundled/SKILL.md",
      "skills/custom/SKILL.md",
    ]);

    expect(countHermesSelection(ALL_ITEMS, selected)).toEqual({
      soul: true,
      memories: 0,
      skills: 2,
      bundledSkills: 1,
    });
  });

  it("returns all-zero/false counts for an empty selection", () => {
    expect(countHermesSelection(ALL_ITEMS, new Set())).toEqual({
      soul: false,
      memories: 0,
      skills: 0,
      bundledSkills: 0,
    });
  });

  it("ignores an unreadable row even if its relPath is somehow in the selection", () => {
    const selected = new Set(["skills/broken/SKILL.md"]);

    expect(countHermesSelection(ALL_ITEMS, selected)).toEqual({
      soul: false,
      memories: 0,
      skills: 0,
      bundledSkills: 0,
    });
  });
});

describe("hermesImportSummary", () => {
  it("names the soul, memory files and skills (with a bundled count) into a new identity", () => {
    const selected = defaultHermesSelection(ALL_ITEMS);
    const counts = countHermesSelection(ALL_ITEMS, selected);
    // Tick the bundled skill too, so the bundled-count clause is exercised.
    const countsWithBundled = countHermesSelection(
      ALL_ITEMS,
      new Set([...selected, "skills/bundled/SKILL.md"]),
    );

    expect(hermesImportSummary(counts, newTarget("Hermes"), null)).toBe(
      "Import the soul, 2 memory files and 1 skill into a new identity “Hermes”.",
    );
    expect(
      hermesImportSummary(countsWithBundled, newTarget("Hermes"), null),
    ).toBe(
      "Import the soul, 2 memory files and 2 skills (1 bundled) into a new identity “Hermes”.",
    );
  });

  it("trims the new identity's title in the sentence", () => {
    const counts = { soul: true, memories: 0, skills: 0, bundledSkills: 0 };

    expect(hermesImportSummary(counts, newTarget("  Hermes  "), null)).toBe(
      "Import the soul into a new identity “Hermes”.",
    );
  });

  it("names the existing identity's title, falling back to a generic phrase when it is unknown", () => {
    const counts = { soul: true, memories: 0, skills: 0, bundledSkills: 0 };

    expect(
      hermesImportSummary(counts, existingTarget("identity-1"), "Research"),
    ).toBe("Import the soul into “Research”.");
    expect(
      hermesImportSummary(counts, existingTarget("identity-1"), null),
    ).toBe("Import the soul into “the selected identity”.");
  });

  it("reports nothing selected regardless of target", () => {
    const counts = { soul: false, memories: 0, skills: 0, bundledSkills: 0 };

    expect(hermesImportSummary(counts, newTarget("Hermes"), null)).toBe(
      "Nothing selected to import.",
    );
    expect(
      hermesImportSummary(counts, existingTarget("identity-1"), "Research"),
    ).toBe("Nothing selected to import.");
  });

  it("joins a single memory file singular and a single skill singular", () => {
    const counts = { soul: false, memories: 1, skills: 1, bundledSkills: 0 };

    expect(hermesImportSummary(counts, newTarget("Hermes"), null)).toBe(
      "Import 1 memory file and 1 skill into a new identity “Hermes”.",
    );
  });
});

describe("defaultHermesIdentityTitle", () => {
  it("names the profile when one is known, else a generic title", () => {
    expect(defaultHermesIdentityTitle("acme")).toBe("Hermes (acme)");
    expect(defaultHermesIdentityTitle(null)).toBe("Hermes identity");
  });
});

describe("hermesRunRequest", () => {
  it("builds selectedRelPaths in scan order, restricted to the selected items", () => {
    const selected = new Set([
      "skills/custom/SKILL.md",
      "SOUL.md",
      "memories/USER.md",
    ]);

    const request = hermesRunRequest({
      directory: "~/.hermes",
      items: ALL_ITEMS,
      selected,
      target: newTarget("Hermes"),
    });

    // Scan order is SOUL, MEMORY_MAIN, MEMORY_USER, SKILL_BUNDLED, SKILL_USER,
    // UNREADABLE - the selected subset must preserve that order, not the
    // insertion order of the Set.
    expect(request.selectedRelPaths).toEqual([
      "SOUL.md",
      "memories/USER.md",
      "skills/custom/SKILL.md",
    ]);
  });

  it("never includes an unreadable item even if its relPath were selected", () => {
    const request = hermesRunRequest({
      directory: "~/.hermes",
      items: ALL_ITEMS,
      selected: new Set(["skills/broken/SKILL.md", "SOUL.md"]),
      target: newTarget("Hermes"),
    });

    expect(request.selectedRelPaths).toEqual(["SOUL.md"]);
  });

  it("carries identityId null and a trimmed title for a new target", () => {
    const request = hermesRunRequest({
      directory: "~/.hermes",
      items: ALL_ITEMS,
      selected: new Set(["SOUL.md"]),
      target: newTarget("  My Hermes  "),
    });

    expect(request.identityId).toBeNull();
    expect(request.title).toBe("My Hermes");
  });

  it("carries a null title for a new target whose name is blank", () => {
    const request = hermesRunRequest({
      directory: "~/.hermes",
      items: ALL_ITEMS,
      selected: new Set(["SOUL.md"]),
      target: newTarget("   "),
    });

    expect(request.identityId).toBeNull();
    expect(request.title).toBeNull();
  });

  it("carries the identityId and a null title for an existing target", () => {
    const request = hermesRunRequest({
      directory: "~/.hermes",
      items: ALL_ITEMS,
      selected: new Set(["SOUL.md"]),
      target: existingTarget("identity-1"),
    });

    expect(request.identityId).toBe("identity-1");
    expect(request.title).toBeNull();
  });

  it("carries the scanned directory through untouched", () => {
    const request = hermesRunRequest({
      directory: "~/.hermes/profiles/acme",
      items: ALL_ITEMS,
      selected: new Set(["SOUL.md"]),
      target: newTarget("Hermes"),
    });

    expect(request.directory).toBe("~/.hermes/profiles/acme");
  });
});

describe("target memory", () => {
  it("starts a scan with the profile's default title and no picked identity", () => {
    expect(hermesTargetMemoryForScan("acme")).toEqual({
      title: "Hermes (acme)",
      identityId: "",
    });
    expect(hermesTargetMemoryForScan(null)).toEqual({
      title: "Hermes identity",
      identityId: "",
    });
  });

  it("remembers each kind's last value independently, and a radio flip restores it", () => {
    let memory = hermesTargetMemoryForScan("acme");
    memory = rememberHermesTarget(memory, existingTarget("identity-b"));
    memory = rememberHermesTarget(memory, newTarget("Typed"));
    expect(memory).toEqual({ title: "Typed", identityId: "identity-b" });

    expect(hermesTargetOfKind("existing", memory)).toEqual(
      existingTarget("identity-b"),
    );
    expect(hermesTargetOfKind("new", memory)).toEqual(newTarget("Typed"));
  });

  it("a fresh scan's memory carries nothing over: the existing pick is unset again", () => {
    const before = rememberHermesTarget(
      hermesTargetMemoryForScan("acme"),
      existingTarget("identity-b"),
    );
    expect(hermesTargetOfKind("existing", before).kind).toBe("existing");

    const after = hermesTargetMemoryForScan("other");
    expect(hermesTargetOfKind("existing", after)).toEqual(existingTarget(""));
    expect(hermesTargetOfKind("new", after)).toEqual(
      newTarget("Hermes (other)"),
    );
  });
});

describe("hermesRunSubmittable", () => {
  it("is false when nothing is selected, regardless of target", () => {
    expect(hermesRunSubmittable(new Set(), newTarget("Hermes"))).toBe(false);
    expect(hermesRunSubmittable(new Set(), existingTarget("identity-1"))).toBe(
      false,
    );
  });

  it("requires a non-blank title for a new target", () => {
    const selected = new Set(["SOUL.md"]);

    expect(hermesRunSubmittable(selected, newTarget("   "))).toBe(false);
    expect(hermesRunSubmittable(selected, newTarget(""))).toBe(false);
    expect(hermesRunSubmittable(selected, newTarget("Hermes"))).toBe(true);
  });

  it("requires a non-empty identityId for an existing target", () => {
    const selected = new Set(["SOUL.md"]);

    expect(hermesRunSubmittable(selected, existingTarget(""))).toBe(false);
    expect(hermesRunSubmittable(selected, existingTarget("identity-1"))).toBe(
      true,
    );
  });
});
