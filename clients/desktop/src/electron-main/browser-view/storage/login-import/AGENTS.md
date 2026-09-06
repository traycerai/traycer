# Login import

Read `import-logins.ts` (header: three rules) before changing this folder.

1. The SCAN never opens a keystore. The only OS prompt fires on Import, after the dialog has named which one.
2. Every failure is a RESULT VALUE with a closed reason. A rejected invoke's message reaches WARN and Sentry; a cookie, a profile path, or a keychain answer must never travel that way.
3. The write runs under `BrowserJarSerializer`'s whole-jar barrier FROM THE USER'S CONFIRMATION ON, with `suppressAllBrowserPrimaryProfileDeltas`, then main pushes the jar itself (`capturePrimaryProfileOnEveryHost()`).

Also:

- Confirm in main (`confirmDestructiveInMain`) before anything is read.
- Readers are pure functions over bytes plus an injected secret provider, so suites never touch a keystore.
- `readBoundedFile` / SQLite snapshots: open non-blocking, refuse on the HANDLE, cap size during copy.
- Windows DPAPI: spawn PowerShell by its absolute System32 path, never a name `PATH` resolves.
- A site is written BEFORE anything of it is removed; recovery passes run whatever ended the removals.
- The forget ledger is recorded per site before that site's first removal.
- `node:sqlite` is the reader (ships with Electron). Do not add Electron-native SQLite / `better-sqlite3` rebuilds in this shell.
