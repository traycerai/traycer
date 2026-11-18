import { describe, expect, it } from "vitest";
import type {
  CheckpointArtifactTag,
  CheckpointFileOperation,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import {
  distinctArtifactCount,
  groupArtifactFolderChanges,
} from "@/lib/chat/artifact-folder-bundles";

interface Change {
  readonly filePath: string;
  readonly operation: CheckpointFileOperation;
  readonly artifact: CheckpointArtifactTag | null;
}

function change(
  filePath: string,
  operation: CheckpointFileOperation,
  artifact: CheckpointArtifactTag | null,
): Change {
  return { filePath, operation, artifact };
}

function tag(
  artifactId: string | null,
  kind: CheckpointArtifactTag["kind"],
): CheckpointArtifactTag {
  return { artifactId, kind, title: `Title ${artifactId ?? "unresolved"}` };
}

function group(items: ReadonlyArray<Change>) {
  return groupArtifactFolderChanges(items, (item) => item.artifact);
}

function onlyBundle(items: ReadonlyArray<Change>) {
  const [grouping] = group(items);
  if (grouping.kind !== "bundle") throw new Error("expected a bundle");
  return grouping;
}

describe("groupArtifactFolderChanges", () => {
  it("collapses an artifact's files at its first item and passes every other item through in place", () => {
    const markdown = change("/r/a/index.md", "edit", tag("md-1", "spec"));
    const loosePdf = change("/r/doc.pdf", "edit", tag("f-1", "file"));
    const plain = change("/r/src/app.ts", "edit", null);
    const unresolvedKind = change("/r/b/x.html", "edit", tag("h-9", null));
    const unresolvedId = change("/r/c/x.html", "edit", tag(null, "html"));
    const first = change("/r/page/index.html", "edit", tag("h-1", "html"));
    const second = change("/r/page/app.css", "edit", tag("h-1", "html"));

    const groupings = group([
      markdown,
      first,
      loosePdf,
      plain,
      unresolvedKind,
      second,
      unresolvedId,
    ]);

    expect(
      groupings.map((grouping) =>
        grouping.kind === "bundle" ? grouping.artifactId : grouping.item,
      ),
    ).toEqual([markdown, "h-1", loosePdf, plain, unresolvedKind, unresolvedId]);
  });

  it.each([
    {
      paths: ["/r/b/cart.html", "/r/b/payment.html"],
      labels: ["cart.html", "payment.html"],
    },
    {
      paths: ["/r/p/index.html", "/r/p/assets/app.css"],
      labels: ["index.html", "assets/app.css"],
    },
    { paths: ["/r/p/assets/app.css"], labels: ["app.css"] },
    {
      paths: ["C:\\r\\p\\index.html", "C:\\r\\p\\assets\\app.css"],
      labels: ["index.html", "assets/app.css"],
    },
  ])(
    "labels $paths relative to their common directory",
    ({ paths, labels }) => {
      const bundle = onlyBundle(
        paths.map((path) => change(path, "edit", tag("h-1", "html"))),
      );

      expect(bundle.members.map((member) => member.label)).toEqual(labels);
    },
  );

  it.each([
    { name: "created lead", lead: "create", expected: "create" },
    { name: "deleted lead", lead: "delete", expected: "delete" },
    { name: "edited lead", lead: "edit", expected: "edit" },
  ] as const)("a $name makes the bundle $expected", ({ lead, expected }) => {
    const bundle = onlyBundle([
      change("/r/p/index.html", lead, tag("h-1", "html")),
      change("/r/p/app.css", "edit", tag("h-1", "html")),
    ]);

    expect(bundle.operation).toBe(expected);
  });

  it("keeps a created non-lead file in an existing artifact as an edit", () => {
    const bundle = onlyBundle([
      change("/r/p/app.css", "create", tag("h-1", "html")),
      change("/r/p/other.css", "edit", tag("h-1", "html")),
    ]);

    expect(bundle.operation).toBe("edit");
  });

  it("reads a canvas artifact's lead file as canvas.json", () => {
    const bundle = onlyBundle([
      change("/r/c/canvas.json", "create", tag("c-1", "canvas")),
      change("/r/c/notes.md", "create", tag("c-1", "canvas")),
    ]);

    expect(bundle.operation).toBe("create");
  });
});

describe("distinctArtifactCount", () => {
  it("counts the files of one artifact once", () => {
    expect(
      distinctArtifactCount([
        change("/r/p/index.html", "edit", tag("h-1", "html")),
        change("/r/p/app.css", "edit", tag("h-1", "html")),
        change("/r/p/app.js", "edit", tag("h-1", "html")),
        change("/r/a/index.md", "edit", tag("md-1", "spec")),
      ]),
    ).toBe(2);
  });

  it("counts an unresolved entry by path, or under the id another entry resolved for that path", () => {
    expect(
      distinctArtifactCount([
        change("/r/p/index.html", "edit", tag(null, "html")),
        change("/r/q/index.html", "edit", tag(null, "html")),
      ]),
    ).toBe(2);
    expect(
      distinctArtifactCount([
        change("/r/p/index.html", "edit", tag(null, "html")),
        change("/r/p/index.html", "edit", tag("h-1", "html")),
        change("/r/p/app.css", "edit", tag("h-1", "html")),
      ]),
    ).toBe(1);
  });
});
