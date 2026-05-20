import { z } from 'zod';
import { ToolDefinition, ToolContext, createToolResult, createErrorResult } from '../server/mcp-server';
import { PrometheusClient } from '../clients/prometheus-client';

const QueryPrometheusSchema = z.object({
  datasourceUid: z.string().describe('The UID of the datasource to query'),
  expr: z.string().describe('The PromQL expression to query'),
  queryType: z.enum(['range', 'instant']).describe('The type of query to use'),
  startTime: z.string().describe('The start time (RFC3339 or relative like "now-1h")'),
  endTime: z.string().optional().describe('The end time for range queries'),
  stepSeconds: z.number().optional().describe('The time series step size in seconds for range queries'),
});

const ListPrometheusMetricNamesSchema = z.object({
  datasourceUid: z.string().describe('The UID of the datasource to query'),
  regex: z.string().optional().describe('The regex to match against the metric names'),
  limit: z.number().optional().describe('The maximum number of results to return'),
  page: z.number().optional().describe('The page number to return'),
});

const ListPrometheusLabelNamesSchema = z.object({
  datasourceUid: z.string().describe('The UID of the datasource to query'),
  matches: z.array(z.object({
    filters: z.array(z.object({
      name: z.string().describe('The name of the label to match against'),
      value: z.string().describe('The value to match against'),
      type: z.enum(['=', '!=', '=~', '!~']).describe('The match operator'),
    })),
  })).optional().describe('Label matchers to filter the results'),
  startRfc3339: z.string().optional().describe('The start time of the time range'),
  endRfc3339: z.string().optional().describe('The end time of the time range'),
  limit: z.number().optional().describe('Maximum number of results'),
});

const ListPrometheusLabelValuesSchema = z.object({
  datasourceUid: z.string().describe('The UID of the datasource to query'),
  labelName: z.string().describe('The name of the label to query'),
  matches: z.array(z.object({
    filters: z.array(z.object({
      name: z.string().describe('The name of the label to match against'),
      value: z.string().describe('The value to match against'),
      type: z.enum(['=', '!=', '=~', '!~']).describe('The match operator'),
    })),
  })).optional().describe('Selectors to filter the results'),
  startRfc3339: z.string().optional().describe('The start time of the query'),
  endRfc3339: z.string().optional().describe('The end time of the query'),
  limit: z.number().optional().describe('Maximum number of results'),
});

const ListPrometheusMetricMetadataSchema = z.object({
  datasourceUid: z.string().describe('The UID of the datasource to query'),
  metric: z.string().optional().describe('The metric to query'),
  limit: z.number().optional().describe('The maximum number of metrics to return'),
  limitPerMetric: z.number().optional().describe('The maximum number of metrics to return per metric'),
});

// Helper function to convert relative time to Unix timestamp
function parseTime(time: string): string {
  if (time === 'now') {
    return Math.floor(Date.now() / 1000).toString();
  }
  
  const relativeMatch = time.match(/^now-(\d+)([smhd])$/);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1]);
    const unit = relativeMatch[2];
    let seconds = 0;
    
    switch (unit) {
      case 's': seconds = value; break;
      case 'm': seconds = value * 60; break;
      case 'h': seconds = value * 3600; break;
      case 'd': seconds = value * 86400; break;
    }
    
    return Math.floor((Date.now() / 1000) - seconds).toString();
  }
  
  // Assume it's already a Unix timestamp or RFC3339
  return time;
}

// Helper to build Prometheus selector from filters
function buildSelector(filters: any[]): string {
  if (!filters || filters.length === 0) return '{}';
  
  const parts = filters.map(f => {
    switch (f.type) {
      case '=': return `${f.name}="${f.value}"`;
      case '!=': return `${f.name}!="${f.value}"`;
      case '=~': return `${f.name}=~"${f.value}"`;
      case '!~': return `${f.name}!~"${f.value}"`;
      default: return '';
    }
  }).filter(p => p);
  
  return `{${parts.join(',')}}`;
}

