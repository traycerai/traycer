/**
 * `DiffContentFrame` is the shared host boundary behind every editable Diffs
 * surface (workspace file, single Git diff, bundle section). Before this,
 * only the bundle section's own outer wrapper (`DiffBundleFileSectionFrame`)
 * stamped `data-diff-find-file`/`data-bundle-diff-file-id` - a single-file
 * Git or workspace host carried only the generic `data-diffs-host` marker,
 * so neither automation nor the app's own find/focus/ownership logic could
 * bind to it unambiguously. This suite proves the shared `fileIdentity` prop
 * closes that gap and maps every host one-to-one, including a host an LRU
 * keep-alive tab hides (via CSS) rather than unmounts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DiffContentFrame } from "@/components/diff/diff-content-primitive";

afterEach(() => {
  cleanup();
});

describe("DiffContentFrame file identity", () => {
  it("stamps data-diff-find-file and data-bundle-diff-file-id for a visible single untracked host", () => {
    const { container } = render(
      <DiffContentFrame
        sizing="fill"
        banner={null}
        scrollContainerRef={null}
        onScroll={null}
        fileIdentity={{
          findFilePath: "e2e-diff-edit-fixtures/new-file.txt",
          bundleFindFileId: "git:untracked:e2e-diff-edit-fixtures/new-file.txt",
        }}
      >
        <div>content</div>
      </DiffContentFrame>,
    );
    const host = container.querySelector("[data-diffs-host]");
    expect(host?.getAttribute("data-diff-find-file")).toBe(
      "e2e-diff-edit-fixtures/new-file.txt",
    );
    expect(host?.getAttribute("data-bundle-diff-file-id")).toBe(
      "git:untracked:e2e-diff-edit-fixtures/new-file.txt",
    );
  });

  it("omits both identity attributes when fileIdentity is null", () => {
    const { container } = render(
      <DiffContentFrame
        sizing="fill"
        banner={null}
        scrollContainerRef={null}
        onScroll={null}
        fileIdentity={null}
      >
        <div>content</div>
      </DiffContentFrame>,
    );
    const host = container.querySelector("[data-diffs-host]");
    expect(host?.hasAttribute("data-diff-find-file")).toBe(false);
    expect(host?.hasAttribute("data-bundle-diff-file-id")).toBe(false);
  });

  it("maps an LRU-retained hidden host, a visible host, and an aggregate section host one-to-one with no collision", () => {
    const HOSTS = [
      {
        // A tab an LRU keep-alive strategy hides instead of unmounting - the
        // frame stays in the DOM (just display:none), so its identity must
        // still resolve for automation and any background reconciliation.
        label: "lru-hidden",
        hidden: true,
        findFilePath: "src/hidden-file.ts",
        bundleFindFileId: "git:staged:src/hidden-file.ts",
      },
      {
        label: "visible-single",
        hidden: false,
        findFilePath: "src/visible-file.ts",
        bundleFindFileId: "git:unstaged:src/visible-file.ts",
      },
      {
        // A bundle/aggregate section's own inline content frame - same
        // shared boundary, disambiguated by stage in its bundleFindFileId.
        label: "aggregate-section",
        hidden: false,
        findFilePath: "src/visible-file.ts",
        bundleFindFileId: "git:staged:src/visible-file.ts",
      },
    ] as const;

    const { container } = render(
      <div>
        {HOSTS.map((host) => (
          <div
            key={host.label}
            style={{ display: host.hidden ? "none" : undefined }}
            data-testid={`wrapper-${host.label}`}
          >
            <DiffContentFrame
              sizing="content"
              banner={null}
              scrollContainerRef={null}
              onScroll={null}
              fileIdentity={{
                findFilePath: host.findFilePath,
                bundleFindFileId: host.bundleFindFileId,
              }}
            >
              <div>{host.label}</div>
            </DiffContentFrame>
          </div>
        ))}
      </div>,
    );

    // All three hosts are mounted (the hidden one included) - LRU-hiding is
    // a CSS concern, never an unmount, so its identity attribute survives.
    const allHosts = container.querySelectorAll("[data-diffs-host]");
    expect(allHosts).toHaveLength(3);

    // The two same-path hosts (visible single-file vs. its staged aggregate
    // counterpart) are disambiguated by bundleFindFileId alone - querying by
    // that value resolves to exactly one host each, never both.
    for (const host of HOSTS) {
      const matches = container.querySelectorAll(
        `[data-bundle-diff-file-id="${host.bundleFindFileId}"]`,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].getAttribute("data-diff-find-file")).toBe(
        host.findFilePath,
      );
    }

    // The hidden host's identity is still queryable even though it's not
    // painted - proving LRU-hiding never strips the marker.
    const hiddenWrapper = container.querySelector(
      '[data-testid="wrapper-lru-hidden"]',
    );
    expect(hiddenWrapper).not.toBeNull();
    const hiddenHost = hiddenWrapper?.querySelector(
      '[data-bundle-diff-file-id="git:staged:src/hidden-file.ts"]',
    );
    expect(hiddenHost).not.toBeNull();
  });
});
