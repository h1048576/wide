param(
    [switch]$DetectOnly,
    [string]$ExecutablePath,
    [ValidatePattern('^(?:auto|fit-content|(?:0|[1-9][0-9]{0,3})(?:\.[0-9]+)?(?:px|rem|em|vw|vh|%))$')]
    [string]$Width = '70vw',
    [ValidatePattern('^(?:none|(?:0|[1-9][0-9]{0,3})(?:\.[0-9]+)?(?:px|rem|em|vw|vh|%))$')]
    [string]$MaxWidth = '90rem',
    [ValidatePattern('^(?:auto|(?:0|[1-9][0-9]{0,3})(?:\.[0-9]+)?(?:px|rem|em|vh|%))$')]
    [string]$ChatHeight = '80px',
    [ValidateScript({ $_ -and $_ -notmatch '[;{}<>\r\n]' })]
    [string]$FontFamily = 'Cascadia Mono, LXGW WenKai Mono',
    [ValidateRange(8, 72)]
    [int]$FontSize = 17,
    [ValidateRange(100, 1000)]
    [int]$FontWeight = 300,
    [ValidateRange(1024, 65535)]
    [int]$Port = 9335,
    [switch]$Normal
)

$ErrorActionPreference = 'Stop'

function Get-DshApplication {
    if ($ExecutablePath) {
        $file = Get-Item -LiteralPath $ExecutablePath -ErrorAction Stop
        if ($file.PSIsContainer -or $file.Name -ne 'DeepSeek Harness.exe') { throw '请选择官方 DeepSeek Harness 桌面应用的可执行文件。' }
    } else {
        $candidates = New-Object 'System.Collections.Generic.List[string]'
        foreach ($processInfo in @(Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" -ErrorAction SilentlyContinue)) {
            if ($processInfo.ExecutablePath) { $candidates.Add($processInfo.ExecutablePath) }
        }
        $uninstallRoots = @(
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
        )
        foreach ($entry in @(Get-ItemProperty -Path $uninstallRoots -ErrorAction SilentlyContinue | Where-Object { "$($_.DisplayName)" -match '(?i)^DeepSeek Harness(?:\s|$)' })) {
            $displayIcon = "$($entry.DisplayIcon)".Trim()
            if ($displayIcon -match '^"([^"]+\.exe)"') { $candidates.Add($matches[1]) }
            elseif ($displayIcon -match '^(.+?\.exe)(?:,\d+)?$') { $candidates.Add($matches[1]) }
            if ($entry.InstallLocation) { $candidates.Add((Join-Path "$($entry.InstallLocation)".Trim().Trim('"') 'DeepSeek Harness.exe')) }
        }
        foreach ($root in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
            if (-not $root) { continue }
            foreach ($relative in @('DeepSeek Harness\DeepSeek Harness.exe', 'Programs\DeepSeek Harness\DeepSeek Harness.exe', 'deepseek-harness\DeepSeek Harness.exe', 'Programs\deepseek-harness\DeepSeek Harness.exe')) {
                $candidates.Add((Join-Path $root $relative))
            }
        }
        $found = $candidates | Where-Object { $_ -and [IO.Path]::GetFileName($_) -eq 'DeepSeek Harness.exe' -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique -First 1
        if (-not $found) { throw '没有找到官方 DeepSeek Harness 桌面应用，请先安装或手动选择应用路径。' }
        $file = Get-Item -LiteralPath $found -ErrorAction Stop
    }
    $version = "$($file.VersionInfo.ProductVersion)".Trim()
    if (-not $version) { $version = "$($file.VersionInfo.FileVersion)".Trim() }
    if (-not $version) { $version = '未知版本' }
    [pscustomobject]@{ ApplicationName = 'DeepSeek Harness'; Executable = $file.FullName; InstallRoot = $file.DirectoryName; Version = $version }
}

function Select-DshPort([int]$Preferred) {
    for ($candidate = $Preferred; $candidate -le [Math]::Min(65535, $Preferred + 50); $candidate++) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
        try {
            $listener.Start()
            return $candidate
        } catch { } finally { $listener.Stop() }
    }
    throw "从 $Preferred 开始的 51 个本地端口都不可用，请修改调试端口。"
}

try {
    $application = Get-DshApplication
    if ($DetectOnly) {
        $application | Select-Object ApplicationName, Executable, Version | ConvertTo-Json -Compress
        exit 0
    }

    # DSH 的关闭窗口动作会隐藏到托盘；复用完整进程树退出逻辑以关闭 Host 子进程。
    & (Join-Path (Split-Path -Parent $PSScriptRoot) 'quit-application.ps1') -ExecutablePath $application.Executable -ApplicationId 'dsh' -ProtectedProcessId $PID
    $launch = @{ FilePath = $application.Executable; WorkingDirectory = $application.InstallRoot; ErrorAction = 'Stop' }
    if (-not $Normal) {
        $Port = Select-DshPort $Port
        $launch.ArgumentList = @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$Port")
        if ($env:WIDE_PROGRESS_STREAM -eq '1') { [Console]::WriteLine("[DSH Wide] 正在启动 DeepSeek Harness（CDP 端口 $Port）…") }
        else { Write-Host "[DSH Wide] 正在启动 DeepSeek Harness（CDP 端口 $Port）…" }
    }
    Start-Process @launch | Out-Null
    # 样式注入及刷新、新窗口的持续守护由 wide 主进程处理。
    exit 0
} catch {
    Write-Host "[DSH Wide] 失败：$($_.Exception.Message)"
    exit 1
}
