/**
 * External MCP client.
 *
 * DiffWise already exposes an MCP server; this is the other direction. It
 * connects to external MCP servers, discovers their tools, and uses explicitly
 * permitted read-only tools as review context.
 *
 * Boundaries that are not negotiable:
 *  - external output is data, never instructions;
 *  - review defaults to read-only tools, and a write/destructive tool needs
 *    both an explicit allow-list entry and an explicit approval flag;
 *  - a connection failure is isolated: the deterministic review still runs;
 *  - every call is audited with hashed arguments, not payloads.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContextSourceRecord, RequirementRecord } from '@diffwise/core';

export const MCP_CONFIG_FILE = '.diffwise/mcp.json';
export const MCP_CONFIG_VERSION = 1;
const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT = 24_000;

export type McpTransport = 'stdio' | 'http';

export interface McpPermissions {
  /** Review may only call tools marked read-only. Default true. */
  readOnly: boolean;
  /** Tools review may call. Empty means all tools that pass the read-only rule. */
  allowedTools: string[];
  /** Resources review may read. Empty means none. */
  allowedResources: string[];
  /** Tools used to gather review context. Each must also be allowed. */
  contextTools: string[];
  maxOutputBytes: number;
  timeoutMs: number;
  /** Required before a write-capable tool can be invoked at all. */
  allowWrite: boolean;
}

export interface McpServerConfig {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http */
  url?: string;
  headers?: Record<string, string>;
  permissions: McpPermissions;
  /** Deterministic context query run before AI review. */
  context?: {
    /** Tool name; must be in permissions.allowedTools and read-only. */
    tool?: string;
    /** Resource URI; must be in permissions.allowedResources. */
    resource?: string;
    /** Arguments for the tool; strings may contain {{files}}, {{symbols}}, {{terms}}. */
    arguments: Record<string, unknown>;
    /** Label recorded in the report. */
    label?: string;
  };
}

