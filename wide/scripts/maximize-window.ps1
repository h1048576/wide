param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,
    [ValidateSet('', 'codex', 'droid', 'zcode', 'workbuddy', 'dsh', 'qoder', 'paseo')]
    [string]$ApplicationId = '',
    [ValidateRange(1, 60)]
    [int]$Seconds = 45
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'application-processes.ps1')
$scope = Get-WideApplicationScope $ExecutablePath $ApplicationId

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Wide {
    public static class StartupWindow {
        private delegate bool EnumWindowCallback(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")]
        private static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
        private static extern int GetWindowLong(IntPtr window, int index);
        [DllImport("user32.dll")]
        private static extern bool IsZoomed(IntPtr window);
        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")]
        private static extern bool ShowWindowAsync(IntPtr window, int command);

        public static bool Maximize(int[] processIds) {
            var ids = new HashSet<int>(processIds);
            int matched = 0;
            bool complete = true;
            EnumWindows(delegate(IntPtr window, IntPtr parameter) {
                uint processId;
                GetWindowThreadProcessId(window, out processId);
                // 只处理该应用可最大化的主窗口，跳过启动画面、弹窗和工具窗口。
                if (!ids.Contains((int)processId) || !IsWindowVisible(window) ||
                    GetWindow(window, 4) != IntPtr.Zero ||
                    (GetWindowLong(window, -16) & 0x00010000) == 0) return true;
                matched++;
                if (!IsZoomed(window) || IsIconic(window)) {
                    ShowWindowAsync(window, 3);
                    complete = false;
                }
                return true;
            }, IntPtr.Zero);
            return matched > 0 && complete;
        }
    }
}
'@

$deadline = (Get-Date).AddSeconds($Seconds)
$maximizedSince = $null
do {
    $ids = @(Get-Process -Name $scope.ProcessName -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if (Test-WideApplicationExecutable $scope $_.Path) { $_.Id }
        } catch { }
    })
    if ($ids.Count -gt 0 -and [Wide.StartupWindow]::Maximize([int[]]$ids)) {
        if (-not $maximizedSince) { $maximizedSince = Get-Date }
        # 等窗口恢复启动布局后再次确认，避免一次异步最大化就提前报告成功。
        if (((Get-Date) - $maximizedSince).TotalSeconds -ge 1) { exit 0 }
    } else { $maximizedSince = $null }
    Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)

throw '等待应用主窗口最大化超时。'
