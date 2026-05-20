import { z } from 'zod';
import { ToolDefinition, ToolContext, createToolResult, createErrorResult } from '../server/mcp-server';
import { GrafanaClient } from '../clients/grafana-client';
import jsonpath from 'jsonpath';

// Schema definitions
const GetDashboardByUidSchema = z.object({
  uid: z.string().describe('The UID of the dashboard'),
});

const GetDashboardSummarySchema = z.object({
  uid: z.string().describe('The UID of the dashboard'),
});

const GetDashboardPropertySchema = z.object({
  uid: z.string().describe('The UID of the dashboard'),
  jsonPath: z.string().describe('JSONPath expression to extract specific data'),
});

const GetDashboardPanelQueriesSchema = z.object({
  uid: z.string().describe('The UID of the dashboard'),
});

const UpdateDashboardSchema = z.object({
  uid: z.string().optional().describe('UID of existing dashboard to update'),
  dashboard: z.record(z.any()).optional().describe('The full dashboard JSON'),
  operations: z.array(z.object({
    op: z.enum(['replace', 'add', 'remove']).describe('Operation type'),
    path: z.string().describe('JSONPath to the property to modify'),
    value: z.any().optional().describe('New value for replace/add operations'),
  })).optional().describe('Array of patch operations for targeted updates'),
  message: z.string().optional().describe('Set a commit message for the version history'),
  folderUid: z.string().optional().describe('The UID of the dashboard\'s folder'),
  overwrite: z.boolean().optional().describe('Overwrite the dashboard if it exists'),
});

// Tool definitions
export const getDashboardByUid: ToolDefinition = {
  name: 'get_dashboard_by_uid',
  description: 'Retrieves the complete dashboard, including panels, variables, and settings, for a specific dashboard identified by its UID',
  inputSchema: GetDashboardByUidSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = new GrafanaClient(context.config.grafanaConfig);
      const dashboard = await client.getDashboardByUid(params.uid);
      return createToolResult(dashboard);
    } catch (error: any) {
      return createErrorResult(error.message);
    }
  },
};

export const getDashboardSummary: ToolDefinition = {
  name: 'get_dashboard_summary',
  description: 'Get a compact summary of a dashboard including title, panel count, panel types, variables, and other metadata',
  inputSchema: GetDashboardSummarySchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = new GrafanaClient(context.config.grafanaConfig);
      const dashboard = await client.getDashboardByUid(params.uid);
      
      const summary = {
        uid: dashboard.uid,
        title: dashboard.title,
        tags: dashboard.tags || [],
        panelCount: dashboard.panels?.length || 0,
        panelTypes: [...new Set(dashboard.panels?.map((p: any) => p.type) || [])],
        variables: dashboard.templating?.list?.map((v: any) => ({
          name: v.name,
          type: v.type,
          label: v.label,
        })) || [],
        version: dashboard.version,
        schemaVersion: dashboard.schemaVersion,
      };
      
      return createToolResult(summary);
    } catch (error: any) {
      return createErrorResult(error.message);
    }
  },
};

export const getDashboardProperty: ToolDefinition = {
  name: 'get_dashboard_property',
  description: 'Get specific parts of a dashboard using JSONPath expressions to minimize context window usage',
  inputSchema: GetDashboardPropertySchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = new GrafanaClient(context.config.grafanaConfig);
      const dashboard = await client.getDashboardByUid(params.uid);
      
      const result = jsonpath.query(dashboard, params.jsonPath);
      
      if (result.length === 0) {
        return createToolResult('No matching properties found for the given JSONPath');
      }
      
      return createToolResult(result);
    } catch (error: any) {
      return createErrorResult(error.message);
    }
  },
};

export const getDashboardPanelQueries: ToolDefinition = {
  name: 'get_dashboard_panel_queries',
  description: 'Retrieve panel queries and information from a Grafana dashboard',
  inputSchema: GetDashboardPanelQueriesSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = new GrafanaClient(context.config.grafanaConfig);
      const dashboard = await client.getDashboardByUid(params.uid);
      
      const panels = dashboard.panels || [];
      const queries = panels.map((panel: any) => ({
        title: panel.title,
        panelId: panel.id,
        queries: panel.targets?.map((target: any) => ({
          query: target.expr || target.query || target.rawSql || '',
          datasource: target.datasource,
          refId: target.refId,
        })) || [],
      }));
      
      return createToolResult(queries);
    } catch (error: any) {
      return createErrorResult(error.message);
    }
  },
};

export const updateDashboard: ToolDefinition = {
  name: 'update_dashboard',
  description: 'Create or update a dashboard using either full JSON or efficient patch operations',
  isWrite: true,
  inputSchema: UpdateDashboardSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = new GrafanaClient(context.config.grafanaConfig);
      
      let dashboard: any;
      
      if (params.dashboard) {
        // Full dashboard update
        dashboard = params.dashboard;
      } else if (params.uid && params.operations) {
        // Patch operations
        dashboard = await client.getDashboardByUid(params.uid);
        
        for (const op of params.operations) {
          switch (op.op) {
            case 'replace':
              jsonpath.apply(dashboard, op.path, () => op.value);
              break;
            case 'add':
              if (op.path.endsWith('/-')) {
                // Append to array
                const arrayPath = op.path.slice(0, -2);
                const array = jsonpath.query(dashboard, arrayPath)[0];
                if (Array.isArray(array)) {
                  array.push(op.value);
                }
              } else {
                jsonpath.apply(dashboard, op.path, () => op.value);
              }
              break;
            case 'remove':
              // Remove property
              const parentPath = op.path.substring(0, op.path.lastIndexOf('.'));
              const propertyName = op.path.substring(op.path.lastIndexOf('.') + 1);
              const parent = jsonpath.query(dashboard, parentPath)[0];
              if (parent && typeof parent === 'object') {
                delete parent[propertyName];
              }
              break;
          }
        }
      } else {
        return createErrorResult('Either dashboard or uid+operations must be provided');
      }
      
      const result = await client.updateDashboard(dashboard, params.message);
      return createToolResult(result);
    } catch (error: any) {
      return createErrorResult(error.message);
    }
  },
};

export function registerDashboardTools(server: any) {
  server.registerTool(getDashboardByUid);
  server.registerTool(getDashboardSummary);
  server.registerTool(getDashboardProperty);
  server.registerTool(getDashboardPanelQueries);
  server.registerTool(updateDashboard);
}