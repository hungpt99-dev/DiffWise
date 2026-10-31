/**
 * DiffWise MCP package.
 *
 * Versioned interface: tool names and input schemas are stable within a major
 * interface version (see MCP_INTERFACE_VERSION).
 */
export {
  createServer, openContext, startStdioServer, summarizeAgentEvents, SERVER_INFO, MCP_INTERFACE_VERSION,
} from './server';
export type { ServerContext } from './server';
