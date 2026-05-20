import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  Tool,
  CallToolResult,
  TextContent
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import pino from 'pino';
import { ServerConfig } from '../types/config';
import { AuditLogger } from '../governance/audit-logger';
import { RateLimiter } from '../governance/rate-limiter';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType<any>;
  handler: (params: any, context: ToolContext) => Promise<CallToolResult>;
  /** Mark as true for any tool that mutates state in Grafana. */
  isWrite?: boolean;
}

export interface ToolContext {
  config: ServerConfig;
  logger: pino.Logger;
}

export class MCPServer {
  private server: Server;
  private tools: Map<string, ToolDefinition> = new Map();
  private config: ServerConfig;
  private logger: pino.Logger;
  private auditLogger?: AuditLogger;
  private rateLimiter?: RateLimiter;

  constructor(config: ServerConfig) {
    this.config = config;
    this.logger = pino({
      level: config.grafanaConfig.debug ? 'debug' : 'info',
      transport: config.grafanaConfig.debug ? {
        target: 'pino-pretty',
        options: {
          colorize: true
        }
      } : undefined
    });

    if (config.governance.auditLogFile) {
      this.auditLogger = new AuditLogger(config.governance.auditLogFile);
    }
    if (config.governance.writeRateLimit != null && config.governance.writeRateLimit > 0) {
      this.rateLimiter = new RateLimiter(config.governance.writeRateLimit);
    }

    this.server = new Server(
      {
        name: 'mcp-grafana',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [];
      
      for (const [name, definition] of this.tools) {
        // Check if tool category is enabled
        const category = this.getToolCategory(name);
        if (category && !this.config.enabledTools.has(category)) {
          continue;
        }

        const jsonSchema = zodToJsonSchema(definition.inputSchema);
        
        tools.push({
          name: definition.name,
          description: definition.description,
          inputSchema: jsonSchema as any,
        });
      }

      return { tools };
    });

    // Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const startMs = Date.now();

      const tool = this.tools.get(name);
      if (!tool) {
        throw new Error(`Tool "${name}" not found`);
      }

      // Check if tool category is enabled
      const category = this.getToolCategory(name);
      if (category && !this.config.enabledTools.has(category)) {
        throw new Error(`Tool category "${category}" is not enabled`);
      }

      const isWrite = !!tool.isWrite;
      const gov = this.config.governance;

      // --- Read-only mode ---
      if (isWrite && gov.readOnly) {
        const msg = `Tool "${name}" is a write operation and the server is running in read-only mode.`;
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          tool: name,
          isWrite,
          dryRun: false,
          args: (args ?? {}) as Record<string, unknown>,
          status: 'blocked',
          durationMs: Date.now() - startMs,
          error: msg,
        });
        return createErrorResult(msg);
      }

      // --- Rate limiting ---
      if (isWrite && this.rateLimiter && !this.rateLimiter.allow()) {
        const retry = this.rateLimiter.retryAfterSeconds();
        const msg = `Write rate limit exceeded. Retry after ${retry}s.`;
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          tool: name,
          isWrite,
          dryRun: gov.dryRun,
          args: (args ?? {}) as Record<string, unknown>,
          status: 'blocked',
          durationMs: Date.now() - startMs,
          error: msg,
        });
        return createErrorResult(msg);
      }

      // Claude Code (and some other clients) wrap arguments in an extra
      // "params" key: { params: { uid: "..." } }. Unwrap when params is the
      // only non-meta key so both formats work transparently.
      //
      // NOTE for tool authors: do NOT define a schema whose sole top-level
      // field is named "params" — the unwrap heuristic will misfire and
      // treat the value of that field as the full arguments object.
      const rawArgs = (
        args &&
        typeof args === 'object' &&
        'params' in args &&
        Object.keys(args).filter(k => k !== '_meta').length === 1
      ) ? (args as any).params : args;

      try {
        const validatedArgs = tool.inputSchema.parse(rawArgs);

        // --- Dry-run mode ---
        if (isWrite && gov.dryRun) {
          const preview = JSON.stringify(validatedArgs, null, 2);
          const msg = `[DRY RUN] Tool "${name}" would execute with arguments:\n${preview}`;
          this.auditLogger?.log({
            timestamp: new Date().toISOString(),
            tool: name,
            isWrite,
            dryRun: true,
            args: validatedArgs as Record<string, unknown>,
            status: 'dry_run',
            durationMs: Date.now() - startMs,
          });
          return createToolResult(msg);
        }

        // Execute tool handler
        const context: ToolContext = {
          config: this.config,
          logger: this.logger.child({ tool: name }),
        };

        const result = await tool.handler(validatedArgs, context);

        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          tool: name,
          isWrite,
          dryRun: false,
          args: validatedArgs as Record<string, unknown>,
          status: 'success',
          durationMs: Date.now() - startMs,
        });

        return result;
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new Error(`Invalid arguments for tool "${name}": ${error.message}`);
        }
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          tool: name,
          isWrite,
          dryRun: gov.dryRun,
          args: (rawArgs ?? {}) as Record<string, unknown>,
          status: 'error',
          durationMs: Date.now() - startMs,
          error: (error as Error).message,
        });
        throw error;
      }
    });
  }

  registerTool(definition: ToolDefinition) {
    this.tools.set(definition.name, definition);
    this.logger.debug(`Registered tool: ${definition.name}`);
  }

  private getToolCategory(toolName: string): string | undefined {
    // Map tool names to categories based on naming patterns
    if (toolName.startsWith('search_')) return 'search';
    if (toolName.includes('dashboard')) return 'dashboard';
    if (toolName.includes('datasource')) return 'datasource';
    if (toolName.includes('prometheus')) return 'prometheus';
    if (toolName.includes('loki')) return 'loki';
    if (toolName.includes('incident')) return 'incident';
    if (toolName.includes('alert')) return 'alerting';
    if (toolName.includes('oncall')) return 'oncall';
    if (toolName.includes('sift')) return 'sift';
    if (toolName.includes('pyroscope')) return 'pyroscope';
    if (toolName.includes('deeplink')) return 'navigation';
    if (toolName.includes('assertion')) return 'asserts';
    if (toolName.includes('team') || toolName.includes('user')) return 'admin';
    
    return undefined;
  }

  async start() {
    switch (this.config.transport) {
      case 'stdio':
        await this.startStdio();
        break;
      case 'sse':
        await this.startSSE();
        break;
      case 'streamable-http':
        await this.startStreamableHTTP();
        break;
      default:
        throw new Error(`Unsupported transport: ${this.config.transport}`);
    }
  }

  private async startStdio() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('MCP server started with stdio transport');
  }

  private async startSSE() {
    // Note: SSE transport would need to be implemented or imported from MCP SDK
    // For now, we'll throw an error
    throw new Error('SSE transport not yet implemented in TypeScript version');
  }

  private async startStreamableHTTP() {
    // Note: Streamable HTTP transport would need to be implemented
    throw new Error('Streamable HTTP transport not yet implemented in TypeScript version');
  }

  async stop() {
    await this.server.close();
    this.logger.info('MCP server stopped');
  }
}

// Helper function to create a tool result
export function createToolResult(content: string | object): CallToolResult {
  if (typeof content === 'string') {
    return {
      content: [{ type: 'text', text: content } as TextContent],
    };
  } else {
    return {
      content: [{ type: 'text', text: JSON.stringify(content, null, 2) } as TextContent],
    };
  }
}

// Helper function for error results
export function createErrorResult(error: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${error}` } as TextContent],
    isError: true,
  };
}