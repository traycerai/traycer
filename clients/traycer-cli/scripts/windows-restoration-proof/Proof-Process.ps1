function Write-ProofLine([string] $Line, [string] $TranscriptPath) {
    [Console]::WriteLine($Line)
    if ($TranscriptPath) {
        [IO.File]::AppendAllText($TranscriptPath, $Line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    }
}

function Invoke-ProofProcess {
    param(
        [string] $File,
        [string[]] $Arguments,
        [string] $Case,
        [int] $TimeoutMilliseconds,
        [string] $TranscriptPath
    )
    Write-ProofLine "BEGIN $Case" $TranscriptPath
    # The proof passes fixed options and Windows paths, which cannot contain quotes.
    $quoted = foreach ($argument in $Arguments) {
        if ($argument.Contains('"')) { throw 'A proof process argument contains a quote.' }
        '"' + ($argument -replace '(\\+)$', '$1$1') + '"'
    }
    $info = [Diagnostics.ProcessStartInfo]::new($File, ($quoted -join ' '))
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $process = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $exited = $process.WaitForExit($TimeoutMilliseconds)
        if (-not $exited) {
            try { $process.Kill() } catch {}
        }
        foreach ($stream in @(@{ Name = 'stdout'; Read = $stdout }, @{ Name = 'stderr'; Read = $stderr })) {
            if ($stream.Read.Wait(2000)) {
                foreach ($line in ($stream.Read.Result -split '\r?\n')) {
                    if ($line.Length -gt 0) {
                        Write-ProofLine "[$Case $($stream.Name)] $line" $TranscriptPath
                    }
                }
            } else {
                Write-ProofLine "[$Case $($stream.Name)] output stream did not close" $TranscriptPath
            }
        }
        if (-not $exited) {
            Write-ProofLine "END $Case timeout" $TranscriptPath
            throw "Proof process timed out: $Case"
        }
        $code = $process.ExitCode
        Write-ProofLine "END $Case exit=$code" $TranscriptPath
        if ($code -ne 0) { throw "Proof process failed: $Case (exit $code)" }
    } finally {
        $process.Dispose()
    }
}
