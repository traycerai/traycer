import { memo, useMemo, type ReactElement } from "react";
import QRCode from "qrcode";
import { buildLinkLoginQrPayload } from "@traycer-clients/shared/auth/link-login";
import { BrandMark } from "@/components/auth/cinematic-backdrop";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** `qrcode` hands back the raw module matrix synchronously, so the whole symbol is plain SVG. */

/** A fifth is carried because the frame's stroke covers the paper's outermost fraction (see below), and the
 * four light modules have to survive that. */
const QUIET_ZONE_MODULES = 5;
const FINDER_SIZE_MODULES = 7;
const MODULE_INSET = 0.04;
const MODULE_RADIUS = 0.32;

/** Two independently rounded boxes stacked on each other cannot promise that. */
const FRAME_STROKE_PERCENT = 2.8;
/** Exported so a test asserts against this geometry rather than restating it. */
export const FRAME_CENTRE_INSET_PERCENT = FRAME_STROKE_PERCENT / 2;
export const FRAME_RADIUS_PERCENT = 4;

/** These are deliberately not theme tokens. */
const QR_INK = "#0B0B0F";
const QR_PAPER = "#FFFFFF";

interface QrSymbol {
  readonly size: number;
  readonly bits: readonly boolean[];
  readonly version: number;
}

/** Returns null when the encoder refuses the input - the caller shows the loading tile rather than a broken
 * symbol. */
function encodeQrSymbol(
  platformBaseUrl: string,
  code: string,
): QrSymbol | null {
  try {
    const qr = QRCode.create(buildLinkLoginQrPayload(platformBaseUrl, code), {
      // Level H because the centred brand mark covers live modules.
      errorCorrectionLevel: "H",
    });
    const size = qr.modules.size;
    const bits: boolean[] = [];
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        bits.push(qr.modules.get(row, col) === 1);
      }
    }
    return { size, bits, version: qr.version };
  } catch {
    return null;
  }
}

function isFinderModule(row: number, col: number, size: number): boolean {
  const nearTop = row < FINDER_SIZE_MODULES;
  const nearBottom = row >= size - FINDER_SIZE_MODULES;
  const nearLeft = col < FINDER_SIZE_MODULES;
  const nearRight = col >= size - FINDER_SIZE_MODULES;
  return (
    (nearTop && nearLeft) || (nearTop && nearRight) || (nearBottom && nearLeft)
  );
}

/** Sized from `FINDER_SIZE_MODULES` rather than from literals, so the eye and the region the dot pass skips can
 * never disagree about how big a finder is. */
function FinderEye(props: { readonly row: number; readonly col: number }) {
  const x = props.col + QUIET_ZONE_MODULES;
  const y = props.row + QUIET_ZONE_MODULES;
  const outer = FINDER_SIZE_MODULES;
  const middle = outer - 2;
  const inner = outer - 4;
  return (
    <g>
      <rect x={x} y={y} width={outer} height={outer} rx={2.2} fill={QR_INK} />
      <rect
        x={x + 1}
        y={y + 1}
        width={middle}
        height={middle}
        rx={1.5}
        fill={QR_PAPER}
      />
      <rect
        x={x + 2}
        y={y + 2}
        width={inner}
        height={inner}
        rx={1}
        fill={QR_INK}
      />
    </g>
  );
}

/** Memoized because the panel around it re-renders once a second for the countdown text while the symbol itself
 * cannot change - rebuilding several hundred `<rect>` elements per tick for an identical result. */
