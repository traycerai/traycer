Option Explicit
Dim shell
Dim exitCode
Dim commandLine
Dim probeStatus
Dim adoptionCapabilityStatus
Dim nonceProbe
Dim adoptionNonce
Dim noncePattern
Set shell = CreateObject("WScript.Shell")
commandLine = """C:\Users\golden-user\.traycer\cli\bin\traycer.exe"" ""host"" ""start"""
On Error Resume Next
probeStatus = shell.Run("""C:\Users\golden-user\.traycer\cli\bin\traycer.exe"" ""host"" ""capabilities"" ""--has"" ""service-label""", 0, True)
If Err.Number <> 0 Then probeStatus = 1
Err.Clear
On Error Goto 0
If probeStatus = 0 Then
  adoptionNonce = ""
  On Error Resume Next
  adoptionCapabilityStatus = shell.Run("""C:\Users\golden-user\.traycer\cli\bin\traycer.exe"" ""host"" ""capabilities"" ""--has"" ""host-start-adoption-v2""", 0, True)
  If Err.Number <> 0 Then adoptionCapabilityStatus = 1
  Err.Clear
  If adoptionCapabilityStatus = 0 Then
    Set nonceProbe = shell.Exec("""C:\Users\golden-user\.traycer\cli\bin\traycer.exe"" ""host"" ""adoption-nonce"" ""--service-label"" ""ai.traycer.host""")
    If Err.Number = 0 Then
      Do While nonceProbe.Status = 0
        WScript.Sleep 10
      Loop
      If nonceProbe.ExitCode = 0 Then adoptionNonce = Trim(Replace(Replace(nonceProbe.StdOut.ReadAll, vbCr, ""), vbLf, ""))
    End If
  End If
  Err.Clear
  On Error Goto 0
  Set noncePattern = New RegExp
  noncePattern.Pattern = "^[0-9A-Fa-f-]{36}$"
  If noncePattern.Test(adoptionNonce) Then
    commandLine = """C:\Users\golden-user\.traycer\cli\bin\traycer.exe"" ""host"" ""start"" ""--service-label"" ""ai.traycer.host""" & " --adoption-nonce " & Chr(34) & adoptionNonce & Chr(34)
  Else
    commandLine = """C:\Users\golden-user\.traycer\cli\bin\traycer.exe"" ""host"" ""start"" ""--service-label"" ""ai.traycer.host"""
  End If
End If
Dim attempts
attempts = 0
Do
  exitCode = shell.Run(commandLine, 0, True)
  attempts = attempts + 1
Loop While exitCode = 75 And attempts < 3
WScript.Quit exitCode
