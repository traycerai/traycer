import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EpicListHtmlArtifactVersionsResponse,
  HtmlArtifactVersion,
  HtmlArtifactVersionSelection,
} from "@traycer/protocol/host/epic/html-artifact-versions";
import { HtmlArtifactVersionPicker } from "@/components/html-artifact/html-artifact-version-picker";
import type { HtmlArtifactVersionState } from "@/hooks/epic/use-epic-html-artifact-version";

vi.mock("@/hooks/ui/use-coarse-pointer", () => ({
  useCoarsePointer: () => false,
}));

const TIME_OF_DAY = /\d{1,2}:\d{2}/;

function textOf(element: Element): string {
  return String(element.textContent);
}

function version(
  versionNumber: number,
  capturedAt: number,
): HtmlArtifactVersion {
  return {
    id: String(versionNumber).repeat(64),
    versionNumber,
    entryPath: "index.html",
    manifest: {
      files: {
        "index.html": {
          sha256: String(versionNumber).repeat(64),
          byteLength: 10,
          mediaType: "text/html",
        },
      },
      capturedAt,
    },
  };
}

const V3 = version(3, Date.UTC(2026, 9, 22, 14, 5));
const V2 = version(2, Date.UTC(2026, 9, 21, 9, 30));
const V1 = version(1, Date.UTC(2026, 9, 20, 16, 45));

const PAGE: EpicListHtmlArtifactVersionsResponse = {
  versions: [V3, V2, V1],
  nextCursor: null,
  currentVersionNumber: 3,
};

interface PickerScenario {
  readonly selected: HtmlArtifactVersionSelection | null;
  readonly selectedVersionNumber: number | null;
  readonly selectionAvailable: boolean;
  readonly currentVersionNumber: number | null;
}

const historyOptions = queryOptions<
  EpicListHtmlArtifactVersionsResponse,
  HostRpcError
>({
  queryKey: ["html-artifact-versions-test"],
  queryFn: () => Promise.resolve(PAGE),
  initialData: PAGE,
});

/** The real picker over a real query result, so menu and focus behave as shipped. */
function PickerHarness(props: {
  readonly scenario: PickerScenario;
  readonly selectVersion: (
    version: HtmlArtifactVersionSelection | null,
  ) => void;
}) {
  const history = useQuery(historyOptions);
  const state: HtmlArtifactVersionState = {
    manifest: null,
    entryPath: null,
    selectedVersion: props.scenario.selected,
    selectedVersionNumber: props.scenario.selectedVersionNumber,
    currentVersionNumber: props.scenario.currentVersionNumber,
    selectionAvailable: props.scenario.selectionAvailable,
    selectVersion: props.selectVersion,
    supported: true,
    history,
    showOlder: () => undefined,
    showNewest: () => undefined,
    hasNewer: false,
  };
  return <HtmlArtifactVersionPicker version={state} />;
}

function renderPicker(scenario: PickerScenario) {
  const selectVersion =
    vi.fn<(version: HtmlArtifactVersionSelection | null) => void>();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PickerHarness scenario={scenario} selectVersion={selectVersion} />
    </QueryClientProvider>,
  );
  return { selectVersion, user: userEvent.setup() };
}

const LATEST: PickerScenario = {
  selected: null,
  selectedVersionNumber: null,
  selectionAvailable: true,
  currentVersionNumber: 3,
};

afterEach(cleanup);

