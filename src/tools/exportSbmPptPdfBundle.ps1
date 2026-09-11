$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$outputRoot = Join-Path $projectRoot '.generated\sbm-ppt-pdf-complete-transfer'
$zipPath = Join-Path $projectRoot '.generated\sbm-ppt-pdf-complete-transfer.zip'

if (Test-Path -LiteralPath $outputRoot) {
  throw "Output directory already exists: $outputRoot"
}
if (Test-Path -LiteralPath $zipPath) {
  throw "Output archive already exists: $zipPath"
}

$platforms = @(
  'pearltrees', 'instapaper', 'raindrop', 'tumblr', 'hatena',
  'pdfhost', 'fliphtml5', 'fourshared', 'scribd', 'yumpu',
  'issuu', 'speakerdeck', 'slideshare'
)

$files = @(
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'src\agents\contentAgentNew.ts',
  'src\agents\slideshareBatchAgentNew.ts',
  'src\browser\stagehand.ts',
  'src\browser\popupGuard.ts',
  'src\browser\resilientBrowser.ts',
  'src\config\openRouterClient.ts',
  'src\config\settings.ts',
  'src\coordinator\masterCoordinator.ts',
  'src\errorInterceptor.ts',
  'src\autoFix.ts',
  'src\scheduler-new.ts',
  'src\sheets\sheets.ts',
  'src\tools\browserTools.ts',
  'src\tools\generateFiles.ts',
  'src\tools\generateNPdfs.ts',
  'src\tools\testPoster.ts',
  'src\tools\uploadPdfToDropbox.ts',
  'src\tools\dropboxRefreshSetup.ts',
  'src\utils\contentConverter.ts',
  'src\utils\dropboxUpload.ts',
  'src\utils\killChrome.ts',
  'src\utils\pptGenerator.ts',
  'src\utils\utm.ts',
  'docs\SBM_PPT_PDF_AGENT_HANDOFF.md'
)

$batchTools = @(
  'runPearltreesBatch.ts', 'runInstapaperBatch.ts', 'runRaindropBatch.ts',
  'runPdfhostBatch.ts', 'runFliphtml5Batch.ts', 'runFourSharedBatch.ts',
  'runHatenaBatch.ts', 'runScribdBatch.ts', 'runYumpuBatch.ts',
  'runIssuuBatch.ts', 'runSlideshareRow.ts'
)

New-Item -ItemType Directory -Path $outputRoot | Out-Null

foreach ($platform in $platforms) {
  $source = Join-Path $projectRoot "src\browser\$platform"
  $destination = Join-Path $outputRoot "src\browser\$platform"
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $source 'login.ts') -Destination $destination
  Copy-Item -LiteralPath (Join-Path $source 'poster.ts') -Destination $destination
}

foreach ($tool in $batchTools) {
  $files += "src\tools\$tool"
}

foreach ($relativePath in $files) {
  $source = Join-Path $projectRoot $relativePath
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Required source file missing: $relativePath"
  }
  $destination = Join-Path $outputRoot $relativePath
  New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination
}

$accountTemplate = @'
[
  {
    "nickname": "must-match-sheet-row-name",
    "email": "replace-me@example.com",
    "password": "TRANSFER-SEPARATELY-DO-NOT-COMMIT",
    "active": true,
    "sessionDir": ".sessions/PLATFORM/must-match-sheet-row-name"
  }
]
'@

$templateRoot = Join-Path $outputRoot 'account-templates'
New-Item -ItemType Directory -Path $templateRoot -Force | Out-Null
foreach ($platform in $platforms) {
  $accountTemplate.Replace('PLATFORM', $platform) |
    Set-Content -LiteralPath (Join-Path $templateRoot "accounts-$platform.example.json") -Encoding utf8
}

$manifest = Get-ChildItem -Path $outputRoot -File -Recurse |
  ForEach-Object {
    $relative = $_.FullName.Substring($outputRoot.Length + 1)
    $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    "$hash  $relative"
  }
$manifest | Set-Content -LiteralPath (Join-Path $outputRoot 'SHA256SUMS.txt') -Encoding utf8

Compress-Archive -Path (Join-Path $outputRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal

Write-Output "Bundle directory: $outputRoot"
Write-Output "Bundle archive:   $zipPath"
Write-Output "Files packaged:   $((Get-ChildItem -Path $outputRoot -File -Recurse).Count)"
