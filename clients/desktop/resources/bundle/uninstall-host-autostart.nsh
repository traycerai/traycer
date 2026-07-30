; Tears down the host's per-user autostart when Traycer is REMOVED through the
; OS-native route (Add/Remove Programs -> this NSIS uninstaller).
;
; WHY THIS FILE EXISTS
; -------------------
; The host does not auto-start from anything inside $INSTDIR. `traycer host
; service install` registers a per-user Scheduled Task `\Traycer\Host` whose
; action runs a launcher VBS under the user profile, so deleting the app
; directory removes the UI and leaves the host starting at every single logon,
; with no discoverable stop vector left (the task is `<Hidden>true</Hidden>`,
; and logon-trigger tasks are not listed in the Startup-apps panel).
;
; Settings -> "Remove Traycer" in the app already does a full, tested teardown
; via `traycer host uninstall --all`. This macro exists only for the users who
; never open Settings and remove the app the way Windows tells them to.
;
; WHY RAW COMMANDS AND NOT THE BUNDLED CLI
; ---------------------------------------
; `$INSTDIR\resources\cli\win32-x64\traycer.exe host uninstall --all` still
; exists at this point (files are deleted after `customUnInstall`) and would be
; the more complete teardown - it also kills an already-running host through a
; slot-scoped, pid-verified scan this macro deliberately does not attempt.
; It is not used because an uninstaller must be bounded and must not depend on
; the application's own binaries being functional: a user reaching for
; Add/Remove Programs is frequently doing so *because* the app is broken, and
; NSIS has no timeout for a child process that hangs. Every command below is a
; bounded OS utility, and each is best-effort - nothing here may fail the
; uninstall.
;
; Residue deliberately left: `%USERPROFILE%\.traycer` (chats, SQLite, models,
; credentials). Uninstalling an app does not destroy the user's data, and the
; CLI's own `host uninstall` has no destructive purge path either. The
; *execution* is what has to stop.
;
; Production identity is hardcoded because it is the only one that ships: the
; Windows release job runs `set-deploy-target.cjs --target=production`, and
; `set-deploy-target.cjs` defines no target that would produce a Windows
; installer under another label. The names below must stay in lockstep with
; `windowsTaskName()` in clients/traycer-cli/src/service/label.ts (production ->
; `\Traycer\Host`) and `hiddenHostLauncherPath()` in
; clients/traycer-cli/src/service/platforms/windows.ts, which resolves to
; `<cliInstallHomeDir("production")>\host-start-hidden.vbs` =
; `%USERPROFILE%\.traycer\cli\host-start-hidden.vbs`.

!macro customUnInstall
  ; THE UPDATE GUARD - the single most important line in this file.
  ;
  ; electron-builder runs the OLD uninstaller as part of an in-place update:
  ;   templates/nsis/include/installUtil.nsh
  ;     StrCpy $0 "$0 --updated"
  ;     ExecWait '"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir'
  ; and `customUnInstall` is inserted near the TOP of the un.Uninstall section,
  ; so it fires on every update as well as on a real removal. Without this
  ; guard, upgrading Traycer would silently delete the logon task and the host
  ; would stop starting after every update - a far worse defect than the one
  ; this file fixes.
  ;
  ; `--updated` is read directly rather than through electron-builder's
  ; `${isUpdated}` because the flag is verifiable from the invocation above,
  ; whereas `${isUpdated}` is defined in NSIS resources fetched at build time
  ; and cannot be inspected from this repo. `${GetParameters}`/`${GetOptions}`
  ; are the same idiom, and are already used bare a few lines below this
  ; insertion point in electron-builder's own uninstaller.nsh, so they are
  ; known-available in uninstaller context. $R0/$R1 are scratch here: that same
  ; code re-runs ClearErrors + GetParameters into them immediately afterwards.
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "--updated" $R1
  ${ifNot} ${Errors}
    DetailPrint "Traycer: in-place update - leaving the host autostart registered"
  ${else}
    DetailPrint "Traycer: removing the host autostart (Scheduled Task + launcher)"

    ; Stop the instance the task currently owns. This is not a complete stop -
    ; Task Scheduler does not job-object the tree, so a wrapper -> node child
    ; can survive as an orphan until reboot (see `killHostProcessTree` in
    ; windows.ts, which needs a pid-verified scan to do better). That orphan is
    ; harmless here: it holds no handle on $INSTDIR, so it cannot block this
    ; uninstall, and with the trigger deleted below it never comes back.
    nsExec::ExecToLog 'schtasks /End /TN "\Traycer\Host"'
    Pop $R0

    ; Delete the logon trigger. THIS is the fix - it is what stops the host
    ; coming back at every future logon.
    nsExec::ExecToLog 'schtasks /Delete /TN "\Traycer\Host" /F'
    Pop $R0

    ; Remove the launcher the task's action pointed at.
    Delete "$PROFILE\.traycer\cli\host-start-hidden.vbs"

    ; `schtasks /Delete` removes only the task; the `\Traycer` FOLDER it lived
    ; in survives and stays visible in the Task Scheduler tree. schtasks has no
    ; verb for folders, so this uses the same Schedule.Service COM call the CLI
    ; uninstall path already ships, and the same only-when-empty guard: a
    ; machine that also has a dev/staging host registered keeps its folder.
    ; Two quoting rules are load-bearing here:
    ;
    ;   1. `$$` emits a literal `$`, so PowerShell's own variables survive NSIS
    ;      variable expansion (`$s` would otherwise be read as an NSIS var).
    ;   2. The argument is delimited with BACKTICKS. NSIS accepts `"`, `'` and
    ;      backtick as string delimiters but has NO escape for the delimiter
    ;      itself - doubling it (`''`, the SQL/VB habit) does not escape it, it
    ;      ends the string early and silently mangles the command. PowerShell
    ;      needs both `"` and `'`, so the backtick form is the only one that
    ;      leaves them both literal.
    ;
    ; Wrapped in try/catch because GetFolder throws when the folder is already
    ; gone, which is a perfectly normal outcome here.
    nsExec::ExecToLog `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try{$$s=New-Object -ComObject Schedule.Service;$$s.Connect();$$f=$$s.GetFolder('\Traycer');if((@($$f.GetTasks(1)).Count -eq 0) -and (@($$f.GetFolders(0)).Count -eq 0)){$$s.GetFolder('\').DeleteFolder('Traycer',0)}}catch{}"`
    Pop $R0
  ${endIf}
!macroend
