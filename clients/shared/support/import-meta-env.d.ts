// Local typing for the build-time env vars this shared module reads.
// Lives here (not in a Vite-only `vite-env.d.ts`) so non-Vite consumers
// — the host, the CLI, etc. — that pull this file in for type-checking
// still see a typed `import.meta.env` instead of erroring.
interface ImportMetaEnv {
  readonly VITE_TRAYCER_OSS_REPO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
