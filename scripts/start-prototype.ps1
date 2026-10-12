param(
  [int]$Port = 20701,
  [string]$DataDir = (Join-Path (Split-Path $PSScriptRoot -Parent) '..\mausbot-real-prototype')
)

$ErrorActionPreference = 'Stop'
if ($Port -lt 1024 -or $Port -gt 65534) { throw 'Port must be between 1024 and 65534.' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dataRoot = [IO.Path]::GetFullPath($DataDir)
$demoHome = Join-Path $dataRoot 'home'
$codexHome = Join-Path $demoHome '.codex'
$command = Get-Command opencode.cmd -ErrorAction Stop
$opencodeExe = Join-Path (Split-Path $command.Source) 'node_modules\@opencode\cli\bin\opencode.exe'
if (-not (Test-Path -LiteralPath $opencodeExe)) { throw "OpenCode executable not found: $opencodeExe" }
$codexCommand = Get-Command codex.cmd -ErrorAction SilentlyContinue
$codexCli = if ($codexCommand) { $codexCommand.Source } else { 'codex' }
$claudeExe = [IO.Path]::GetFullPath((Join-Path $repoRoot '..\mausbot-tools\node_modules\@anthropic-ai\claude-code\bin\claude.exe'))
$claudeCli = if (Test-Path -LiteralPath $claudeExe) { $claudeExe } else { 'claude' }
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
$codexConfig = Join-Path $codexHome 'config.toml'
if (-not (Test-Path -LiteralPath $codexConfig)) {
  [IO.File]::WriteAllText($codexConfig, "[windows]`nsandbox = `"elevated`"`n", (New-Object System.Text.UTF8Encoding($false)))
}

$configPath = Join-Path $dataRoot 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  $config = @{ instances = @{
    opencode = @{ driver = 'opencodeGo'; displayName = 'OpenCode free'; config = @{ cli = $opencodeExe } }
    'codex-runtime' = @{ driver = 'codex'; displayName = 'Codex'; config = @{ cli = $codexCli; authMode = 'browser-cli' }; environment = @{ CODEX_HOME = $codexHome } }
    'claude-runtime' = @{ driver = 'claudeAgent'; displayName = 'Claude Code'; config = @{ cli = $claudeCli } }
  } }
  $json = $config | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$env:OMB_DATA_DIR = $dataRoot
$env:OMB_PORT = [string]$Port
$env:OMB_WEBHOOK_PORT = [string]($Port + 1)
$env:USERPROFILE = $demoHome
$env:APPDATA = Join-Path $demoHome 'AppData\Roaming'
$env:LOCALAPPDATA = Join-Path $demoHome 'AppData\Local'
$env:XDG_DATA_HOME = Join-Path $demoHome '.local\share'
$env:XDG_CONFIG_HOME = Join-Path $demoHome '.config'
$env:XDG_CACHE_HOME = Join-Path $demoHome '.cache'
foreach ($key in @('HOME', 'OPENCODE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'MINIMAX_API_KEY')) {
  Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue
}

Push-Location $repoRoot
try { node --experimental-strip-types server/index.ts }
finally { Pop-Location }