export const queryPrometheus: ToolDefinition = {
  name: 'query_prometheus',
  description: 'Query Prometheus using a PromQL expression. Supports both instant and range queries.',
  inputSchema: QueryPrometheusSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = new PrometheusClient(context.config.grafanaConfig, params.datasourceUid);
      
      let result;
      if (params.queryType === 'instant') {
        result = await client.query(params.expr, parseTime(params.startTime));
      } else {
        const start = parseTime(params.startTime);
        const end = params.endTime ? parseTime(params.endTime) : 'now';
        const step = params.stepSeconds ? `${params.stepSeconds}s` : '60s';
        result = await client.queryRange(params.expr, start, end, step);
      }
      
      return createToolResult(result);
    } catch (error: any) {
      return createErrorResult(error.message);
    }
  },
};

export const listPrometheusMetricNames: ToolDefinition = {
  name: 'list_prometheus_metric_names',
  description: 'List metric names in a Prometheus datasource. Retrieves all metric names and filters them using regex.',
  inputSchema: ListPrometheusMetricNamesSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = new PrometheusClient(context.config.grafanaConfig, params.datasourceUid);

      // Use /api/v1/label/__name__/values — purpose-built for this, orders of
      // magnitude cheaper than /api/v1/series?match[]={__name__=~".+"}
      let names = (await client.getLabelValues('__name__')).sort();
      
      // Apply regex filter if provided
      if (params.regex) {
        const regex = new RegExp(params.regex);
        names = names.filter(name => regex.test(name));
      }
      
      // Apply pagination
      if (params.limit || params.page) {
        const limit = params.limit || 100;
        const page = params.page || 1;
        const start = (page - 1) * limit;
        names = names.slice(start, start + limit);
      }
      
      return createToolResult(names);
    } catch (error: any) {
      return createErrorResult(error.message);
    }
  },
};

export const listPrometheusLabelNames: ToolDefinition = {
  name: 'list_prometheus_label_names',
  description: 'List label names in a Prometheus datasource. Allows filtering by series selectors and time range.',
  inputSchema: ListPrometheusLabelNamesSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = new PrometheusClient(context.config.grafanaConfig, params.datasourceUid);
      
      const match = params.matches?.map((m: any) => buildSelector(m.filters)) || [];
      const labels = await client.getLabelNames(
        match.length > 0 ? match : undefined,
        params.startRfc3339,
        params.endRfc3339
      );
      
      const limited = params.limit ? labels.slice(0, params.limit) : labels;
      
      return createToolResult(limited);
    } catch (error: any) {
      return createErrorResult(error.message);
    }
  },
};

export const listPrometheusLabelValues: ToolDefinition = {
  name: 'list_prometheus_label_values',
  description: 'Get the values for a specific label name in Prometheus. Allows filtering by series selectors and time range.',
  inputSchema: ListPrometheusLabelValuesSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = new PrometheusClient(context.config.grafanaConfig, params.datasourceUid);
      
      const match = params.matches?.map((m: any) => buildSelector(m.filters)) || [];
      const values = await client.getLabelValues(
        params.labelName,
        match.length > 0 ? match : undefined,
        params.startRfc3339,
        params.endRfc3339
      );
      
      const limited = params.limit ? values.slice(0, params.limit) : values;
      
      return createToolResult(limited);
    } catch (error: any) {
      return createErrorResult(error.message);
    }
  },
};

export const listPrometheusMetricMetadata: ToolDefinition = {
  name: 'list_prometheus_metric_metadata',
  description: 'List Prometheus metric metadata. Returns metadata about metrics currently scraped from targets.',
  inputSchema: ListPrometheusMetricMetadataSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = new PrometheusClient(context.config.grafanaConfig, params.datasourceUid);
      
      const metadata = await client.getMetricMetadata(params.metric, params.limit);
      
      return createToolResult(metadata);
    } catch (error: any) {
      return createErrorResult(error.message);
    }
  },
};

export function registerPrometheusTools(server: any) {
  server.registerTool(queryPrometheus);
  server.registerTool(listPrometheusMetricNames);
  server.registerTool(listPrometheusLabelNames);
  server.registerTool(listPrometheusLabelValues);
  server.registerTool(listPrometheusMetricMetadata);
}