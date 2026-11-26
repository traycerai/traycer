import { useCallback, useEffect, useState, type ReactNode } from "react";
import { TerminalGridMeasureProbe } from "@/components/epic-canvas/renderers/terminal-grid-measure-probe";
import { MEASURE_GRID_TIMEOUT_MS } from "@/hooks/agent/use-terminal-tile-bootstrap";

interface ProtectedLandingTerminalTarget {
  readonly hostId: string;
  readonly terminalId: string;
  readonly instanceId: string;
}

interface LandingTerminalGrid {
  readonly cols: number;
  readonly rows: number;
}

interface GridMeasurement {
  readonly key: string | null;
  readonly grid: LandingTerminalGrid | null;
}

export const LANDING_TERMINAL_DEFAULT_GRID: LandingTerminalGrid = {
  cols: 80,
  rows: 24,
};

/** Measures a mounted protected request before its terminal is adopted. */
export function useProtectedLandingTerminalReadiness(
  input: ProtectedLandingTerminalTarget | null,
): { readonly probe: ReactNode; readonly grid: LandingTerminalGrid | null } {
  const key =
    input === null
      ? null
      : JSON.stringify([input.hostId, input.terminalId, input.instanceId]);
  const [measurement, setMeasurement] = useState<GridMeasurement>({
    key,
    grid: null,
  });
  if (measurement.key !== key) {
    setMeasurement({ key, grid: null });
  }
  const grid = measurement.key === key ? measurement.grid : null;

  const reportGrid = useCallback(
    (cols: number, rows: number): void => {
      if (
        measurement.key === null ||
        measurement.grid !== null ||
        !Number.isSafeInteger(cols) ||
        !Number.isSafeInteger(rows) ||
        cols <= 0 ||
        rows <= 0
      ) {
        return;
      }
      // A callback from a retired probe cannot settle a new measurement,
      // even if the same tab identity becomes eligible again.
      setMeasurement((current) => {
        if (current !== measurement) return current;
        return { key: current.key, grid: { cols, rows } };
      });
    },
    [measurement],
  );

  useEffect(() => {
    if (key === null || grid !== null) return;
    const timer = window.setTimeout(() => {
      reportGrid(
        LANDING_TERMINAL_DEFAULT_GRID.cols,
        LANDING_TERMINAL_DEFAULT_GRID.rows,
      );
    }, MEASURE_GRID_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [grid, key, reportGrid]);

  const probe =
    input === null ? null : (
      <TerminalGridMeasureProbe
        key={key}
        sessionId={input.terminalId}
        hostId={input.hostId}
        instanceId={input.instanceId}
        tileKind="terminal"
        chrome="flush"
        onMeasured={reportGrid}
      />
    );
  return { probe, grid };
}
