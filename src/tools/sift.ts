import { z } from 'zod';
import { ToolDefinition, ToolContext, createToolResult, createErrorResult } from '../server/mcp-server';
import axios from 'axios';

// Schema definitions
const ListSiftInvestigationsSchema = z.object({
  limit: z.number().optional().describe('Maximum number of investigations to return'),
});

const GetSiftInvestigationSchema = z.object({
  id: z.string().describe('The UUID of the investigation'),
});

const GetSiftAnalysisSchema = z.object({
  investigationId: z.string().describe('The UUID of the investigation'),
  analysisId: z.string().describe('The UUID of the specific analysis'),
});

const FindSlowRequestsSchema = z.object({
  name: z.string().describe('The name of the investigation'),
  labels: z.record(z.string()).describe('Labels to scope the analysis'),
  start: z.string().optional().describe('Start time for the investigation'),
  end: z.string().optional().describe('End time for the investigation'),
});

const FindErrorPatternLogsSchema = z.object({
  name: z.string().describe('The name of the investigation'),
  labels: z.record(z.string()).describe('Labels to scope the analysis'),
  start: z.string().optional().describe('Start time for the investigation'),
  end: z.string().optional().describe('End time for the investigation'),
});

// Helper function to create Sift client
function createSiftClient(config: any) {
  const headers: any = {
    'User-Agent': 'mcp-grafana/1.0.0',
    'Content-Type': 'application/json',
  };
  
  if (config.serviceAccountToken) {
    headers['Authorization'] = `Bearer ${config.serviceAccountToken}`;
  } else if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  
  // Sift uses a different base URL pattern
  const baseUrl = config.url.replace(/\/$/, '');
  const siftUrl = baseUrl.includes('grafana.net') 
    ? baseUrl.replace('grafana.net', 'sift.grafana.net')
    : `${baseUrl}/api/plugins/grafana-sift-app/resources`;
  
  return axios.create({
    baseURL: siftUrl,
    headers,
    timeout: 60000, // Longer timeout for investigations
  });
}

// Tool definitions
export const listSiftInvestigations: ToolDefinition = {
  name: 'list_sift_investigations',
  description: 'Retrieves a list of Sift investigations with an optional limit',
  inputSchema: ListSiftInvestigationsSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = createSiftClient(context.config.grafanaConfig);
      
      const response = await client.get('/api/v1/investigations', {
        params: { limit: params.limit || 10 },
      });
      
      const investigations = response.data.investigations || [];
      
      // Format the response
      const formatted = investigations.map((inv: any) => ({
        id: inv.id,
        name: inv.name,
        status: inv.status,
        createdAt: inv.created_at,
        updatedAt: inv.updated_at,
        analyses: inv.analyses?.length || 0,
      }));
      
      return createToolResult(formatted);
    } catch (error: any) {
      return createErrorResult(error.response?.data?.message || error.message);
    }
  },
};

export const getSiftInvestigation: ToolDefinition = {
  name: 'get_sift_investigation',
  description: 'Retrieves an existing Sift investigation by its UUID',
  inputSchema: GetSiftInvestigationSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = createSiftClient(context.config.grafanaConfig);
      
      const response = await client.get(`/api/v1/investigations/${params.id}`);
      
      return createToolResult(response.data);
    } catch (error: any) {
      return createErrorResult(error.response?.data?.message || error.message);
    }
  },
};

export const getSiftAnalysis: ToolDefinition = {
  name: 'get_sift_analysis',
  description: 'Retrieves a specific analysis from an investigation by its UUID',
  inputSchema: GetSiftAnalysisSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = createSiftClient(context.config.grafanaConfig);
      
      const response = await client.get(
        `/api/v1/investigations/${params.investigationId}/analyses/${params.analysisId}`
      );
      
      return createToolResult(response.data);
    } catch (error: any) {
      return createErrorResult(error.response?.data?.message || error.message);
    }
  },
};

export const findSlowRequests: ToolDefinition = {
  name: 'find_slow_requests',
  description: 'Searches relevant Tempo datasources for slow requests and returns the results',
  isWrite: true,
  inputSchema: FindSlowRequestsSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = createSiftClient(context.config.grafanaConfig);
      
      // Create investigation
      const investigationData = {
        name: params.name,
        start: params.start || new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        end: params.end || new Date().toISOString(),
        labels: params.labels,
        analyses: [
          {
            type: 'slow_requests',
            parameters: {
              labels: params.labels,
            },
          },
        ],
      };
      
      const response = await client.post('/api/v1/investigations', investigationData);
      const investigationId = response.data.id;
      
      // Poll for results (simplified - real implementation would need proper polling)
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const resultResponse = await client.get(`/api/v1/investigations/${investigationId}`);
      
      return createToolResult({
        investigationId,
        status: resultResponse.data.status,
        analyses: resultResponse.data.analyses,
        message: 'Investigation started. Check status for results.',
      });
    } catch (error: any) {
      return createErrorResult(error.response?.data?.message || error.message);
    }
  },
};

export const findErrorPatternLogs: ToolDefinition = {
  name: 'find_error_pattern_logs',
  description: 'Searches Loki logs for elevated error patterns and returns the results',
  isWrite: true,
  inputSchema: FindErrorPatternLogsSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = createSiftClient(context.config.grafanaConfig);
      
      // Create investigation
      const investigationData = {
        name: params.name,
        start: params.start || new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        end: params.end || new Date().toISOString(),
        labels: params.labels,
        analyses: [
          {
            type: 'error_patterns',
            parameters: {
              labels: params.labels,
            },
          },
        ],
      };
      
      const response = await client.post('/api/v1/investigations', investigationData);
      const investigationId = response.data.id;
      
      // Poll for results (simplified - real implementation would need proper polling)
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const resultResponse = await client.get(`/api/v1/investigations/${investigationId}`);
      
      return createToolResult({
        investigationId,
        status: resultResponse.data.status,
        analyses: resultResponse.data.analyses,
        message: 'Investigation started. Check status for results.',
      });
    } catch (error: any) {
      return createErrorResult(error.response?.data?.message || error.message);
    }
  },
};

export function registerSiftTools(server: any) {
  server.registerTool(listSiftInvestigations);
  server.registerTool(getSiftInvestigation);
  server.registerTool(getSiftAnalysis);
  server.registerTool(findSlowRequests);
  server.registerTool(findErrorPatternLogs);
}