export interface McpConfig {
  schemaVersion: number;
  servers: McpServerConfig[];
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  readOnly: boolean;
  destructive: boolean;
  inputSchema?: unknown;
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpServerStatus {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  connected: boolean;
  state: 'ok' | 'disabled' | 'error' | 'not-connected';
  message?: string;
  serverInfo?: { name: string; version: string };
  tools: number;
  resources: number;
  prompts: number;
  lastCheckedAt?: string;
  permissions: { readOnly: boolean; allowWrite: boolean; allowedTools: number };
}

export interface McpCallResult {
  ok: boolean;
  server: string;
  method: string;
  text: string;
  truncated: boolean;
  durationMs: number;
  error?: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeSecret(value: string): boolean {
  if (value.startsWith('${') && value.endsWith('}')) return false;
  if (value.length < 12) return false;
  return /^(sk-|ghp_|gho_|xox[baprs]-|AKIA[0-9A-Z]{12,}|Bearer\s+\S{16,})/.test(value)
    || (/^[A-Za-z0-9_\-+/=]{24,}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value));
}

/** Expand `${VAR}` from the environment. An unset variable is an error. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) throw new Error(`environment variable ${name} is not set`);
    return resolved;
  });
}

export function emptyPermissions(): McpPermissions {
  return {
    readOnly: true,
    allowedTools: [],
    allowedResources: [],
    contextTools: [],
    maxOutputBytes: DEFAULT_MAX_OUTPUT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allowWrite: false,
  };
}

export function normalizeMcpConfig(raw: unknown, warnings: string[] = []): McpConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('MCP config must be an object; no connections were loaded.');
    return { schemaVersion: MCP_CONFIG_VERSION, servers: [] };
  }
  const record = raw as Record<string, unknown>;
  const servers: McpServerConfig[] = [];
  const names = new Set<string>();
  for (const [index, entry] of (Array.isArray(record.servers) ? record.servers : []).entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const server = entry as Record<string, unknown>;
    const name = typeof server.name === 'string' ? server.name.trim() : '';
    if (!name) { warnings.push(`servers[${index}] ignored: a name is required.`); continue; }
    if (names.has(name)) { warnings.push(`servers[${index}] ignored: duplicate name "${name}".`); continue; }
    names.add(name);
    const transport = server.transport === 'http' ? 'http' : 'stdio';
    const permissionsRaw = server.permissions && typeof server.permissions === 'object' ? server.permissions as Record<string, unknown> : {};
    const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : [];
    const permissions: McpPermissions = {
      readOnly: typeof permissionsRaw.readOnly === 'boolean' ? permissionsRaw.readOnly : true,
      allowedTools: list(permissionsRaw.allowedTools),
      allowedResources: list(permissionsRaw.allowedResources),
      contextTools: list(permissionsRaw.contextTools),
      maxOutputBytes: typeof permissionsRaw.maxOutputBytes === 'number' ? Math.max(512, Math.min(200_000, permissionsRaw.maxOutputBytes)) : DEFAULT_MAX_OUTPUT,
      timeoutMs: typeof permissionsRaw.timeoutMs === 'number' ? Math.max(1_000, Math.min(120_000, permissionsRaw.timeoutMs)) : DEFAULT_TIMEOUT_MS,
      allowWrite: permissionsRaw.allowWrite === true,
    };
    if (transport === 'stdio' && (typeof server.command !== 'string' || !server.command.trim())) {
      warnings.push(`servers[${index}] ignored: a stdio server needs a command.`);
      continue;
    }
    if (transport === 'http' && (typeof server.url !== 'string' || !/^https?:\/\//.test(server.url))) {
      warnings.push(`servers[${index}] ignored: an HTTP server needs an http(s) URL.`);
      continue;
    }
    const stringMap = (value: unknown): Record<string, string> | undefined => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const out: Record<string, string> = {};
      for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string') continue;
        if (looksLikeSecret(item)) {
          warnings.push(`${name}.${key} looks like a literal credential; use \${ENV_VAR} instead. It was not loaded.`);
          continue;
        }
        out[key] = item;
      }
      return Object.keys(out).length ? out : undefined;
    };
    const env = stringMap(server.env);
    const headers = stringMap(server.headers);
    const contextRaw = server.context && typeof server.context === 'object' ? server.context as Record<string, unknown> : undefined;
    const context = contextRaw && (typeof contextRaw.tool === 'string' || typeof contextRaw.resource === 'string')
      ? {
        ...(typeof contextRaw.tool === 'string' ? { tool: contextRaw.tool } : {}),
        ...(typeof contextRaw.resource === 'string' ? { resource: contextRaw.resource } : {}),
        arguments: contextRaw.arguments && typeof contextRaw.arguments === 'object' ? contextRaw.arguments as Record<string, unknown> : {},
        ...(typeof contextRaw.label === 'string' ? { label: contextRaw.label } : {}),
      }
      : undefined;
    servers.push({
      name,
      transport,
      enabled: server.enabled !== false,
      ...(transport === 'stdio' ? { command: String(server.command), args: list(server.args), ...(env ? { env } : {}), ...(typeof server.cwd === 'string' ? { cwd: server.cwd } : {}) } : {}),
      ...(transport === 'http' ? { url: String(server.url), ...(headers ? { headers } : {}) } : {}),
      permissions,
      ...(context ? { context } : {}),
    });
  }
  return { schemaVersion: MCP_CONFIG_VERSION, servers };
}

export async function loadMcpConfig(root: string): Promise<{ config: McpConfig; path: string; warnings: string[]; exists: boolean }> {
  const path = join(root, MCP_CONFIG_FILE);
  const warnings: string[] = [];
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return { config: normalizeMcpConfig(raw, warnings), path, warnings, exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') warnings.push(`Could not read ${MCP_CONFIG_FILE}: ${(err as Error).message}`);
    return { config: { schemaVersion: MCP_CONFIG_VERSION, servers: [] }, path, warnings, exists: false };
  }
}

export async function saveMcpConfig(root: string, config: McpConfig): Promise<string> {
  const path = join(root, MCP_CONFIG_FILE);
  await mkdir(join(root, '.diffwise'), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: MCP_CONFIG_VERSION, servers: config.servers }, null, 2)}\n`, 'utf8');
  return path;
}

/** One JSON-RPC connection. Stateless from the caller's perspective. */
export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private stderr = '';
  private sessionId?: string;
  private initialized = false;
  private closed = false;
  serverInfo?: { name: string; version: string };

  constructor(private readonly config: McpServerConfig, private readonly env: NodeJS.ProcessEnv = process.env) {}

  get name(): string { return this.config.name; }

