/**
 * The branded QR tile is drawn from the encoder's own matrix, so these tests
 * compare the rendered SVG against a symbol encoded here: every module the
 * encoder produced is drawn, at its own coordinates, at level H, inside the
 * quiet zone. The expiry frame's drain and the rotation fade are asserted the
 * same way — off the rendered attributes, with no library standing in.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { buildLinkLoginQrPayload } from "@traycer-clients/shared/auth/link-login";

import {
  FRAME_CENTRE_INSET_PERCENT,
  FRAME_RADIUS_PERCENT,
  LinkPhoneQrTile,
} from "../link-phone-qr-tile";

const CODE = "ABCDE-FGHJK";
const PLATFORM = "https://platform.example.test";
const QUIET_ZONE = 5;
const FINDER = 7;

function expectedSymbol(code: string) {
  const qr = QRCode.create(buildLinkLoginQrPayload(PLATFORM, code), {
    errorCorrectionLevel: "H",
  });
  const size = qr.modules.size;
  const dark = new Set<string>();
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const nearTop = row < FINDER;
      const nearBottom = row >= size - FINDER;
      const nearLeft = col < FINDER;
      const nearRight = col >= size - FINDER;
      const finder =
        (nearTop && nearLeft) ||
        (nearTop && nearRight) ||
        (nearBottom && nearLeft);
      if (qr.modules.get(row, col) === 1 && !finder) {
        dark.add(`${row}-${col}`);
      }
    }
  }
  return { size, dark, version: qr.version };
}

/** Reads the drawn module set back out of the SVG, in matrix coordinates. */
function renderedModules(): Set<string> {
  const group = screen.getByTestId("link-phone-qr-modules");
  const drawn = new Set<string>();
  for (const rect of group.querySelectorAll("rect")) {
    const col = Math.round(Number(rect.getAttribute("x")) - QUIET_ZONE);
    const row = Math.round(Number(rect.getAttribute("y")) - QUIET_ZONE);
    drawn.add(`${row}-${col}`);
  }
  return drawn;
}

afterEach(() => {
  cleanup();
});

