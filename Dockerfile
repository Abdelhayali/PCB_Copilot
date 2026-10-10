# CircuitPilot MCP server (stdio). It answers MCP introspection on its own; design tools act on a running
# CircuitPilot app (python server.py) reached at CP_URL — e.g. docker run -i -e CP_URL=http://host.docker.internal:5173 …
FROM node:22-alpine
WORKDIR /app
COPY js ./js
COPY mcp ./mcp
ENV CP_URL=http://host.docker.internal:5173
CMD ["node", "mcp/circuitpilot-mcp.mjs"]