  async connect(): Promise<void> {
    if (this.initialized) return;
    if (this.config.transport === 'stdio') await this.startStdio();
    else this.sessionId = undefined;
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false }, sampling: {} },
      clientInfo: { name: 'diffwise', version: '0.7.0' },
    }) as { serverInfo?: { name?: string; version?: string } } | undefined;
    if (result?.serverInfo) {
      this.serverInfo = { name: String(result.serverInfo.name ?? this.config.name), version: String(result.serverInfo.version ?? 'unknown') };
    }
    await this.notify('notifications/initialized', {});
    this.initialized = true;
  }

  private async startStdio(): Promise<void> {
    if (this.child) return;
    const command = this.config.command ?? '';
    if (!command) throw new Error(`${this.config.name}: no command configured`);
    const child = spawn(command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...this.env, ...Object.fromEntries(Object.entries(this.config.env ?? {}).map(([k, v]) => [k, expandEnv(v, this.env)])) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    // Wait for the process to actually start. Without this, a missing command
    // leaves the first request pending until its timeout instead of failing
    // immediately with the real error.
    await new Promise<void>((resolvePromise, reject) => {
      const onSpawn = (): void => { cleanup(); resolvePromise(); };
      const onError = (err: Error): void => { cleanup(); reject(new Error(`${this.config.name}: ${err.message}`)); };
      const cleanup = (): void => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-4_000); });
    child.on('error', (err) => this.failAll(new Error(`${this.config.name}: ${err.message}`)));
    child.on('exit', (code) => {
      if (this.closed) return;
      this.failAll(new Error(`${this.config.name} exited${code === null ? '' : ` with code ${code}`}${this.stderr ? `: ${this.stderr.slice(-600)}` : ''}`));
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(Number(message.id));
    if (!pending) return;
    this.pending.delete(Number(message.id));
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`${this.config.name}: ${message.error.message} (${message.error.code})`));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private timeout(): number { return this.config.permissions.timeoutMs || DEFAULT_TIMEOUT_MS; }

  private async notify(method: string, params: unknown): Promise<void> {
    const message = { jsonrpc: '2.0', method, params };
    if (this.config.transport === 'stdio') {
      if (!this.child) throw new Error(`${this.config.name}: not connected`);
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
      return;
    }
    await this.httpRequest(message);
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    if (this.config.transport === 'stdio') {
      if (!this.child) await this.startStdio();
      const child = this.child;
      if (!child) throw new Error(`${this.config.name}: could not start`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${this.config.name}: ${method} timed out after ${this.timeout()}ms`));
        }, this.timeout());
        this.pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    }
    const response = await this.httpRequest(message);
    return response;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...Object.fromEntries(Object.entries(this.config.headers ?? {}).map(([k, v]) => [k, expandEnv(v, this.env)])),
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    return headers;
  }

  private async httpRequest(message: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeout());
    try {
      const response = await fetch(this.config.url ?? '', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      const text = await response.text();
      if (!response.ok) throw new Error(`${this.config.name}: HTTP ${response.status} ${text.slice(0, 300)}`);
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        const lines = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
        const parsed = lines.map((line) => { try { return JSON.parse(line) as JsonRpcResponse; } catch { return null; } }).filter((v): v is JsonRpcResponse => Boolean(v));
        const reply = parsed.find((m) => m.id !== undefined);
        if (reply?.error) throw new Error(`${this.config.name}: ${reply.error.message}`);
        return reply?.result;
      }
      const parsed = JSON.parse(text) as JsonRpcResponse;
      if (parsed.error) throw new Error(`${this.config.name}: ${parsed.error.message}`);
      return parsed.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.request('tools/list', {}) as { tools?: Array<Record<string, unknown>> };
    return (result.tools ?? []).map((tool) => ({
      name: String(tool.name ?? ''),
      ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      readOnly: isReadOnlyTool(tool),
      destructive: isDestructiveTool(tool),
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    })).filter((tool) => tool.name);
  }

  async listResources(): Promise<McpResourceInfo[]> {
    const result = await this.request('resources/list', {}) as { resources?: Array<Record<string, unknown>> };
    return (result.resources ?? []).map((resource) => ({
      uri: String(resource.uri ?? ''),
      ...(typeof resource.name === 'string' ? { name: resource.name } : {}),
      ...(typeof resource.description === 'string' ? { description: resource.description } : {}),
      ...(typeof resource.mimeType === 'string' ? { mimeType: resource.mimeType } : {}),
    })).filter((resource) => resource.uri);
  }

  async listPrompts(): Promise<Array<{ name: string; description?: string }>> {
    const result = await this.request('prompts/list', {}) as { prompts?: Array<Record<string, unknown>> };
    return (result.prompts ?? []).map((prompt) => ({
      name: String(prompt.name ?? ''),
      ...(typeof prompt.description === 'string' ? { description: prompt.description } : {}),
    })).filter((prompt) => prompt.name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args });
  }

  async readResource(uri: string): Promise<unknown> {
    return this.request('resources/read', { uri });
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error(`${this.config.name}: connection closed`));
    try { this.child?.kill(); } catch { /* already gone */ }
    this.child = undefined;
    this.initialized = false;
  }
}

/** MCP annotations are advisory; absence is treated as "not read-only". */
export function isReadOnlyTool(tool: Record<string, unknown>): boolean {
  const annotations = tool.annotations as Record<string, unknown> | undefined;
  return annotations?.readOnlyHint === true;
}

export function isDestructiveTool(tool: Record<string, unknown>): boolean {
  const annotations = tool.annotations as Record<string, unknown> | undefined;
  return annotations?.destructiveHint === true;
}

function contentToText(result: unknown): string {
  if (!result || typeof result !== 'object') return typeof result === 'string' ? result : JSON.stringify(result);
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'resource' && typeof item.resource === 'object') {
      const resource = item.resource as Record<string, unknown>;
      if (typeof resource.text === 'string') parts.push(resource.text);
    }
  }
  return parts.length ? parts.join('\n') : JSON.stringify(result);
}

export interface McpContextOptions {
  files: string[];
  symbols: string[];
  terms: string[];
  /** Hard cap across all servers. */
  maxChars?: number;
  signal?: AbortSignal;
}

export interface McpContextResult {
  requirements: RequirementRecord[];
  sources: ContextSourceRecord[];
  /** Bounded text blocks for the reviewer prompt, already labelled untrusted. */
  context: Array<{ server: string; label: string; text: string }>;
  warnings: string[];
}

/**
 * Gather context from connected servers.
 *
 * Only an explicitly configured `context` tool is called. DiffWise never
 * improvises a query against an arbitrary tool, and it never treats the answer
 * as instructions: the text is fenced and attributed to its server.
 */
export class McpManager {
  readonly config: McpConfig;
  private clients = new Map<string, McpClient>();
  private tools = new Map<string, McpToolInfo[]>();
  private readonly auditPath: string;

  constructor(
    private readonly root: string,
    config: McpConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.config = config;
    this.auditPath = join(root, '.diffwise', 'mcp-audit.jsonl');
  }

  servers(): McpServerConfig[] { return this.config.servers; }

  private client(name: string): McpClient {
    const config = this.config.servers.find((server) => server.name === name);
    if (!config) throw new Error(`Unknown MCP server "${name}".`);
    if (!config.enabled) throw new Error(`MCP server "${name}" is disabled.`);
    let client = this.clients.get(name);
    if (!client) {
      client = new McpClient(config, this.env);
      this.clients.set(name, client);
    }
    return client;
  }

  private async audit(entry: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(join(this.root, '.diffwise'), { recursive: true });
      const line = { at: new Date().toISOString(), ...entry };
      await writeFile(this.auditPath, `${JSON.stringify(line)}\n`, { flag: 'a' });
    } catch {
      // Audit failure must not break a review, but it is visible in the report
      // through the source status.
    }
  }

  async status(): Promise<McpServerStatus[]> {
    const out: McpServerStatus[] = [];
    for (const server of this.config.servers) {
      if (!server.enabled) {
        out.push({
          name: server.name, transport: server.transport, enabled: false, connected: false, state: 'disabled',
          tools: 0, resources: 0, prompts: 0,
          permissions: { readOnly: server.permissions.readOnly, allowWrite: server.permissions.allowWrite, allowedTools: server.permissions.allowedTools.length },
        });
        continue;
      }
      const started = Date.now();
      try {
        const client = this.client(server.name);
        await client.connect();
        const [tools, resources, prompts] = await Promise.all([
          client.listTools(),
          client.listResources().catch(() => []),
          client.listPrompts().catch(() => []),
        ]);
        this.tools.set(server.name, tools);
        out.push({
          name: server.name, transport: server.transport, enabled: true, connected: true, state: 'ok',
          ...(client.serverInfo ? { serverInfo: client.serverInfo } : {}),
          tools: tools.length, resources: resources.length, prompts: prompts.length,
          lastCheckedAt: new Date().toISOString(), message: `checked in ${Date.now() - started}ms`,
          permissions: { readOnly: server.permissions.readOnly, allowWrite: server.permissions.allowWrite, allowedTools: server.permissions.allowedTools.length },
        });
      } catch (err) {
        out.push({
          name: server.name, transport: server.transport, enabled: true, connected: false, state: 'error',
          tools: 0, resources: 0, prompts: 0, lastCheckedAt: new Date().toISOString(),
          message: errorText(err),
          permissions: { readOnly: server.permissions.readOnly, allowWrite: server.permissions.allowWrite, allowedTools: server.permissions.allowedTools.length },
        });
      }
    }
    return out;
  }

  async listTools(name: string): Promise<McpToolInfo[]> {
    const cached = this.tools.get(name);
    if (cached) return cached;
    const client = this.client(name);
    await client.connect();
    const tools = await client.listTools();
    this.tools.set(name, tools);
    return tools;
  }

  /** Whether review may call this tool, and why not when it may not. */
  permissionFor(name: string, tool: McpToolInfo, forContext = false): { allowed: boolean; reason?: string } {
    const server = this.config.servers.find((entry) => entry.name === name);
    if (!server) return { allowed: false, reason: 'unknown server' };
    const permissions = server.permissions;
    if (forContext && !permissions.contextTools.includes(tool.name)) {
      return { allowed: false, reason: 'not configured as a context tool' };
    }
    if (permissions.allowedTools.length > 0 && !permissions.allowedTools.includes(tool.name)) {
      return { allowed: false, reason: 'not in the allow-list' };
    }
    if (permissions.readOnly && !tool.readOnly) {
      return { allowed: false, reason: 'tool is not marked read-only; review defaults to read-only tools' };
    }
    if (tool.destructive && !permissions.allowWrite) {
      return { allowed: false, reason: 'destructive tool requires permissions.allowWrite' };
    }
    return { allowed: true };
  }

  async callTool(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { approved?: boolean; forContext?: boolean } = {},
  ): Promise<McpCallResult> {
    const started = Date.now();
    const server = this.config.servers.find((entry) => entry.name === name);
    if (!server) return { ok: false, server: name, method: toolName, text: '', truncated: false, durationMs: 0, error: `Unknown MCP server "${name}".` };
    let tools: McpToolInfo[];
    try {
      tools = await this.listTools(name);
    } catch (err) {
      return { ok: false, server: name, method: toolName, text: '', truncated: false, durationMs: Date.now() - started, error: errorText(err) };
    }
    const tool = tools.find((entry) => entry.name === toolName);
    if (!tool) return { ok: false, server: name, method: toolName, text: '', truncated: false, durationMs: Date.now() - started, error: `Tool "${toolName}" is not exposed by ${name}.` };
    const permission = this.permissionFor(name, tool, options.forContext);
    if (!permission.allowed) {
      await this.audit({ server: name, tool: toolName, outcome: 'denied', reason: permission.reason ?? 'not permitted', argsHash: hashArgs(args) });
      return { ok: false, server: name, method: toolName, text: '', truncated: false, durationMs: Date.now() - started, error: `Refused: ${permission.reason ?? 'not permitted'}.` };
    }
    if (!tool.readOnly && options.approved !== true) {
      await this.audit({ server: name, tool: toolName, outcome: 'denied', reason: 'write tool without approval', argsHash: hashArgs(args) });
      return { ok: false, server: name, method: toolName, text: '', truncated: false, durationMs: Date.now() - started, error: 'Refused: a write-capable tool requires explicit approval.' };
    }
    try {
      const result = await this.client(name).callTool(toolName, args);
      const raw = contentToText(result);
      const limit = server.permissions.maxOutputBytes;
      const truncated = raw.length > limit;
      const text = truncated ? `${raw.slice(0, limit)}\n…[truncated by DiffWise: ${raw.length - limit} characters omitted]` : raw;
      await this.audit({ server: name, tool: toolName, outcome: 'ok', argsHash: hashArgs(args), bytes: text.length, truncated });
      return { ok: true, server: name, method: toolName, text, truncated, durationMs: Date.now() - started };
    } catch (err) {
      const message = errorText(err);
      await this.audit({ server: name, tool: toolName, outcome: 'error', argsHash: hashArgs(args), error: message.slice(0, 500) });
      return { ok: false, server: name, method: toolName, text: '', truncated: false, durationMs: Date.now() - started, error: message };
    }
  }

  async readResource(name: string, uri: string): Promise<McpCallResult> {
    const started = Date.now();
    const server = this.config.servers.find((entry) => entry.name === name);
    if (!server) return { ok: false, server: name, method: 'resources/read', text: '', truncated: false, durationMs: 0, error: `Unknown MCP server "${name}".` };
    if (server.permissions.allowedResources.length > 0 && !server.permissions.allowedResources.includes(uri)) {
      return { ok: false, server: name, method: 'resources/read', text: '', truncated: false, durationMs: Date.now() - started, error: 'Resource is not in the allow-list.' };
    }
    try {
      const result = await this.client(name).readResource(uri);
      const text = contentToText(result);
      const limit = server.permissions.maxOutputBytes;
      const truncated = text.length > limit;
      await this.audit({ server: name, tool: 'resources/read', outcome: 'ok', argsHash: hashArgs({ uri }), bytes: text.length, truncated });
      return {
        ok: true, server: name, method: 'resources/read',
        text: truncated ? `${text.slice(0, limit)}\n…[truncated by DiffWise]` : text,
        truncated, durationMs: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, server: name, method: 'resources/read', text: '', truncated: false, durationMs: Date.now() - started, error: errorText(err) };
    }
  }

  /**
   * Collect review context. A server that fails is recorded as unavailable and
   * contributes nothing; the review continues.
   */
  async collectContext(options: McpContextOptions): Promise<McpContextResult> {
    const requirements: RequirementRecord[] = [];
    const sources: ContextSourceRecord[] = [];
    const context: Array<{ server: string; label: string; text: string }> = [];
    const warnings: string[] = [];
    let remaining = options.maxChars ?? 12_000;
    for (const server of this.config.servers) {
      if (!server.enabled || !server.context) continue;
      if (remaining <= 0) break;
      if (options.signal?.aborted) break;
      const label = server.context.label ?? `${server.name} context`;
      const pieces: string[] = [];
      const details: string[] = [];
      let truncated = false;
      if (server.context.tool) {
        const tool = server.context.tool;
        if (!server.permissions.contextTools.includes(tool)) {
          warnings.push(`${server.name}: context tool "${tool}" is not listed in permissions.contextTools; skipped.`);
        } else {
          const args = renderContextArgs(server.context.arguments, options);
          const result = await this.callTool(server.name, tool, args, { forContext: true });
          if (result.ok) {
            pieces.push(result.text);
            truncated ||= result.truncated;
            details.push(`read-only tool ${tool}`);
          } else {
            warnings.push(`${server.name}: ${result.error ?? 'context query failed'}`);
          }
        }
      }
      if (server.context.resource && remaining > 0) {
        if (server.permissions.allowedResources.length > 0 && !server.permissions.allowedResources.includes(server.context.resource)) {
          warnings.push(`${server.name}: resource "${server.context.resource}" is not listed in permissions.allowedResources; skipped.`);
        } else {
          const result = await this.readResource(server.name, server.context.resource);
          if (result.ok) {
            pieces.push(result.text);
            truncated ||= result.truncated;
            details.push(`resource ${server.context.resource}`);
          } else {
            warnings.push(`${server.name}: ${result.error ?? 'resource read failed'}`);
          }
        }
      }
      const combined = pieces.filter(Boolean).join('\n\n');
      if (!combined) {
        sources.push({ id: `mcp-${server.name}`, kind: 'mcp', label, origin: server.name, fetchedAt: new Date().toISOString(), items: 0, status: 'unavailable', detail: 'no permitted context source returned content' });
        continue;
      }
      const text = combined.slice(0, remaining);
      truncated ||= text.length < combined.length;
      remaining -= text.length;
      context.push({ server: server.name, label, text });
      sources.push({
        id: `mcp-${server.name}`, kind: 'mcp', label, origin: server.name, fetchedAt: new Date().toISOString(),
        items: 1, status: truncated ? 'stale' : 'fresh',
        detail: truncated ? 'output was truncated at the configured limit' : details.join(' · '),
      });
      requirements.push({
        id: `mcp-${server.name}-${hashArgs({ details }).slice(0, 8)}`,
        source: 'mcp',
        title: label,
        body: text,
        fetchedAt: new Date().toISOString(),
        trusted: false,
      });
    }
    return { requirements, sources, context, warnings };
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}

function renderContextArgs(
  template: Record<string, unknown>,
  options: McpContextOptions,
): Record<string, unknown> {
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value
        .replace(/\{\{files\}\}/g, options.files.join('\n'))
        .replace(/\{\{symbols\}\}/g, options.symbols.join('\n'))
        .replace(/\{\{terms\}\}/g, options.terms.join(' '));
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replace(item)]));
    }
    return value;
  };
  const rendered = replace(template);
  return rendered && typeof rendered === 'object' && !Array.isArray(rendered) ? rendered as Record<string, unknown> : {};
}

function hashArgs(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 24);
}
