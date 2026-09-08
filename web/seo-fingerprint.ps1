# Compatibility wrapper for the cross-platform fingerprint implementation.
param(
  [switch]$Save,
  [string]$Root,
  [string]$Baseline
)

$nodeArgs = @((Join-Path $PSScriptRoot 'scripts/seo-fingerprint.mjs'))
if ($Save) { $nodeArgs += '--save' }
if ($Root) { $nodeArgs += @('--root', $Root) }
if ($Baseline) { $nodeArgs += @('--baseline', $Baseline) }
& node @nodeArgs
exit $LASTEXITCODE
