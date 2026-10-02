# 启动入口与升级后的实际程序可能位于不同目录，只识别该安装下的已知版本布局。
function Get-WideApplicationScope([string]$ExecutablePath, [string]$ApplicationId) {
    $file = Get-Item -LiteralPath $ExecutablePath -ErrorAction Stop
    if ($file.PSIsContainer) { throw '应用路径不是可执行文件。' }
    $root = $file.DirectoryName
    $versionPattern = ''
    if ($ApplicationId -eq 'droid' -and $file.Name -match '(?i)^(?:factory-desktop|droid-desktop|Factory|Droid)\.exe$') {
        if ($file.Directory.Name -match '^app-[0-9][0-9A-Za-z.+_-]*$') { $root = $file.Directory.Parent.FullName }
        $versionPattern = 'app-[0-9][0-9A-Za-z.+_-]*'
    } elseif ($ApplicationId -eq 'qoder' -and $file.Name -match '(?i)^Qoder(?: CN)?\.exe$') {
        if ($file.Directory.Parent.Name -eq '.qoder-versions' -and $file.Directory.Name -match '^[0-9][0-9A-Za-z.+_-]*$') {
            $root = $file.Directory.Parent.Parent.FullName
        }
        $versionPattern = '\.qoder-versions\\[0-9][0-9A-Za-z.+_-]*'
    }
    $rootExecutable = Join-Path $root $file.Name
    $versionExecutablePattern = if ($versionPattern) {
        '^' + [Regex]::Escape($root.TrimEnd('\') + '\') + $versionPattern + '\\' + [Regex]::Escape($file.Name) + '$'
    } else { '' }
    [pscustomobject]@{
        Executable = $file.FullName
        RootExecutable = $rootExecutable
        ProcessName = $file.BaseName
        VersionExecutablePattern = $versionExecutablePattern
    }
}

function Test-WideApplicationExecutable([object]$Scope, [string]$Path) {
    if (-not $Path) { return $false }
    if ([String]::Equals($Path, $Scope.Executable, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if (-not $Scope.VersionExecutablePattern) { return $false }
    [String]::Equals($Path, $Scope.RootExecutable, [StringComparison]::OrdinalIgnoreCase) -or
        $Path -match $Scope.VersionExecutablePattern
}

function Test-WideApplicationRunning([string]$ExecutablePath, [string]$ApplicationId) {
    $scope = Get-WideApplicationScope $ExecutablePath $ApplicationId
    $processName = ($scope.ProcessName + '.exe').Replace("'", "''")
    foreach ($processInfo in @(Get-CimInstance Win32_Process -Filter "Name = '$processName'" -ErrorAction Stop)) {
        if (Test-WideApplicationExecutable $scope $processInfo.ExecutablePath) { return $true }
    }
    return $false
}
