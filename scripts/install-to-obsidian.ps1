<#
.SYNOPSIS
    Installs the built RSS Dashboard plugin into an Obsidian vault.

.DESCRIPTION
    Copies main.js, styles.css, and manifest.json from the repository into
    <vault>\.obsidian\plugins\rss-dashboard\ and verifies each copy by hash.

    The default target vault is the one currently open in Obsidian (read from
    %APPDATA%\obsidian\obsidian.json). Use -VaultPath to target a specific
    vault, or -All to install into every known vault that already has the
    plugin folder. With -Reload, the plugin is reloaded through the Obsidian
    CLI so the new build takes effect immediately.

.EXAMPLE
    .\scripts\install-to-obsidian.ps1

.EXAMPLE
    .\scripts\install-to-obsidian.ps1 -VaultPath "D:\Doc\LifeFolder" -Reload

.EXAMPLE
    npm run install:obsidian
#>
[CmdletBinding()]
param(
    [string]$VaultPath,
    [switch]$All,
    [switch]$Reload
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "manifest.json") | ConvertFrom-Json
$pluginId = $manifest.id
if (-not $pluginId) {
    throw "manifest.json does not define an id; cannot determine the plugin folder name."
}

$artifactFiles = @("main.js", "styles.css", "manifest.json")
foreach ($file in $artifactFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $file))) {
        throw "Missing build artifact '$file'. Run 'npm run build' first."
    }
}

function Get-ObsidianConfigPath {
    $candidates = @()
    if ($env:APPDATA) { $candidates += Join-Path $env:APPDATA "obsidian\obsidian.json" }
    if ($env:USERPROFILE) { $candidates += Join-Path $env:USERPROFILE "AppData\Roaming\obsidian\obsidian.json" }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Get-FileHashCompat([string]$Path) {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "")
        } finally {
            $stream.Dispose()
        }
    } finally {
        $sha256.Dispose()
    }
}

function Get-ObsidianConfig {
    $configPath = Get-ObsidianConfigPath
    if (-not $configPath) { return $null }
    return Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
}

function Get-VaultPathsFromConfig($config) {
    if (-not $config -or -not $config.vaults) { return @() }
    return @($config.vaults.PSObject.Properties | ForEach-Object { $_.Value.path } | Where-Object { $_ })
}

function Get-PluginDir([string]$vaultPath) {
    return Join-Path $vaultPath ".obsidian\plugins\$pluginId"
}

$config = Get-ObsidianConfig
$targetVaults = @()
if ($All) {
    $targetVaults = Get-VaultPathsFromConfig $config
} elseif ($VaultPath) {
    $targetVaults = @($VaultPath)
} else {
    $openVaults = @()
    if ($config -and $config.vaults) {
        $openVaults = @($config.vaults.PSObject.Properties | Where-Object { $_.Value.open } | ForEach-Object { $_.Value.path })
    }
    if ($openVaults.Count -gt 0) {
        $targetVaults = @($openVaults[0])
    }
    if ($targetVaults.Count -eq 0 -or -not $targetVaults[0]) {
        throw "Could not detect the open vault. Pass -VaultPath '<path>' or -All."
    }
}

$installedVaults = @()
foreach ($vaultPath in $targetVaults) {
    $pluginDir = Get-PluginDir $vaultPath
    if (-not (Test-Path -LiteralPath $pluginDir)) {
        Write-Warning "Skipping '$vaultPath': plugin folder '$pluginDir' does not exist."
        continue
    }
    foreach ($file in $artifactFiles) {
        $source = Join-Path $repoRoot $file
        $target = Join-Path $pluginDir $file
        Copy-Item -LiteralPath $source -Destination $target -Force
        $sourceHash = Get-FileHashCompat $source
        $targetHash = Get-FileHashCompat $target
        if ($sourceHash -ne $targetHash) {
            throw "Copy verification failed for '$file' into '$pluginDir'."
        }
    }
    Write-Output "Installed $pluginId into $pluginDir"
    $installedVaults += $vaultPath
}

if ($Reload -and $installedVaults.Count -gt 0) {
    foreach ($vaultPath in $installedVaults) {
        $vaultName = Split-Path -Leaf $vaultPath
        Write-Output "Reloading $pluginId in vault '$vaultName'..."
        & obsidian "vault=$vaultName" "plugin:reload" "id=$pluginId"
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Obsidian CLI reload failed (exit $LASTEXITCODE). Ensure Obsidian is running and '$vaultName' is open."
        }
    }
}
