/**
 * Consistent formatting for the live resource metrics carried by
 * `resources.subscribe`. Shared by every owner chip and the epic aggregate so a
 * CPU / memory / process reading reads the same everywhere.
 *
 * `cpuPercent` is host-local instantaneous CPU over the sampling interval and
 * may exceed 100 on a multi-core host - it is rendered verbatim, never clamped.
 * `rssBytes` is summed resident set across the owner's process tree.
 */

export function formatCpuPercent(cpuPercent: number): string {
  if (!Number.isFinite(cpuPercent) || cpuPercent <= 0) return "0%";
  if (cpuPercent >= 10) return `${Math.round(cpuPercent)}%`;
  return `${cpuPercent.toFixed(1)}%`;
}

const MEMORY_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatMemoryBytes(rssBytes: number): string {
  if (!Number.isFinite(rssBytes) || rssBytes <= 0) return "0 B";
  let value = rssBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < MEMORY_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = MEMORY_UNITS[unitIndex];
  if (unitIndex === 0 || value >= 100) return `${Math.round(value)} ${unit}`;
  return `${value.toFixed(1)} ${unit}`;
}

export function formatProcessCount(processCount: number): string {
  if (!Number.isFinite(processCount) || processCount <= 0) return "0";
  return `${Math.floor(processCount)}`;
}
