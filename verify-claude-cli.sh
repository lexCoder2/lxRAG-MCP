#!/bin/bash

# Verify Claude CLI MCP Integration
# This script checks if everything is properly set up for Claude CLI integration

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
GRAPH_SERVER_ROOT="$SCRIPT_DIR"
DOCKER_COMPOSE_FILE="${DOCKER_COMPOSE_FILE:-$GRAPH_SERVER_ROOT/docker-compose.yml}"
CLAUDE_MCP_CONFIG="${CLAUDE_MCP_CONFIG:-$PROJECT_ROOT/.claude/mcp.json}"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║         Claude CLI MCP Integration Verification               ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check 1: Claude Code CLI installed
echo "1️⃣  Checking Claude Code CLI..."
if command -v claude-code &> /dev/null; then
    VERSION=$(claude-code --version 2>/dev/null || echo "unknown")
    echo -e "${GREEN}✓ Claude Code CLI installed${NC}"
else
    echo -e "${RED}✗ Claude Code CLI not found${NC}"
    echo "  Install with: npm install -g @anthropic-ai/claude-code"
    exit 1
fi
echo ""

# Check 2: MCP configuration file
echo "2️⃣  Checking MCP configuration..."
if [ -f "$CLAUDE_MCP_CONFIG" ]; then
    echo -e "${GREEN}✓ MCP configuration found${NC}"
    echo "  Location: $CLAUDE_MCP_CONFIG"
else
    echo -e "${RED}✗ MCP configuration not found${NC}"
    exit 1
fi
echo ""

# Check 3: Graph server built
echo "3️⃣  Checking graph server build..."
if [ -f "$GRAPH_SERVER_ROOT/dist/server.js" ]; then
    echo -e "${GREEN}✓ Graph server built${NC}"
else
    echo -e "${RED}✗ Graph server not built${NC}"
    echo "  Build with: cd tools/graph-server && npm run build"
    exit 1
fi
echo ""

# Check 4: Memgraph running
echo "4️⃣  Checking Memgraph..."
if docker-compose -f "$DOCKER_COMPOSE_FILE" ps memgraph 2>/dev/null | grep -q "Up"; then
    echo -e "${GREEN}✓ Memgraph is running${NC}"
else
    echo -e "${YELLOW}⚠ Memgraph not running${NC}"
    echo "  Start with: cd tools/docker && docker-compose up -d"
fi
echo ""

# Check 5: Graph populated
echo "5️⃣  Checking graph data..."
NODE_COUNT=$(docker-compose -f "$DOCKER_COMPOSE_FILE" exec -T memgraph memgraph-cli --exec "MATCH (n) RETURN count(n)" 2>/dev/null | grep -oE '[0-9]+' | head -1)
if [ ! -z "$NODE_COUNT" ] && [ "$NODE_COUNT" -gt 0 ]; then
    echo -e "${GREEN}✓ Graph is populated ($NODE_COUNT nodes)${NC}"
else
    echo -e "${YELLOW}⚠ Graph is empty or Memgraph not accessible${NC}"
    echo "  Build graph with: npm run graph:build"
fi
echo ""

# Check 6: MCP tools accessible
echo "6️⃣  Checking MCP tools..."
TOOLS_COUNT=0
if [ -f "$GRAPH_SERVER_ROOT/dist/server.js" ]; then
    TOOLS_COUNT=$(grep -c '"name":' "$CLAUDE_MCP_CONFIG" || echo "0")
    if [ "$TOOLS_COUNT" -gt 0 ]; then
        echo -e "${GREEN}✓ All tools configured ($TOOLS_COUNT tools)${NC}"
    else
        echo -e "${RED}✗ No tools found in configuration${NC}"
    fi
else
    echo -e "${RED}✗ Cannot verify tools${NC}"
fi
echo ""

# Summary
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                        Summary                                 ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Try to start MCP server to verify it works
echo "7️⃣  Testing MCP server startup..."
TIMEOUT=5
OUTPUT=$(timeout $TIMEOUT node "$GRAPH_SERVER_ROOT/dist/server.js" 2>&1 &)
sleep 1
if ps aux | grep -q "[d]ist/server.js"; then
    echo -e "${GREEN}✓ MCP server starts successfully${NC}"
    pkill -f "dist/server.js" 2>/dev/null
else
    echo -e "${YELLOW}⚠ Could not verify MCP server (may need Memgraph running)${NC}"
fi
echo ""

echo "═════════════════════════════════════════════════════════════════"
echo ""
echo "📝 Next Steps:"
echo ""
echo "1. Ensure all services are running:"
echo "   cd $GRAPH_SERVER_ROOT"
echo "   docker-compose up -d"
echo ""
echo "2. Build code graph (if not done yet):"
echo "   cd $GRAPH_SERVER_ROOT"
echo "   npm run graph:build"
echo ""
echo "3. Test Claude CLI with MCP:"
echo "   claude-code --list-mcp-servers"
echo ""
echo "4. Try a query:"
echo "   claude-code --message \"What's the architecture violation in my code?\" --mcp-config $CLAUDE_MCP_CONFIG"
echo ""
echo "5. Interactive mode:"
echo "   claude-code --interactive --mcp-config $CLAUDE_MCP_CONFIG"
echo ""
echo "═════════════════════════════════════════════════════════════════"
echo ""
echo "For more info, see: $GRAPH_SERVER_ROOT/CLAUDE_CLI_SETUP.md"
echo ""