describe("LinkPhoneQrTile", () => {
  it("draws exactly the encoder's matrix for the code's deep-link payload", () => {
    const expected = expectedSymbol(CODE);
    render(
      <LinkPhoneQrTile
        platformBaseUrl={PLATFORM}
        code={CODE}
        remainingFraction={1}
      />,
    );
    expect(renderedModules()).toEqual(expected.dark);
    // A different code encodes a different symbol, so the comparison above is
    // load-bearing rather than a shape check.
    const other = expectedSymbol("11111-22222");
    expect(other.dark).not.toEqual(expected.dark);
  });

  it("encodes at level H inside a full quiet zone, with the three eyes drawn", () => {
    const expected = expectedSymbol(CODE);
    render(
      <LinkPhoneQrTile
        platformBaseUrl={PLATFORM}
        code={CODE}
        remainingFraction={1}
      />,
    );
    const svg = screen.getByTestId("link-phone-qr");
    expect(svg.getAttribute("data-qr-error-correction")).toBe("H");
    expect(svg.getAttribute("data-qr-quiet-zone")).toBe(String(QUIET_ZONE));
    expect(svg.getAttribute("data-qr-version")).toBe(String(expected.version));
    // The symbol plus a 4-module margin on each side.
    expect(svg.getAttribute("viewBox")).toBe(
      `0 0 ${expected.size + QUIET_ZONE * 2} ${expected.size + QUIET_ZONE * 2}`,
    );
    // Each styled eye is three nested rects; the dot pass drew none of them.
    const eyeRects = svg.querySelectorAll("g:not([data-testid]) rect");
    expect(eyeRects.length).toBe(9);
  });

  it("drains the expiry frame with the remaining share of the code's life", () => {
    const view = render(
      <LinkPhoneQrTile
        platformBaseUrl={PLATFORM}
        code={CODE}
        remainingFraction={1}
      />,
    );
    const offset = () =>
      screen
        .getByTestId("link-phone-expiry-frame")
        .getAttribute("stroke-dashoffset");
    expect(offset()).toBe("0");
    view.rerender(
      <LinkPhoneQrTile
        platformBaseUrl={PLATFORM}
        code={CODE}
        remainingFraction={0.5}
      />,
    );
    expect(offset()).toBe("0.5");
    view.rerender(
      <LinkPhoneQrTile
        platformBaseUrl={PLATFORM}
        code={CODE}
        remainingFraction={0}
      />,
    );
    expect(offset()).toBe("1");
  });

  it("clamps a fraction the clock overshot instead of drawing past the frame", () => {
    const view = render(
      <LinkPhoneQrTile
        platformBaseUrl={PLATFORM}
        code={CODE}
        remainingFraction={1.4}
      />,
    );
    const frame = () => screen.getByTestId("link-phone-expiry-frame");
    expect(frame().getAttribute("data-remaining-fraction")).toBe("1.00");
    view.rerender(
      <LinkPhoneQrTile
        platformBaseUrl={PLATFORM}
        code={CODE}
        remainingFraction={-0.2}
      />,
    );
    expect(frame().getAttribute("data-remaining-fraction")).toBe("0.00");
  });

  it("ends the paper on the frame's centre line, sharing its corner curve", () => {
    const expected = expectedSymbol(CODE);
    render(
      <LinkPhoneQrTile
        platformBaseUrl={PLATFORM}
        code={CODE}
        remainingFraction={1}
      />,
    );
    const svg = screen.getByTestId("link-phone-qr");
    const extent = expected.size + QUIET_ZONE * 2;
    // The paper is the first rect in the symbol — everything else is a module
    // or an eye. Its edge must land where the frame's stroke is centred, with
    // the frame's radius, or the two curves disagree and the white tile
    // speckles out past the band on a dark background.
    const paper = svg.querySelector("rect");
    const inset = (FRAME_CENTRE_INSET_PERCENT / 100) * extent;
    expect(Number(paper?.getAttribute("x"))).toBeCloseTo(inset, 6);
    expect(Number(paper?.getAttribute("width"))).toBeCloseTo(
      extent - inset * 2,
      6,
    );
    expect(Number(paper?.getAttribute("rx"))).toBeCloseTo(
      (FRAME_RADIUS_PERCENT / 100) * extent,
      6,
    );
    // Four light modules have to survive the stroke covering the paper's rim.
    expect(QUIET_ZONE - inset).toBeGreaterThanOrEqual(4);
  });

  it("draws the drain flush against its track, with no protruding caps", () => {
    render(
      <LinkPhoneQrTile
        platformBaseUrl={PLATFORM}
        code={CODE}
        remainingFraction={0.5}
      />,
    );
    const drain = screen.getByTestId("link-phone-expiry-frame");
    expect(drain.getAttribute("stroke-linecap")).toBe("butt");
    // Track and drain are the same path, so the band cannot step or gap.
    const track = drain.previousElementSibling;
    for (const attribute of ["x", "y", "width", "height", "rx"]) {
      expect(track?.getAttribute(attribute)).toBe(
        drain.getAttribute(attribute),
      );
    }
  });

  it("holds the same footprint while a code is being minted", () => {
    const view = render(
      <LinkPhoneQrTile
        platformBaseUrl={PLATFORM}
        code={CODE}
        remainingFraction={1}
      />,
    );
    const withCode = screen.getByTestId("link-phone-qr-tile");
    expect(withCode.getAttribute("data-tile-state")).toBe("code");

    view.rerender(
      <LinkPhoneQrTile
        platformBaseUrl={PLATFORM}
        code={null}
        remainingFraction={0}
      />,
    );
    const pending = screen.getByTestId("link-phone-qr-tile");
    // jsdom does no layout, so the invariant is pinned on the box that
    // decides the height: same element, same sizing classes, both states.
    expect(pending.className).toBe(withCode.className);
    expect(pending.getAttribute("data-tile-state")).toBe("loading");
    expect(screen.getByTestId("link-phone-qr-placeholder")).toBeTruthy();
    expect(screen.queryByTestId("link-phone-qr")).toBeNull();
    // The frame stays, empty — the tile still reads as the code's place.
    expect(
      screen
        .getByTestId("link-phone-expiry-frame")
        .getAttribute("data-remaining-fraction"),
    ).toBe("0.00");
  });

  it("fades a rotated code in on a fresh surface", () => {
    const view = render(
      <LinkPhoneQrTile
        platformBaseUrl={PLATFORM}
        code={CODE}
        remainingFraction={1}
      />,
    );
    const first = screen.getByTestId("link-phone-qr-surface");
    expect(first.className).toContain("fade-in-0");
    view.rerender(
      <LinkPhoneQrTile
        platformBaseUrl={PLATFORM}
        code="22222-33333"
        remainingFraction={1}
      />,
    );
    // Keyed on the code: the rotation mounts a new surface rather than
    // mutating the old one, which is what replays the fade.
    expect(screen.getByTestId("link-phone-qr-surface")).not.toBe(first);
  });
});
