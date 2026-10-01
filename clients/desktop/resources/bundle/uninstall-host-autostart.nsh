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
; A descriptor-stamped release include overrides these values. The defaults
; preserve the historical production package command exactly.
!ifndef TRAYCER_WINDOWS_TASK_NAME
!define TRAYCER_WINDOWS_TASK_NAME "\Traycer\Host"
!endif
!ifndef TRAYCER_WINDOWS_TASK_FOLDER
!define TRAYCER_WINDOWS_TASK_FOLDER "Traycer"
!endif
!ifndef TRAYCER_HOST_LAUNCHER
!define TRAYCER_HOST_LAUNCHER "$PROFILE\.traycer\cli\host-start-hidden.vbs"
!endif

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

    ; WHOSE TASK IS IT - asked before any of the three writes below, and each
    ; one runs only on the answer. The task name is machine-global: every
    ; Windows account that runs Traycer names the same task, but it belongs to
    ; the account in its principal. An uninstaller elevated as an admin (a
    ; per-machine install, or an admin removing it) holds, by the default task
    ; DACL, the right to end and delete ANOTHER user's task - which would take
    ; that user's host autostart away. So the task is ended and deleted only
    ; when its principal is the account running this uninstaller (the CLI's
    ; ownership gate, `windows-task-gate.ts`, is the same rule), and the folder
    ; is emptied only when the task is gone or was that account's. Everything
    ; else - the app, this account's launcher - is still removed.
    ;
    ; The probe, a PowerShell bounded by nsExec's /TIMEOUT (a stalled
    ; Schedule.Service RPC or account lookup answers `timeout`, which is not 0
    ; or 2), exits:
    ;   0  the task is this account's        -> end it, delete it, folder
    ;   2  there is no such task, or no such  -> folder only
    ;      folder (0x80070002 / 0x80070003)
    ;   3  the task is another user's        -> none of the three
    ;   4  the task or its principal could    -> none of the three (fail closed:
    ;      not be read (access denied too),      not provably this account's)
    ;      or did not resolve to a SID
    ; and anything else (nsExec's `error`, a killed PowerShell) is not 0 or 2,
    ; so it too leaves the task alone. The principal is compared as a SID; a
    ; principal that reads back as an account name is resolved to one first.
    ; Nothing about either account is printed. `$R1` holds the answer: the
    ; same code re-runs GetParameters into it right after this macro.
    nsExec::ExecToLog /TIMEOUT=30000 `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try{$$s=New-Object -ComObject Schedule.Service;$$s.Connect()}catch{exit 4};try{$$t=$$s.GetFolder('\').GetTask('${TRAYCER_WINDOWS_TASK_NAME}')}catch{$$e=$$_.Exception;if($$e.InnerException){$$e=$$e.InnerException};if(($$e.HResult -eq -2147024894) -or ($$e.HResult -eq -2147024893)){exit 2};exit 4};try{$$u=[string]$$t.Definition.Principal.UserId;if($$u -notmatch '^S-1-[0-9]+(-[0-9]+)+$$'){$$u=(New-Object System.Security.Principal.NTAccount($$u)).Translate([System.Security.Principal.SecurityIdentifier]).Value};$$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;if($$u -ieq $$me){exit 0};exit 3}catch{exit 4}"`
    Pop $R1

    ${if} $R1 == "0"
      ; Stop the instance the task currently owns. This is not a complete stop -
      ; Task Scheduler does not job-object the tree, so a wrapper -> node child
      ; can survive as an orphan until reboot (see `killHostProcessTree` in
      ; windows.ts, which needs a pid-verified scan to do better). That orphan is
      ; harmless here: it holds no handle on $INSTDIR, so it cannot block this
      ; uninstall, and with the trigger deleted below it never comes back.
      nsExec::ExecToLog 'schtasks /End /TN "${TRAYCER_WINDOWS_TASK_NAME}"'
      Pop $R0

      ; Delete the logon trigger. THIS is the fix - it is what stops the host
      ; coming back at every future logon.
      nsExec::ExecToLog 'schtasks /Delete /TN "${TRAYCER_WINDOWS_TASK_NAME}" /F'
      Pop $R0
    ${elseIf} $R1 != "2"
      DetailPrint "Traycer: the host's Scheduled Task is owned by another user; leaving it in place"
    ${endIf}

    ; Remove the launcher this account's task pointed at. It lives under THIS
    ; account's profile whoever owns the task, so it goes either way.
    Delete "${TRAYCER_HOST_LAUNCHER}"

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
    ; gone, which is a perfectly normal outcome here. Only after the task above
    ; was this account's and is deleted, or was never there (the ownership
    ; probe's 0 or 2): a folder still holding another user's task is theirs.
    ${if} $R1 == "0"
    ${orIf} $R1 == "2"
      nsExec::ExecToLog `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try{$$s=New-Object -ComObject Schedule.Service;$$s.Connect();$$f=$$s.GetFolder('\${TRAYCER_WINDOWS_TASK_FOLDER}');if((@($$f.GetTasks(1)).Count -eq 0) -and (@($$f.GetFolders(0)).Count -eq 0)){$$s.GetFolder('\').DeleteFolder('${TRAYCER_WINDOWS_TASK_FOLDER}',0)}}catch{}"`
      Pop $R0
    ${endIf}
  ${endIf}
!macroend
