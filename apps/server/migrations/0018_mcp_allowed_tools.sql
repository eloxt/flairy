-- Optional per-MCP-server tool allowlist. Empty array means expose every tool
-- listed by the MCP server; otherwise clients inject only matching tool names.

ALTER TABLE mcp_servers
    ADD COLUMN IF NOT EXISTS allowed_tools TEXT[] NOT NULL DEFAULT '{}';
