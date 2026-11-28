export const WINDOWS_RESTORE_UNCONFIRMED =
  "The service start could not be confirmed. Retry with 'traycer host start'.";
export const WINDOWS_RESTORE_RECEIPT_WRITE_FAILED =
  "E_WINDOWS_RESTORE_RECEIPT_WRITE_FAILED";
export const WINDOWS_RESTORE_RECEIPT_WRITE_WARNING = `Could not record the unconfirmed Windows service start (${WINDOWS_RESTORE_RECEIPT_WRITE_FAILED}).`;

// A longer local manifest or receipt operation indicates a filesystem fault.
export const WINDOWS_FINALIZE_FILE_IO_MS = 30_000;
