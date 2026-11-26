$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:CACHE_GUARD_REPO) { $env:CACHE_GUARD_REPO } else { "https://github.com/wingkit123/agy-cache-guard.git" }
$TargetDir = Join-Path $env:USERPROFILE ".gemini\config\plugins\cache-guard"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js >= 20 is required but 'node' was not found in PATH."
}

$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]") | Out-String).Trim()
if ($nodeMajor -lt 20) {
    throw "Node.js >= 20 is required (found v$nodeMajor)."
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is required for install.ps1."
}

$parentDir = Split-Path -Parent $TargetDir
if (-not (Test-Path $parentDir)) {
    New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
}

if (Test-Path (Join-Path $TargetDir ".git")) {
    Write-Host "Updating existing cache-guard installation..."
    git -C $TargetDir pull --ff-only
} elseif (Test-Path $TargetDir) {
    throw "Target directory already exists and is not a git repo: $TargetDir"
} else {
    Write-Host "Cloning cache-guard into $TargetDir..."
    git clone --depth 1 $RepoUrl $TargetDir
}

Push-Location $TargetDir
try {
    node tests/guard.test.mjs
} finally {
    Pop-Location
}

Write-Host "cache-guard installed successfully. Open a new Antigravity session to activate hooks."
