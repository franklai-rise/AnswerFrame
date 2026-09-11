$ErrorActionPreference = "Stop"

# Start the production-built AnswerFrame web UI only when it is not already
# listening. This keeps the extension usable without an open terminal.
$projectRoot = Split-Path -Parent $PSScriptRoot
$port = 5173

function Test-AnswerFramePort {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

if (-not (Test-AnswerFramePort)) {
  $webIndex = Join-Path $projectRoot "apps\web\dist\index.html"
  if (-not (Test-Path -LiteralPath $webIndex)) {
    $build = Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/s", "/c", "npm run build:web") -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru
    if ($build.ExitCode -ne 0) {
      throw "AnswerFrame 网页端构建失败，退出码 $($build.ExitCode)"
    }
  }

  Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/s", "/c", "npm run preview:web") -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null

  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    if (Test-AnswerFramePort) { break }
    Start-Sleep -Milliseconds 250
  }
}

if (-not (Test-AnswerFramePort)) {
  throw "AnswerFrame 网页端没有在 localhost:$port 启动"
}

Start-Process "http://localhost:$port/library"
