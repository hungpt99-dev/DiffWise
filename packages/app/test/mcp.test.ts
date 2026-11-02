import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpManager, normalizeMcpConfig } from '@diffwise/app';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A minimal MCP stdio server implementing initialize, tools/list and tools/call. */
const SERVER = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    if (message.method === 'initialize') {
      reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'test-jira', version: '1.0.0' } });
    } else if (message.method === 'tools/list') {
      reply({ tools: [
        { name: 'search_tickets', description: 'Search tickets', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'delete_ticket', description: 'Delete a ticket', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } },
      ] });
    } else if (message.method === 'resources/list') {
      reply({ resources: [{ uri: 'jira://PAY/requirements', name: 'PAY requirements' }] });
    } else if (message.method === 'prompts/list') {
      reply({ prompts: [] });
    } else if (message.method === 'resources/read') {
      reply({ contents: [{ uri: message.params.uri, mimeType: 'text/markdown', text: 'PAY requirements: refunds must be idempotent and audited' }] });
    } else if (message.method === 'tools/call') {
      if (message.params.name === 'search_tickets') {
        reply({ content: [{ type: 'text', text: 'PAY-42: refunds must be idempotent (' + JSON.stringify(message.params.arguments) + ')' }] });
      } else {
        reply({ content: [{ type: 'text', text: 'deleted' }] });
      }
    } else {
      reply({});
    }
  }
});
`;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'diffwise-mcp-'));
  dirs.push(root);
  const server = join(root, 'server.js');
  await writeFile(server, SERVER, 'utf8');
  const config = normalizeMcpConfig({
    servers: [{
      name: 'jira',
      transport: 'stdio',
      command: process.execPath,
      args: [server],
      permissions: {
        readOnly: true,
        allowedTools: ['search_tickets'],
        contextTools: ['search_tickets'],
        timeoutMs: 10_000,
      },
      context: { tool: 'search_tickets', arguments: { query: '{{terms}}', files: '{{files}}' }, label: 'Jira requirement' },
    }],
  });
  return { root, config };
}

describe('external MCP client', () => {
  it('connects over stdio, lists tools and records the server identity', async () => {
    const { root, config } = await setup();
    const manager = new McpManager(root, config);
    try {
      const status = await manager.status();
      expect(status[0]).toMatchObject({ name: 'jira', state: 'ok', connected: true, tools: 2 });
      expect(status[0]?.serverInfo?.name).toBe('test-jira');
    } finally {
      manager.close();
    }
  });

  it('refuses a write tool during review and audits the denial', async () => {
    const { root, config } = await setup();
    const manager = new McpManager(root, config);
    try {
      const denied = await manager.callTool('jira', 'delete_ticket', { id: 'PAY-42' });
      expect(denied.ok).toBe(false);
      expect(denied.error).toMatch(/allow-list|read-only/);
      const audit = await readFile(join(root, '.diffwise', 'mcp-audit.jsonl'), 'utf8');
      expect(audit).toContain('denied');
      expect(audit).not.toContain('PAY-42');
    } finally {
      manager.close();
    }
  });

  it('collects bounded, attributed context through an explicitly permitted tool', async () => {
    const { root, config } = await setup();
    const manager = new McpManager(root, config);
    try {
      const context = await manager.collectContext({
        files: ['src/payments/refund.ts'],
        symbols: ['refund'],
        terms: ['refunds', 'idempotent'],
      });
      expect(context.requirements).toHaveLength(1);
      expect(context.requirements[0]?.title).toBe('Jira requirement');
      expect(context.requirements[0]?.trusted).toBe(false);
      expect(context.requirements[0]?.body).toContain('PAY-42');
      expect(context.sources[0]).toMatchObject({ kind: 'mcp', status: 'fresh' });
      expect(context.context[0]?.server).toBe('jira');
    } finally {
      manager.close();
    }
  });

  it('reads an allow-listed resource as context, with no tool call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'diffwise-mcp-res-'));
    dirs.push(root);
    const server = join(root, 'server.js');
    await writeFile(server, SERVER, 'utf8');
    const config = normalizeMcpConfig({
      servers: [{
        name: 'jira', transport: 'stdio', command: process.execPath, args: [server],
        permissions: { readOnly: true, allowedResources: ['jira://PAY/requirements'], timeoutMs: 10_000 },
        context: { resource: 'jira://PAY/requirements', arguments: {}, label: 'PAY requirements' },
      }],
    });
    const manager = new McpManager(root, config);
    try {
      const context = await manager.collectContext({ files: [], symbols: [], terms: [] });
      expect(context.requirements[0]?.body).toContain('audited');
      expect(context.sources[0]?.detail).toContain('resource jira://PAY/requirements');
    } finally {
      manager.close();
    }
  });

  it('records an unavailable server without throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'diffwise-mcp-bad-'));
    dirs.push(root);
    const config = normalizeMcpConfig({
      servers: [{
        name: 'broken', transport: 'stdio', command: 'definitely-not-a-real-command-diffwise',
        permissions: { contextTools: ['x'], timeoutMs: 1_000 },
        context: { tool: 'x', arguments: {} },
      }],
    });
    const manager = new McpManager(root, config);
    try {
      const status = await manager.status();
      expect(status[0]?.state).toBe('error');
      const context = await manager.collectContext({ files: [], symbols: [], terms: [] });
      expect(context.sources[0]?.status).toBe('unavailable');
      expect(context.warnings.length).toBeGreaterThan(0);
    } finally {
      manager.close();
    }
  });
});
