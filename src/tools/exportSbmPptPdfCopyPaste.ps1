$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$outPath = Join-Path $projectRoot '.generated\SBM_PPT_PDF_COMPLETE_COPY_PASTE.txt'

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
foreach ($tool in $batchTools) {
  $files += "src\tools\$tool"
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

# Ordered list of (relativePath, content) pairs, built in the same order the
# receiving agent should recreate them: account templates, docs, manifest
# root files, then every platform's login.ts/poster.ts, then shared modules.
$entries = New-Object System.Collections.Generic.List[Object]

foreach ($platform in ($platforms | Sort-Object)) {
  $entries.Add([PSCustomObject]@{
    Path    = "account-templates\accounts-$platform.example.json"
    Content = $accountTemplate.Replace('PLATFORM', $platform)
  })
}

foreach ($relativePath in $files) {
  $source = Join-Path $projectRoot $relativePath
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Required source file missing: $relativePath"
  }
  $entries.Add([PSCustomObject]@{
    Path    = $relativePath
    Content = Get-Content -LiteralPath $source -Raw
  })
}

foreach ($platform in ($platforms | Sort-Object)) {
  foreach ($leaf in @('login.ts', 'poster.ts')) {
    $relativePath = "src\browser\$platform\$leaf"
    $source = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $source)) {
      throw "Required source file missing: $relativePath"
    }
    $entries.Add([PSCustomObject]@{
      Path    = $relativePath
      Content = Get-Content -LiteralPath $source -Raw
    })
  }
}

# SHA256SUMS section, computed from the same in-memory content so it always
# matches what's pasted below it (rather than re-reading disk a second time).
$sumsLines = foreach ($e in $entries) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($e.Content)
  $hash = [System.BitConverter]::ToString(
    [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  ).Replace('-', '')
  "$hash  $($e.Path)"
}

$out = New-Object System.Text.StringBuilder
[void]$out.AppendLine('SBM + PPT/PDF COMPLETE IMPLEMENTATION TRANSFER')
[void]$out.AppendLine('Generated from the current x-posting-agent source.')
[void]$out.AppendLine('Each section must be recreated at the exact relative path shown.')
[void]$out.AppendLine('Real credentials, .env, and .sessions are intentionally excluded.')
[void]$out.AppendLine('')

foreach ($e in $entries) {
  $slashPath = $e.Path.Replace('\', '/')
  [void]$out.AppendLine("==================== BEGIN FILE: $slashPath ====================")
  [void]$out.AppendLine($e.Content.TrimEnd())
  [void]$out.AppendLine("===================== END FILE: $slashPath =====================")
  [void]$out.AppendLine('')
}

[void]$out.AppendLine('==================== BEGIN FILE: SHA256SUMS.txt ====================')
foreach ($line in $sumsLines) { [void]$out.AppendLine($line) }
[void]$out.AppendLine('===================== END FILE: SHA256SUMS.txt =====================')

New-Item -ItemType Directory -Path (Split-Path $outPath) -Force | Out-Null
Set-Content -LiteralPath $outPath -Value $out.ToString() -Encoding utf8 -NoNewline

Write-Output "Copy-paste bundle written: $outPath"
Write-Output "Files included: $($entries.Count)"
