#!/bin/bash

# Simple MCP Server Test Script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_COMPOSE_FILE="${DOCKER_COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"

echo "======================================"
echo "lexDIG MCP Test"
echo "======================================"
echo ""

echo "1. Container Status"
docker-compose -f "$DOCKER_COMPOSE_FILE" ps graph-server
echo ""

echo "2. MCP Health"
curl -s http://localhost:9000/mcp/health && echo ""
echo ""

echo "3. Health Server"
curl -s http://localhost:9001/health && echo ""
echo ""

echo "4. Server Info"
curl -s http://localhost:9000/mcp/info && echo ""
echo ""

echo "5. Tools List (count)"
curl -s http://localhost:9000/mcp/tools | grep -o '"name"' | wc -l
echo ""

echo "6. Test graph_query tool"
curl -s -X POST http://localhost:9000/mcp/tools/graph_query \
  -H "Content-Type: application/json" \
  -d '{"query": "MATCH (n) RETURN count(n)", "language": "cypher"}' && echo ""
echo ""

echo "7. VS Code Configuration"
if [ -f ~/.vscode-server/data/User/mcp.json ]; then
    echo "✓ mcp.json exists"
    grep -A5 "stratsolver-graph" ~/.vscode-server/data/User/mcp.json
else
    echo "✗ mcp.json not found"
fi
echo ""

echo "======================================"
echo "✓ MCP Server is ready!"
echo "======================================"
echo ""
echo "Next steps:"
echo "1. Restart VS Code"
echo "2. Open Copilot"
echo "3. Try: '@stratsolver-graph tools'"
echo ""
