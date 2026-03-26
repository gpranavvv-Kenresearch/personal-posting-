# Quick test script for coordinator-based agent system
# Run: .\test-system.ps1

Write-Host "🧪 Testing Coordinator-Based Agent System" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Check prerequisites
Write-Host "[1/5] Checking prerequisites..." -ForegroundColor Yellow

if (-not $env:ANTHROPIC_API_KEY) {
  Write-Host "❌ ANTHROPIC_API_KEY not set" -ForegroundColor Red
  exit 1
}

$nodeVersion = node --version 2>$null
if (-not $nodeVersion) {
  Write-Host "❌ Node.js not installed" -ForegroundColor Red
  exit 1
}

Write-Host "✅ Prerequisites OK" -ForegroundColor Green
Write-Host ""

# Test 1: Check environment
Write-Host "[2/5] Checking environment variables..." -ForegroundColor Yellow
$testVars = @("ANTHROPIC_API_KEY", "SERPAPI_KEY", "TAVILY_API_KEY")
foreach ($var in $testVars) {
  if (-not (Get-Item "env:$var" -ErrorAction SilentlyContinue)) {
    Write-Host "⚠️  $var not set (optional for some tests)" -ForegroundColor Yellow
  } else {
    Write-Host "✅ $var set" -ForegroundColor Green
  }
}
Write-Host ""

# Test 2: Check accounts
Write-Host "[3/5] Checking X accounts..." -ForegroundColor Yellow
if (Test-Path ".sessions/accounts.json") {
  Write-Host "✅ Accounts file exists" -ForegroundColor Green
} else {
  Write-Host "⚠️  No accounts file found" -ForegroundColor Yellow
  Write-Host "   Run: npx tsx src/config/accounts.ts add" -ForegroundColor Yellow
}
Write-Host ""

# Test 3: Test imports
Write-Host "[4/5] Testing module imports..." -ForegroundColor Yellow

$testImportScript = @"
import { executeSeoTool } from './src/tools/seoTools.js';
import { executeContentTool } from './src/tools/contentTools.js';
import { runSeoAnalysis } from './src/agents/seoAgentNew.js';
import { runMasterCoordinator } from './src/coordinator/masterCoordinator.js';
console.log('✅ All imports successful');
"@

$testImportFile = [System.IO.Path]::Combine($env:TEMP, 'test-imports.ts')
Set-Content -Path $testImportFile -Value $testImportScript

$importOutput = npx tsx $testImportFile 2>&1
if ($importOutput -match "✅") {
  Write-Host "✅ All imports OK" -ForegroundColor Green
} else {
  Write-Host "❌ Import error - check module paths" -ForegroundColor Red
  Write-Host $importOutput -ForegroundColor Red
  exit 1
}
Write-Host ""

# Test 4: Node version
Write-Host "[5/5] Checking Node version..." -ForegroundColor Yellow
Write-Host "Node.js version: $nodeVersion" -ForegroundColor Green
Write-Host ""

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "✅ System checks complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Review TESTING_GUIDE.md for detailed tests" -ForegroundColor White
Write-Host "  2. Run: npx tsx tests/test-seo-agent.ts (to test SEO agent)" -ForegroundColor White
Write-Host "  3. Run: npm run dev (to start coordinator daemon)" -ForegroundColor White
Write-Host ""
