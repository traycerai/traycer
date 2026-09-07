// Geometric regression: does every element in the local-bootstrap card sit on one left edge? Figures are CSS pixels at deviceScaleFactor 1.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** Subpixel identical edges can differ in the third decimal; the defect is about a third of the card width. Anything in between must fail. */
const EDGE_TOLERANCE_PX = 1;

/** Planted-control separation must sit well above the edge-match tolerance so a marginal reading cannot pass the comparator. */
const PLANTED_MIN_OFFSET_PX = 16;

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureUrlPath =
  "/src/__tests__/browser/window-host-modal-alignment.html";
const chromePath = await findChrome();
const profilePath = await mkdtemp(path.join(tmpdir(), "traycer-alignment-"));
const vitePort = await freePort();
let devtoolsPort = await freePort();
while (devtoolsPort === vitePort) devtoolsPort = await freePort();
let chrome;
let client;
let viteProcess;

try {
  const pageUrl = `http://127.0.0.1:${vitePort}${fixtureUrlPath}`;
  const requireFromHere = createRequire(import.meta.url);
  const viteManifestPath = requireFromHere.resolve("vite/package.json");
  const viteManifest = requireFromHere(viteManifestPath);
  const viteEntry = path.resolve(
    path.dirname(viteManifestPath),
    viteManifest.bin.vite,
  );
  viteProcess = spawn(
    "node",
    [
      viteEntry,
      "--config",
      path.join(projectRoot, "vitest.config.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(vitePort),
      "--strictPort",
    ],
    { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] },
  );
  let viteError = "";
  viteProcess.stderr.setEncoding("utf8");
  viteProcess.stderr.on("data", (chunk) => {
    viteError += chunk;
  });
  await waitForHttp(pageUrl, viteProcess, () => viteError, "Vite");

  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-features=Translate",
      "--disable-sync",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-sandbox",
      `--remote-debugging-port=${devtoolsPort}`,
      `--user-data-dir=${profilePath}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let chromeError = "";
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    chromeError += chunk;
  });
  await waitForHttp(
    `http://127.0.0.1:${devtoolsPort}/json/version`,
    chrome,
    () => chromeError,
    "Chrome DevTools",
  );
  const targetResponse = await fetch(
    `http://127.0.0.1:${devtoolsPort}/json/new?${encodeURIComponent(pageUrl)}`,
    { method: "PUT" },
  );
  if (!targetResponse.ok) {
    throw new Error(
      `Chrome could not open the fixture: ${targetResponse.status}`,
    );
  }
  const target = await targetResponse.json();
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await waitFor(
    client,
    "the modal, its body and the details toggle to be painted",
    `Boolean(document.querySelector('[data-testid="window-host-modal"]')) &&
     Boolean(document.querySelector('[data-testid="local-host-loading-spinner"]')) &&
     Boolean(document.querySelector('[data-testid="local-host-loading-toggle-details"]')) &&
     Boolean(document.querySelector('[data-probe-planted-control]'))`,
  );
  // Radix animates the content in (`zoom-in-95`, `fade-in-0`); a rect read
  // mid-transform is a position the user never sees.
  await evaluate(client, `new Promise((r) => setTimeout(r, 600))`);

  // Locate the heading by text. A class selector would go null on a style
  // change and read as agreement.
  const readEdges = `(() => {
    const modal = document.querySelector('[data-testid="window-host-modal"]');
    const byTestId = (id) => document.querySelector('[data-testid="' + id + '"]');
    const headingText = ${JSON.stringify("Downloading Traycer Host…")};
    const heading = modal === null
      ? null
      : Array.from(modal.querySelectorAll('p')).find(
          (p) => p.textContent.trim() === headingText,
        ) ?? null;
    const edge = (el) => {
      if (el === null || el === undefined) return null;
      const r = el.getBoundingClientRect();
      return {
        left: Number(r.left.toFixed(2)),
        right: Number(r.right.toFixed(2)),
        width: Number(r.width.toFixed(2)),
        height: Number(r.height.toFixed(2)),
        alignSelf: getComputedStyle(el).alignSelf,
        justifyContent: getComputedStyle(el).justifyContent,
      };
    };
    // Read computed type, not class names. Two utilities can resolve to the
    // same size and colour.
    const type = (name, el) => {
      if (el === null || el === undefined) return { name, present: false };
      const s = getComputedStyle(el);
      return {
        name,
        present: true,
        fontSizePx: Number(Number.parseFloat(s.fontSize).toFixed(2)),
        fontWeight: Number(s.fontWeight),
        color: s.color,
        text: el.textContent.trim().slice(0, 48),
      };
    };
    return {
      tailwindCompiled:
        getComputedStyle(document.querySelector('[data-probe-planted-column]')).display === 'flex',
      modal: edge(modal),
      modalPaddingLeft: modal === null ? null : getComputedStyle(modal).paddingLeft,
      title: edge(byTestId('window-host-modal-title')),
      description: edge(byTestId('window-host-modal-description')),
      spinner: edge(byTestId('local-host-loading-spinner')),
      heading: edge(heading),
      progressBar: edge(byTestId('local-host-download-progress')),
      toggle: edge(byTestId('local-host-loading-toggle-details')),
      // Measure the label, not the stretched full-width box (its left edge
      // sits on the card regardless of where the label is).
      toggleLabel: (() => {
        const el = byTestId('local-host-loading-toggle-details');
        return edge(el === null ? null : el.querySelector('span'));
      })(),
      logTail: edge(byTestId('local-host-loading-log-tail')),
      // The SAME slot's other state. Reported even when absent so the output
      // itself records which branch this load exercised, rather than leaving a
      // reader to assume both were covered.
      emptyTail: edge(byTestId('local-host-loading-empty-tail')),
      emptyTailTextAlign: (() => {
        const el = byTestId('local-host-loading-empty-tail');
        return el === null ? null : getComputedStyle(el).textAlign;
      })(),
      logTailTextAlign: (() => {
        const el = byTestId('local-host-loading-log-tail');
        return el === null ? null : getComputedStyle(el).textAlign;
      })(),
      // The ∅ arm's own member. Absent on this arm by construction - this
      // fixture mounts the cold-start body - and reported so that absence is
      // visible rather than inferred.
      bootstrapDetails: edge(byTestId('local-host-bootstrap-details')),
      configureShell: edge(byTestId('local-host-open-shell-settings')),
      plantedHeading: edge(document.querySelector('[data-probe-planted-heading]')),
      plantedControl: edge(document.querySelector('[data-probe-planted-control]')),
      plantedInnerLabel: edge(document.querySelector('[data-probe-planted-inner-label]')),
      typeRamp: [
        type('dialogTitle', byTestId('window-host-modal-title')),
        type('dialogDescription', byTestId('window-host-modal-description')),
        type('stage', heading),
        type('toggleLabel', (() => {
          const el = byTestId('local-host-loading-toggle-details');
          return el === null ? null : el.querySelector('span');
        })()),
      ],
      toggleExpanded: (() => {
        const el = byTestId('local-host-loading-toggle-details');
        return el === null ? null : el.getAttribute('aria-expanded');
      })(),
      toggleControls: (() => {
        const el = byTestId('local-host-loading-toggle-details');
        if (el === null) return null;
        const id = el.getAttribute('aria-controls');
        if (id === null) return { id: null, resolves: false };
        return { id, resolves: document.getElementById(id) !== null };
      })(),
    };
  })()`;

  const closed = await evaluate(client, readEdges);
  if (closed.toggle === null) throw new Error("details toggle not found");
  // Read live rather than reused from the measurement above: the reader stays a
  // pure measurement, and the click lands on where the toggle is NOW.
  const toggleCentre = await evaluate(
    client,
    `(() => {
       const el = document.querySelector('[data-testid="local-host-loading-toggle-details"]');
       const r = el.getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
     })()`,
  );
  await click(client, toggleCentre.x, toggleCentre.y);
  await evaluate(client, `new Promise((r) => setTimeout(r, 400))`);
  const open = await evaluate(client, readEdges);

  // Second load: empty tail via a fresh navigation, not a mutated snapshot.
  await client.send("Page.navigate", { url: `${pageUrl}?tail=empty` });
  await waitFor(
    client,
    "the empty-tail load's toggle to be painted",
    `Boolean(document.querySelector('[data-testid="local-host-loading-toggle-details"]')) &&
     Boolean(document.querySelector('[data-probe-planted-control]'))`,
  );
  await evaluate(client, `new Promise((r) => setTimeout(r, 600))`);
  const emptyToggleCentre = await evaluate(
    client,
    `(() => {
       const el = document.querySelector('[data-testid="local-host-loading-toggle-details"]');
       const r = el.getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
     })()`,
  );
  await click(client, emptyToggleCentre.x, emptyToggleCentre.y);
  await evaluate(client, `new Promise((r) => setTimeout(r, 400))`);
  const emptyTailOpen = await evaluate(client, readEdges);

  const checks = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed, detail });
  };
  const sameEdge = (a, b) =>
    a !== null && b !== null && Math.abs(a.left - b.left) <= EDGE_TOLERANCE_PX;
  const painted = (e) => e !== null && e.width > 0 && e.height > 0;

  // PC0: Tailwind actually compiled. Unstyled blocks share one left edge and
  // would pass alignment for the reason that invalidates it.
  check("PC0_tailwind_utilities_compiled", closed.tailwindCompiled === true, {
    plantedColumnDisplay: closed.tailwindCompiled ? "flex" : "NOT flex",
  });

  // PC1: every alignment member has a real box so "edges agree" cannot be two
  // nulls. Cold-start body only.
  const members = {
    title: closed.title,
    description: closed.description,
    spinner: closed.spinner,
    heading: closed.heading,
    progressBar: closed.progressBar,
    toggleLabel: closed.toggleLabel,
  };
  const unpainted = Object.entries(members)
    .filter(([, e]) => !painted(e))
    .map(([k]) => k);
  check("PC1_every_COLD_START_member_is_painted", unpainted.length === 0, {
    arm: "cold-start",
    unpainted,
    notMeasuredHere: ["local-host-bootstrap-details (∅ arm only)"],
  });

  // PC2 - the comparator can see a centred control. Same flex-column shape,
  // same tolerance, deliberately defective.
  const plantedOffset =
    closed.plantedHeading === null || closed.plantedControl === null
      ? null
      : Number(
          Math.abs(
            closed.plantedControl.left - closed.plantedHeading.left,
          ).toFixed(2),
        );
  check(
    "PC2a_comparator_flags_a_self_centred_box",
    plantedOffset !== null && plantedOffset >= PLANTED_MIN_OFFSET_PX,
    {
      plantedOffsetPx: plantedOffset,
      requiredAtLeastPx: PLANTED_MIN_OFFSET_PX,
    },
  );

  // PC2b: content-centred control keeps a full-width box; measuring the box
  // would call it aligned.
  const plantedInnerOffset =
    closed.plantedHeading === null || closed.plantedInnerLabel === null
      ? null
      : Number(
          Math.abs(
            closed.plantedInnerLabel.left - closed.plantedHeading.left,
          ).toFixed(2),
        );
  check(
    "PC2b_comparator_flags_a_content_centred_label",
    plantedInnerOffset !== null && plantedInnerOffset >= PLANTED_MIN_OFFSET_PX,
    {
      plantedInnerOffsetPx: plantedInnerOffset,
      requiredAtLeastPx: PLANTED_MIN_OFFSET_PX,
    },
  );

  // A1 - the claim. The details toggle's LABEL sits on the same left edge as the
  // body's own heading.
  check(
    "A1_toggle_label_left_edge_matches_heading",
    sameEdge(closed.toggleLabel, closed.heading),
    {
      toggleLabelPx: closed.toggleLabel?.left ?? null,
      toggleBoxPx: closed.toggle?.left ?? null,
      headingPx: closed.heading?.left ?? null,
      deltaPx:
        closed.toggleLabel === null || closed.heading === null
          ? null
          : Number(
              Math.abs(closed.toggleLabel.left - closed.heading.left).toFixed(
                2,
              ),
            ),
      toggleAlignSelf: closed.toggle?.alignSelf ?? null,
      toggleJustifyContent: closed.toggle?.justifyContent ?? null,
    },
  );

  // A2 - ONE alignment, not three. The whole card, dialog chrome included:
  // if the body's root only agreed with itself the surface would still read as
  // two alignments stacked.
  const edgeSet = Object.entries(members)
    .filter(([, e]) => e !== null)
    .map(([name, e]) => ({ name, leftPx: e.left }));
  const distinct = [];
  for (const entry of edgeSet) {
    if (
      !distinct.some((d) => Math.abs(d - entry.leftPx) <= EDGE_TOLERANCE_PX)
    ) {
      distinct.push(entry.leftPx);
    }
  }
  check("A2_whole_card_presents_one_left_edge", distinct.length === 1, {
    distinctEdgesPx: distinct,
    perMember: edgeSet,
  });

  // A3 - the open state. `Configure shell…` was centred by its own wrapper, a
  // second copy of the same defect that a closed-state-only measurement cannot
  // see.
  check(
    "A3_open_state_members_match_heading",
    open.toggleExpanded === "true" &&
      sameEdge(open.toggleLabel, open.heading) &&
      sameEdge(open.logTail, open.heading) &&
      sameEdge(open.configureShell, open.heading),
    {
      toggleExpanded: open.toggleExpanded,
      headingPx: open.heading?.left ?? null,
      toggleLabelPx: open.toggleLabel?.left ?? null,
      logTailPx: open.logTail?.left ?? null,
      configureShellPx: open.configureShell?.left ?? null,
    },
  );

  // A4 - the toggle names a region that exists. A dangling `aria-controls` is
  // worse than none: it reports a control that operates nothing.
  check(
    "A4_aria_controls_resolves_in_both_states",
    closed.toggleControls?.resolves === true &&
      open.toggleControls?.resolves === true,
    { closed: closed.toggleControls, open: open.toggleControls },
  );

  // A5: no other row matches the title's colour and heading weight. Demoting
  // the stage while promoting a third row must fail.
  const ramp = closed.typeRamp.filter((row) => row.present);
  const titleRow = ramp.find((row) => row.name === "dialogTitle") ?? null;
  const rivals =
    titleRow === null
      ? []
      : ramp.filter(
          (row) =>
            row.name !== "dialogTitle" &&
            row.color === titleRow.color &&
            row.fontWeight >= titleRow.fontWeight,
        );
  check(
    "A5_the_dialog_title_is_the_cards_only_heading",
    titleRow !== null && rivals.length === 0,
    {
      title: titleRow,
      rivalsAtTitleColourAndWeight: rivals.map((r) => r.name),
      ramp,
    },
  );

  // PC3 - the ramp reader resolved real rows. Every row it compared must be
  // present with a non-zero size; a ramp of absent rows has no rivals either,
  // and would pass A5 for the one reason that makes it meaningless.
  const rampMissing = closed.typeRamp
    .filter((row) => !row.present || !(row.fontSizePx > 0))
    .map((row) => row.name);
  check("PC3_every_type_ramp_row_resolved", rampMissing.length === 0, {
    missingOrZero: rampMissing,
  });

  // PC4: a matching left edge does not prove justify-center is gone; self-start
  // shrink-wraps so both polarities must be enumerated.
  const probeToggleClass = async (extra) =>
    evaluate(
      client,
      `(() => {
         const el = document.querySelector('[data-testid="local-host-loading-toggle-details"]');
         const original = el.className;
         el.className = original + ${JSON.stringify(` ${extra}`)};
         const label = el.querySelector('span').getBoundingClientRect().left;
         el.className = original;
         const restored = el.querySelector('span').getBoundingClientRect().left;
         return {
           labelLeftPx: Number(label.toFixed(2)),
           restoredLeftPx: Number(restored.toFixed(2)),
         };
       })()`,
    );

  const baseline = closed.toggleLabel?.left ?? null;
  const rows = [
    { classes: "justify-center", expectMoves: true },
    { classes: "self-start", expectMoves: false },
    { classes: "self-start justify-center", expectMoves: false },
  ];
  const truthTable = [];
  for (const row of rows) {
    const reading = await probeToggleClass(row.classes);
    const moved =
      baseline === null
        ? null
        : Math.abs(reading.labelLeftPx - baseline) > EDGE_TOLERANCE_PX;
    truthTable.push({
      added: row.classes,
      labelLeftPx: reading.labelLeftPx,
      movedFromBaseline: moved,
      expectedToMove: row.expectMoves,
      // Every probe must leave the toggle exactly as it found it, or each later
      // row measures the previous row's damage.
      restoredToBaselinePx: reading.restoredLeftPx,
      restoredCleanly:
        baseline !== null &&
        Math.abs(reading.restoredLeftPx - baseline) <= EDGE_TOLERANCE_PX,
    });
  }
  check(
    "PC4_the_masking_substitution_is_invisible_to_this_harness",
    truthTable.every(
      (r) => r.movedFromBaseline === r.expectedToMove && r.restoredCleanly,
    ),
    {
      baselineLabelLeftPx: baseline,
      truthTable,
      meaning:
        "`justify-center` alone MOVES the label and is caught. With `self-start` " +
        "it does not move, so this harness reports the masking combination as " +
        "aligned. Only the class string distinguishes them - hence the step-7 " +
        "grep guard.",
    },
  );

  // Stage transition: percent blanks, progress unmounts, everything below
  // moves. Measure the magnitude; do not rule on it.
  await client.send("Page.navigate", { url: `${pageUrl}?progress=none` });
  await waitFor(
    client,
    "the no-numbers load to paint",
    `Boolean(document.querySelector('[data-testid="window-host-modal"]')) &&
     Boolean(document.querySelector('[data-testid="local-host-loading-toggle-details"]'))`,
  );
  await evaluate(client, `new Promise((r) => setTimeout(r, 600))`);
  const transitionShape = await evaluate(
    client,
    `(() => {
       const rect = (sel) => {
         const el = document.querySelector(sel);
         if (el === null) return null;
         const r = el.getBoundingClientRect();
         return { top: Number(r.top.toFixed(2)), height: Number(r.height.toFixed(2)) };
       };
       const seg = document.querySelector('[data-testid="local-host-progress-indeterminate"]');
       const bar = document.querySelector('[data-testid="local-host-download-progress"]');
       return {
         modal: rect('[data-testid="window-host-modal"]'),
         progressBlock: rect('[data-testid="local-host-download-progress"]'),
         toggle: rect('[data-testid="local-host-loading-toggle-details"]'),
         indeterminate: bar === null ? null : bar.dataset.indeterminate,
         // The animation must be REAL, read from computed style rather than from
         // the class list: a static full-width fill is the frozen-100% lie in a
         // new costume, however it is spelled.
         segment:
           seg === null
             ? null
             : {
                 animationName: getComputedStyle(seg).animationName,
                 animationDuration: getComputedStyle(seg).animationDuration,
                 iterationCount: getComputedStyle(seg).animationIterationCount,
                 widthPx: Number(seg.getBoundingClientRect().width.toFixed(2)),
                 trackWidthPx: Number(bar.querySelector('[role="progressbar"]').getBoundingClientRect().width.toFixed(2)),
               },
         // Live proof it MOVES: two samples a few frames apart.
         sampleOneLeftPx:
           seg === null ? null : Number(seg.getBoundingClientRect().left.toFixed(2)),
       };
     })()`,
  );
  await evaluate(client, `new Promise((r) => setTimeout(r, 350))`);
  const secondSampleLeftPx = await evaluate(
    client,
    `(() => {
       const seg = document.querySelector('[data-testid="local-host-progress-indeterminate"]');
       return seg === null ? null : Number(seg.getBoundingClientRect().left.toFixed(2));
     })()`,
  );

  // A7: stage transition must not move the card. Assert height equality; jsdom
  // has no layout engine.
  check(
    "A7_a_stage_transition_does_not_change_the_card_height",
    closed.modal !== null &&
      transitionShape.modal !== null &&
      Math.abs(closed.modal.height - transitionShape.modal.height) <=
        EDGE_TOLERANCE_PX,
    {
      withNumbersPx: closed.modal?.height ?? null,
      withoutNumbersPx: transitionShape.modal?.height ?? null,
      deltaPx:
        closed.modal === null || transitionShape.modal === null
          ? null
          : Number(
              Math.abs(
                closed.modal.height - transitionShape.modal.height,
              ).toFixed(2),
            ),
    },
  );

  // A8 - and it ANIMATES, and is obviously partial. A motionless bar, or a
  // full-width one, would hold the space while reasserting the completed-transfer
  // lie the scoped carry-forward removed.
  const seg = transitionShape.segment;
  check(
    "A8_the_indeterminate_segment_animates_and_is_partial",
    transitionShape.indeterminate === "true" &&
      seg !== null &&
      seg.animationName === "host-progress-indeterminate" &&
      seg.iterationCount === "infinite" &&
      seg.widthPx > 0 &&
      seg.widthPx < seg.trackWidthPx * 0.6 &&
      transitionShape.sampleOneLeftPx !== null &&
      secondSampleLeftPx !== null &&
      Math.abs(secondSampleLeftPx - transitionShape.sampleOneLeftPx) >
        EDGE_TOLERANCE_PX,
    {
      indeterminateFlag: transitionShape.indeterminate,
      segment: seg,
      movedPx:
        transitionShape.sampleOneLeftPx === null || secondSampleLeftPx === null
          ? null
          : Number(
              Math.abs(
                secondSampleLeftPx - transitionShape.sampleOneLeftPx,
              ).toFixed(2),
            ),
    },
  );

  // A6: empty-tail placeholder must match the pre it alternates with. Placeholder
  // present and pre absent, or the claim is about a node this load never rendered.
  check(
    "A6_empty_tail_placeholder_matches_the_pre_it_alternates_with",
    emptyTailOpen.emptyTail !== null &&
      emptyTailOpen.logTail === null &&
      emptyTailOpen.emptyTailTextAlign === "left" &&
      sameEdge(emptyTailOpen.emptyTail, emptyTailOpen.heading),
    {
      placeholderPresent: emptyTailOpen.emptyTail !== null,
      preAbsentOnThisLoad: emptyTailOpen.logTail === null,
      placeholderTextAlign: emptyTailOpen.emptyTailTextAlign,
      preTextAlignOnFirstLoad: open.logTailTextAlign,
      placeholderLeftPx: emptyTailOpen.emptyTail?.left ?? null,
      headingLeftPx: emptyTailOpen.heading?.left ?? null,
    },
  );

  const failed = checks.filter((c) => !c.passed);
  console.log(
    JSON.stringify(
      {
        UNITS: "all lengths in CSS px at deviceScaleFactor 1",
        ARM: "cold-start only - the ∅ body is NOT rendered by this fixture",
        CHECKS: checks,
        CLOSED: closed,
        OPEN: open,
        OPEN_WITH_EMPTY_TAIL: emptyTailOpen,
        STAGE_TRANSITION_SHAPE_no_progress_numbers: transitionShape,
        STAGE_TRANSITION_SHAPE_with_progress_numbers: {
          modal: {
            top: closed.modal?.left ?? null,
            height: closed.modal?.height ?? null,
          },
          progressBlock: { height: closed.progressBar?.height ?? null },
          toggle: { height: closed.toggle?.height ?? null },
        },
        VERDICT: failed.length === 0 ? "ALL PASS" : "FAILED",
        FAILED: failed.map((c) => c.name),
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) process.exitCode = 1;
} catch (error) {
  // Reported here rather than left to propagate: a throw out of `finally`
  // (Chrome still writing its profile when `rm` runs) would replace this one
  // and the real failure would never be printed.
  console.error("MEASUREMENT FAILED:", error);
  process.exitCode = 1;
} finally {
  client?.close();
  chrome?.kill("SIGKILL");
  viteProcess?.kill("SIGKILL");
  await delay(300);
  try {
    await rm(profilePath, { recursive: true, force: true });
  } catch {
    // A leftover temp profile is not a measurement result.
  }
}

async function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("No Chrome/Chromium binary found");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, child, readError, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited early: ${readError()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await delay(150);
  }
  throw new Error(`${label} did not become reachable: ${readError()}`);
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    const connectTimer = setTimeout(
      () => reject(new Error("CDP connect timed out")),
      15_000,
    );
    socket.addEventListener("error", (event) =>
      reject(new Error(String(event))),
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (message.error === undefined) request.resolve(message.result);
      else request.reject(new Error(message.error.message));
    });
    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      resolve({
        send(method, params = {}) {
          return new Promise((requestResolve, requestReject) => {
            const id = ++nextId;
            pending.set(id, { resolve: requestResolve, reject: requestReject });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        },
      });
    });
  });
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Browser evaluation failed",
    );
  }
  return response.result.value;
}

async function waitFor(client, label, expression) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await delay(50);
  }
  const pageState = await evaluate(
    client,
    `({ text: document.body.innerText, html: document.body.innerHTML.slice(0, 3000) })`,
  );
  throw new Error(
    `Timed out waiting for ${label}:\n${JSON.stringify(pageState, null, 2)}`,
  );
}

async function click(client, x, y) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}
