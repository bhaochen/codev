/**
 * MCP command handlers
 * These handlers are used by the CLI MCP commands
 */

export async function mcpServeHandler(options: { debug?: boolean; verbose?: boolean }): Promise<void> {
  console.error('MCP serve handler not implemented');
  process.exit(1);
}

export async function mcpRemoveHandler(name: string, options: { scope?: string }): Promise<void> {
  console.error('MCP remove handler not implemented');
  process.exit(1);
}

export async function mcpListHandler(): Promise<void> {
  console.error('MCP list handler not implemented');
  process.exit(1);
}

export async function mcpGetHandler(name: string): Promise<void> {
  console.error('MCP get handler not implemented');
  process.exit(1);
}

export async function mcpAddJsonHandler(name: string, json: string, options: { scope?: string; clientSecret?: true }): Promise<void> {
  console.error('MCP add-json handler not implemented');
  process.exit(1);
}

export async function mcpAddFromDesktopHandler(options: { scope?: string }): Promise<void> {
  console.error('MCP add-from-claude-desktop handler not implemented');
  process.exit(1);
}

export async function mcpResetChoicesHandler(): Promise<void> {
  console.error('MCP reset-project-choices handler not implemented');
  process.exit(1);
}