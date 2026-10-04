param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,
    [ValidateSet('', 'codex', 'droid', 'zcode', 'workbuddy', 'dsh', 'qoder', 'paseo')]
    [string]$ApplicationId = '',
    [string]$RendererPath,
    [int]$ProtectedProcessId
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'application-processes.ps1')
$scope = Get-WideApplicationScope $ExecutablePath $ApplicationId
$tracked = @{}
$stopFailures = @{}

function Get-OwnedProcesses {
    $snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $protectedExecutable = ($snapshot | Where-Object { $_.ProcessId -eq $ProtectedProcessId } | Select-Object -First 1).ExecutablePath
    $excluded = @{}
    foreach ($processInfo in $snapshot) {
        if ($processInfo.ProcessId -eq $PID -or ($protectedExecutable -and [String]::Equals($processInfo.ExecutablePath, $protectedExecutable, [StringComparison]::OrdinalIgnoreCase))) {
            $excluded[$processInfo.ProcessId] = $true
        }
    }
    $owned = @{}
    foreach ($processInfo in $snapshot) {
        if ($excluded.ContainsKey($processInfo.ProcessId)) { continue }
        $sameApplication = Test-WideApplicationExecutable $scope $processInfo.ExecutablePath
        # 仅停止使用 wide 专属 Renderer 启动的 CodexHost 监管器。
        $sameHost = $RendererPath -and $processInfo.Name -match '^(powershell|pwsh|node|codexhost)\.exe$' -and
            $processInfo.CommandLine -match '(?i)codexhost' -and
            "$($processInfo.CommandLine)".IndexOf($RendererPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $knownProcess = $tracked.ContainsKey($processInfo.ProcessId) -and $tracked[$processInfo.ProcessId] -eq $processInfo.CreationDate
        if ($sameApplication -or $sameHost -or $knownProcess) { $owned[$processInfo.ProcessId] = $processInfo }
    }
    do {
        $changed = $false
        foreach ($processInfo in $snapshot) {
            if (-not $excluded.ContainsKey($processInfo.ProcessId) -and -not $owned.ContainsKey($processInfo.ProcessId) -and $owned.ContainsKey($processInfo.ParentProcessId) -and
                $processInfo.CreationDate -ge $owned[$processInfo.ParentProcessId].CreationDate) {
                $owned[$processInfo.ProcessId] = $processInfo
                $changed = $true
            }
        }
    } while ($changed)
    foreach ($processInfo in $owned.Values) { $tracked[$processInfo.ProcessId] = $processInfo.CreationDate }
    @($owned.Values)
}

function Stop-OwnedProcess([object]$ProcessInfo) {
    $process = Get-Process -Id $ProcessInfo.ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { return }
    try {
        if ($process.HasExited) { return }
        # CIM 创建时间精确到微秒，StartTime 精确到 100 纳秒；核对身份，避免 PID 复用。
        # 本地进程对象不再逐个查询 WMI，批量退出时也能及时完成。
        if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $ProcessInfo.CreationDate.ToUniversalTime()).Ticks) -ge 10) { return }
        Stop-Process -InputObject $process -Force -ErrorAction Stop
    }
    catch {
        # 进程可能正随父进程退出；先处理其他进程，最终只报告仍存活的进程。
        $stopFailures[$ProcessInfo.ProcessId] = [pscustomobject]@{ CreationDate = $ProcessInfo.CreationDate; Message = $_.Exception.Message }
    }
    finally { $process.Dispose() }
}

$running = @(Get-OwnedProcesses)
if ($running.Count -eq 0) { exit 0 }

# 先停专属监管器，避免桌面应用退出后被自动重新拉起。
if ($RendererPath) {
    foreach ($processInfo in $running) {
        if ($processInfo.Name -match '^(powershell|pwsh|node|codexhost)\.exe$' -and
            $processInfo.CommandLine -match '(?i)codexhost' -and
            "$($processInfo.CommandLine)".IndexOf($RendererPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Stop-OwnedProcess $processInfo
        }
    }
}

# 先请求正常关闭；关闭窗口后仍驻留后台的进程会在等待期结束后被完整结束。
foreach ($processInfo in $running) {
    try {
        $process = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) { [void]$process.CloseMainWindow() }
    } catch { }
}
$deadline = (Get-Date).AddSeconds(6)
do {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-OwnedProcesses)
    if ($remaining.Count -eq 0) { exit 0 }
} while ((Get-Date) -lt $deadline)

foreach ($processInfo in $remaining) { Stop-OwnedProcess $processInfo }
$deadline = (Get-Date).AddSeconds(3)
do {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-OwnedProcesses)
    if ($remaining.Count -eq 0) { exit 0 }
    foreach ($processInfo in $remaining) { Stop-OwnedProcess $processInfo }
} while ((Get-Date) -lt $deadline)

$remaining = @(Get-OwnedProcesses)
if ($remaining.Count -eq 0) { exit 0 }
$details = @($remaining | ForEach-Object {
    $failure = $stopFailures[$_.ProcessId]
    $message = if ($failure -and $failure.CreationDate -eq $_.CreationDate) { '：' + $failure.Message } else { '' }
    "$($_.Name)（PID $($_.ProcessId)）$message"
}) -join '；'
throw "应用仍有后台进程未退出：$details"
