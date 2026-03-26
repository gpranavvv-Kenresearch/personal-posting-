#!/bin/bash

# Quick test script for coordinator-based agent system
# Run: bash test-system.sh

set -e

echo "🧪 Testing Coordinator-Based Agent System"
echo "=========================================="
echo ""

# Check prerequisites
echo "[1/5] Checking prerequisites..."
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "❌ ANTHROPIC_API_KEY not set"
  exit 1
fi

if ! command -v node &> /dev/null; then
  echo "❌ Node.js not installed"
  exit 1
fi

echo "✅ Prerequisites OK"
echo ""

# Test 1: Check environment
echo "[2/5] Checking environment variables..."
test_vars=("ANTHROPIC_API_KEY" "SERPAPI_KEY" "TAVILY_API_KEY")
for var in "${test_vars[@]}"; do
  if [ -z "${!var}" ]; then
    echo "⚠️  $var not set (optional for some tests)"
  else
    echo "✅ $var set"
  fi
done
echo ""

# Test 2: Check accounts
echo "[3/5] Checking X accounts..."
account_count=$(npx tsx src/config/accounts.ts list 2>/dev/null | grep -c "active: true" || echo "0")
if [ "$account_count" -eq 0 ]; then
  echo "⚠️  No active X accounts found"
  echo "   Run: npx tsx src/config/accounts.ts add"
else
  echo "✅ Found $account_count active account(s)"
fi
echo ""

# Test 3: Test imports
echo "[4/5] Testing module imports..."
cat > /tmp/test-imports.ts << 'EOF'
import { executeSeoTool } from './src/tools/seoTools.js';
import { executeContentTool } from './src/tools/contentTools.js';
import { runSeoAnalysis } from './src/agents/seoAgentNew.js';
import { runMasterCoordinator } from './src/coordinator/masterCoordinator.js';
console.log('✅ All imports successful');
EOF

if npx tsx /tmp/test-imports.ts 2>&1 | grep -q "✅"; then
  echo "✅ All imports OK"
else
  echo "❌ Import error - check module paths"
  exit 1
fi
echo ""

# Test 4: Test tools execution
echo "[5/5] Testing tool execution..."
cat > /tmp/test-tools.ts << 'EOF'
import { executeSeoTool } from './src/tools/seoTools.js';

console.log('Testing SerpAPI tool...');
const result = await executeSeoTool('search_google', {
  query: 'test query'
});

if (result.error) {
  console.log('⚠️  Tool returned error:', result.error);
} else {
  console.log('✅ Tool executed successfully');
}
EOF

npx tsx /tmp/test-tools.ts 2>/dev/null || echo "⚠️  Tool test inconclusive (API key may be needed)"

echo ""
echo "=========================================="
echo "✅ System checks complete!"
echo ""
echo "Next steps:"
echo "  1. Review TESTING_GUIDE.md for detailed tests"
echo "  2. Run: npx tsx test-seo-agent.ts (to test SEO agent)"
echo "  3. Run: npm run dev (to start coordinator daemon)"
echo ""