const QrSymbolSvg = memo(function QrSymbolSvg(props: {
  readonly symbol: QrSymbol;
}) {
  const { size, bits } = props.symbol;
  const extent = size + QUIET_ZONE_MODULES * 2;
  const modules: ReactElement[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!bits[row * size + col] || isFinderModule(row, col, size)) {
        continue;
      }
      modules.push(
        <rect
          key={`${row}-${col}`}
          x={col + QUIET_ZONE_MODULES + MODULE_INSET}
          y={row + QUIET_ZONE_MODULES + MODULE_INSET}
          width={1 - MODULE_INSET * 2}
          height={1 - MODULE_INSET * 2}
          rx={MODULE_RADIUS}
          fill={QR_INK}
        />,
      );
    }
  }
  // The frame's percentages expressed in this symbol's own units, so paper
  // and frame describe one shape rather than two that nearly agree.
  const paperInset = (FRAME_CENTRE_INSET_PERCENT / 100) * extent;
  const paperRadius = (FRAME_RADIUS_PERCENT / 100) * extent;
  return (
    <svg
      viewBox={`0 0 ${extent} ${extent}`}
      className="absolute inset-0 h-full w-full"
      role="img"
      aria-label="Link mobile app QR code"
      data-testid="link-phone-qr"
      data-qr-version={props.symbol.version}
      data-qr-error-correction="H"
      data-qr-quiet-zone={QUIET_ZONE_MODULES}
    >
      <rect
        x={paperInset}
        y={paperInset}
        width={extent - paperInset * 2}
        height={extent - paperInset * 2}
        rx={paperRadius}
        fill={QR_PAPER}
      />
      <g data-testid="link-phone-qr-modules">{modules}</g>
      <FinderEye row={0} col={0} />
      <FinderEye row={0} col={size - FINDER_SIZE_MODULES} />
      <FinderEye row={size - FINDER_SIZE_MODULES} col={0} />
    </svg>
  );
});

/** A plain band, deliberately: it does not move with the code's remaining life. */
function TileFrame() {
  const side = 100 - FRAME_CENTRE_INSET_PERCENT * 2;
  return (
    <svg
      viewBox="0 0 100 100"
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      <rect
        x={FRAME_CENTRE_INSET_PERCENT}
        y={FRAME_CENTRE_INSET_PERCENT}
        width={side}
        height={side}
        rx={FRAME_RADIUS_PERCENT}
        strokeWidth={FRAME_STROKE_PERCENT}
        data-testid="link-phone-tile-frame"
        className="fill-none stroke-border"
      />
    </svg>
  );
}

/** The square the tile always occupies. Both states render it, so the panel's height is the same before and
 * after a code arrives. */
function TileFootprint(props: {
  readonly state: "code" | "loading";
  readonly children: ReactElement;
}) {
  return (
    <div
      className="relative aspect-square w-full max-w-64"
      data-testid="link-phone-qr-tile"
      data-tile-state={props.state}
    >
      {props.children}
      <TileFrame />
    </div>
  );
}

export function LinkPhoneQrTile(props: {
  /** Null while a code is being minted - the footprint is held either way. */
  readonly code: string | null;
  /** Passed in rather than derived here so the tile stays a pure renderer and a dev build's QR can never address
   * production. */
  readonly platformBaseUrl: string | null;
}) {
  const platformBaseUrl = props.platformBaseUrl;
  const code = props.code;
  const symbol = useMemo(
    () =>
      code === null || platformBaseUrl === null
        ? null
        : encodeQrSymbol(platformBaseUrl, code),
    [code, platformBaseUrl],
  );
  if (symbol === null) {
    return (
      <TileFootprint state="loading">
        <div
          className="absolute inset-0"
          data-testid="link-phone-qr-placeholder"
        >
          {/* The paper's own geometry, so the frame sits on this edge too. */}
          <Skeleton
            className="absolute"
            style={{
              inset: `${FRAME_CENTRE_INSET_PERCENT}%`,
              borderRadius: `${FRAME_RADIUS_PERCENT}%`,
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          </div>
        </div>
      </TileFootprint>
    );
  }
  return (
    <TileFootprint state="code">
      <div
        // Keyed on the code so a rotation mounts a fresh tile and fades it in
        // instead of swapping the matrix under the user.
        key={props.code}
        className={cn(
          "absolute inset-0",
          "animate-in fade-in-0 duration-500 motion-reduce:animate-none",
        )}
        data-testid="link-phone-qr-surface"
      >
        <QrSymbolSvg symbol={symbol} />
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            aria-hidden="true"
            // 22% of the tile's width: the covered area sits well inside level
            // H's recovery budget, and the ink matches the symbol's own.
            className="flex aspect-square w-[22%] items-center justify-center rounded-[28%]"
            style={{ backgroundColor: QR_INK }}
          >
            <BrandMark className="h-auto w-[56%]" />
          </div>
        </div>
      </div>
    </TileFootprint>
  );
}
