$ErrorActionPreference = "Stop"

# A per-user Startup shortcut is reversible and does not require administrator
# privileges. Remove AnswerFrame.lnk from this folder to disable auto-start.
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot "Start-AnswerFrame.ps1"
$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupFolder "AnswerFrame.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = "Start the AnswerFrame local library"
$shortcut.WindowStyle = 7
$shortcut.Save()

& $launcher
Write-Output "AnswerFrame 已加入当前用户启动项：$shortcutPath"