describe("<HtmlArtifactVersionPicker />", () => {
  it("names the latest version by its number on the button", () => {
    renderPicker(LATEST);

    expect(
      textOf(screen.getByRole("button", { name: /HTML version history/ })),
    ).toContain("Latest · v3");
  });

  it("lists the live version once, as the newest numbered row, then the older versions", async () => {
    const { user } = renderPicker(LATEST);

    await user.click(
      screen.getByRole("button", { name: /HTML version history/ }),
    );

    const rows = screen.getAllByRole("menuitemradio");
    expect(rows.map((row) => /Version (\d)/.exec(textOf(row))?.[1])).toEqual([
      "3",
      "2",
      "1",
    ]);
    expect(textOf(rows[0])).toMatch(/Version 3 · Latest/);
    expect(rows.filter((row) => /Latest/.test(textOf(row)))).toHaveLength(1);
    for (const row of rows) {
      expect(textOf(row)).toMatch(TIME_OF_DAY);
    }
    expect(rows[0].getAttribute("aria-checked")).toBe("true");
  });

  it("pins the chosen version with its number, and returns to Latest from the live row", async () => {
    const pinned = renderPicker({
      selected: V2,
      selectedVersionNumber: 2,
      selectionAvailable: true,
      currentVersionNumber: 3,
    });

    await pinned.user.click(
      screen.getByRole("button", { name: /HTML version history/ }),
    );
    await pinned.user.click(
      screen.getByRole("menuitemradio", { name: /Latest/ }),
    );
    expect(pinned.selectVersion).toHaveBeenLastCalledWith(null);
    cleanup();

    const latest = renderPicker(LATEST);
    await latest.user.click(
      screen.getByRole("button", { name: /HTML version history/ }),
    );
    await latest.user.click(
      screen.getByRole("menuitemradio", { name: /Version 2/ }),
    );
    expect(latest.selectVersion).toHaveBeenCalledWith(
      expect.objectContaining({ versionNumber: 2, entryPath: "index.html" }),
    );
  });

  it("shows a pinned version as its number, marked selected in the menu", async () => {
    const { user } = renderPicker({
      selected: V2,
      selectedVersionNumber: 2,
      selectionAvailable: true,
      currentVersionNumber: 3,
    });

    const button = screen.getByRole("button", { name: /HTML version history/ });
    expect(textOf(button)).toContain("Version 2");
    expect(textOf(button)).not.toMatch(TIME_OF_DAY);

    await user.click(button);

    const selected = screen
      .getAllByRole("menuitemradio")
      .filter((row) => row.getAttribute("aria-checked") === "true");
    expect(selected).toHaveLength(1);
    expect(within(selected[0]).getByText(/Version 2/)).toBeTruthy();
    expect(textOf(selected[0])).not.toMatch(/Latest/);
  });

  it("calls a legacy pin without a known number a saved version, never just a date", async () => {
    // A pin saved before numbers existed, matching nothing in the history page.
    const legacy: HtmlArtifactVersionSelection = {
      manifest: {
        files: {
          "index.html": {
            sha256: "e".repeat(64),
            byteLength: 4,
            mediaType: "text/html",
          },
        },
        capturedAt: Date.UTC(2026, 8, 1, 8, 15),
      },
      entryPath: "index.html",
    };
    const { user } = renderPicker({
      selected: legacy,
      selectedVersionNumber: null,
      selectionAvailable: true,
      currentVersionNumber: 3,
    });

    const button = screen.getByRole("button", { name: /HTML version history/ });
    expect(textOf(button)).toContain("Saved version");
    expect(textOf(button)).not.toMatch(TIME_OF_DAY);

    await user.click(button);

    expect(
      screen
        .getAllByRole("menuitemradio")
        .some(
          (row) =>
            row.getAttribute("aria-checked") === "true" &&
            /Saved version/.test(textOf(row)),
        ),
    ).toBe(true);
  });
  it.each([
    ["following Latest", LATEST],
    [
      "holding a pin",
      {
        selected: V2,
        selectedVersionNumber: 2,
        selectionAvailable: true,
        currentVersionNumber: 3,
      },
    ],
  ])(
    "offers no picker when this tile cannot keep a choice, %s",
    (_label, scenario) => {
      renderPicker({ ...scenario, selectionAvailable: false });

      expect(
        screen.queryByRole("button", { name: /HTML version history/ }),
      ).toBeNull();
    },
  );
});
