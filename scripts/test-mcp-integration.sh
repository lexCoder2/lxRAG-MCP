#!/bin/bash

# MCP Server Integration Test Script
# Tests all endpoints and verifies VS Code can connect

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_COMPOSE_FILE="${DOCKER_COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"

echo "=========================================="
echo "lexRAG MCP Integration Test"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counter
PASSED=0
FAILED=0

test_endpoint() {
    local name=$1
    local method=$2
    local url=$3
    local data=$4
    
    echo -n "Testing $name... "
    
    if [ "$method" = "GET" ]; then
        http_code=$(curl -s -o /dev/null -w "%{http_code}" "$url")
    else
        http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url" \
            -H "Content-Type: application/json" \
            -d "$data")
    fi
    
    if [ "$http_code" -eq 200 ]; then
        echo -e "${GREEN}✓ PASSED${NC} (HTTP $http_code)"
        ((PASSED++))
        return 0
    else
        echo -e "${RED}✗ FAILED${NC} (HTTP $http_code)"
        ((FAILED++))
        return 1
    fi
}

echo "1. Container Status"
echo "==================="
docker-compose -f "$DOCKER_COMPOSE_FILE" ps graph-server
echo ""

echo "2. Health Checks"
echo "================"
test_endpoint "MCP Health" "GET" "http://localhost:9000/mcp/health"
test_endpoint "Health Server" "GET" "http://localhost:9001/health"
echo ""

echo "3. MCP Endpoints"
echo "================"
test_endpoint "Server Info" "GET" "http://localhost:9000/mcp/info"
test_endpoint "Tools List" "GET" "http://localhost:9000/mcp/tools"
echo ""

echo "4. Tool Execution"
echo "================="
test_endpoint "graph_query" "POST" "http://localhost:9000/mcp/tools/graph_query" \
    '{"query": "MATCH (n) RETURN count(n) as count", "language": "cypher"}'

test_endpoint "arch_validate" "POST" "http://localhost:9000/mcp/tools/arch_validate" \
    '{"files": ["src/test.ts"], "strict": false}'

test_endpoint "test_select" "POST" "http://localhost:9000/mcp/tools/test_select" \
    '{"changedFiles": ["src/hooks/useBuildingState.ts"], "mode": "direct"}'
echo ""

echo "5. VS Code Configuration"
echo "========================"
if [ -f ~/.vscode-server/data/User/mcp.json ]; then
    echo -e "${GREEN}✓${NC} mcp.json exists at ~/.vscode-server/data/User/mcp.json"
    echo "Configuration:"
    cat ~/.vscode-server/data/User/mcp.json | grep -A2 "stratsolver-graph"
    ((PASSED++))
else
    echo -e "${RED}✗${NC} mcp.json not found"
    ((FAILED++))
fi
echo ""

echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed! MCP server is ready.${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Restart VS Code to load MCP configuration"
    echo "2. Open Copilot and try: '@stratsolver-graph list tools'"
    echo "3. Use graph_rebuild tool to index codebase"
    exit 0
else
    echo -e "${RED}✗ Some tests failed. Check logs:${NC}"
    echo "  docker logs lexrag-mcp"
    exit 1
fi
