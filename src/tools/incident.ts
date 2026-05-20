import { z } from 'zod';
import { ToolDefinition, ToolContext, createToolResult, createErrorResult } from '../server/mcp-server';
import axios from 'axios';

// Schema definitions
const ListIncidentsSchema = z.object({
  status: z.enum(['active', 'resolved']).optional().describe('The status of incidents to include'),
  drill: z.boolean().optional().describe('Whether to include drill incidents'),
  limit: z.number().optional().describe('Maximum number of incidents to return'),
});

const GetIncidentSchema = z.object({
  id: z.string().describe('The ID of the incident to retrieve'),
});

const CreateIncidentSchema = z.object({
  title: z.string().describe('The title of the incident'),
  severity: z.string().describe('The severity of the incident'),
  status: z.string().optional().describe('The status of the incident'),
  roomPrefix: z.string().describe('The prefix of the room to create the incident in'),
  isDrill: z.boolean().optional().describe('Whether the incident is a drill'),
  labels: z.array(z.object({
    key: z.string(),
    label: z.string(),
    description: z.string().optional(),
    colorHex: z.string().optional(),
  })).optional().describe('Labels to add to the incident'),
  attachUrl: z.string().optional().describe('URL of the attachment'),
  attachCaption: z.string().optional().describe('Caption of the attachment'),
});

const AddActivityToIncidentSchema = z.object({
  incidentId: z.string().describe('The ID of the incident to add activity to'),
  body: z.string().describe('The body of the activity'),
  eventTime: z.string().optional().describe('The time that the activity occurred'),
});

// Helper function to create incident client
function createIncidentClient(config: any) {
  const headers: any = {
    'User-Agent': 'mcp-grafana/1.0.0',
  };
  
  if (config.serviceAccountToken) {
    headers['Authorization'] = `Bearer ${config.serviceAccountToken}`;
  } else if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  
  return axios.create({
    baseURL: `${config.url}/api/plugins/grafana-incident-app/resources/api/v1`,
    headers,
    timeout: 30000,
  });
}

// Tool definitions
export const listIncidents: ToolDefinition = {
  name: 'list_incidents',
  description: 'List Grafana incidents. Allows filtering by status and optionally including drill incidents',
  inputSchema: ListIncidentsSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = createIncidentClient(context.config.grafanaConfig);
      
      const queryParams: any = {};
      if (params.status) queryParams.status = params.status;
      if (params.drill !== undefined) queryParams.includeDrills = params.drill;
      if (params.limit) queryParams.limit = params.limit;
      
      const response = await client.get('/IncidentService.QueryIncidents', { params: queryParams });
      
      const incidents = response.data.incidents || [];
      
      // Format the response
      const formatted = incidents.map((incident: any) => ({
        incidentID: incident.incidentID,
        title: incident.title,
        status: incident.status,
        severity: incident.severity,
        createdTime: incident.createdTime,
        modifiedTime: incident.modifiedTime,
        labels: incident.labels,
      }));
      
      return createToolResult(formatted);
    } catch (error: any) {
      return createErrorResult(error.response?.data?.message || error.message);
    }
  },
};

export const getIncident: ToolDefinition = {
  name: 'get_incident',
  description: 'Get a single incident by ID. Returns the full incident details',
  inputSchema: GetIncidentSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = createIncidentClient(context.config.grafanaConfig);
      const response = await client.get(`/IncidentService.GetIncident`, {
        params: { incidentID: params.id },
      });
      
      return createToolResult(response.data.incident);
    } catch (error: any) {
      return createErrorResult(error.response?.data?.message || error.message);
    }
  },
};

export const createIncident: ToolDefinition = {
  name: 'create_incident',
  description: 'Create a new Grafana incident. Requires title, severity, and room prefix',
  isWrite: true,
  inputSchema: CreateIncidentSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = createIncidentClient(context.config.grafanaConfig);
      
      const incidentData: any = {
        title: params.title,
        severity: params.severity,
        roomPrefix: params.roomPrefix,
      };
      
      if (params.status) incidentData.status = params.status;
      if (params.isDrill !== undefined) incidentData.isDrill = params.isDrill;
      if (params.labels) incidentData.labels = params.labels;
      
      const attachments = [];
      if (params.attachUrl) {
        attachments.push({
          attachmentID: 'attach-1',
          url: params.attachUrl,
          useToSummarize: true,
          caption: params.attachCaption,
        });
      }
      
      const response = await client.post('/IncidentService.CreateIncident', {
        incident: incidentData,
        attachments,
      });
      
      return createToolResult({
        incidentID: response.data.incident.incidentID,
        title: response.data.incident.title,
        status: response.data.incident.status,
        message: 'Incident created successfully',
      });
    } catch (error: any) {
      return createErrorResult(error.response?.data?.message || error.message);
    }
  },
};

export const addActivityToIncident: ToolDefinition = {
  name: 'add_activity_to_incident',
  description: 'Add a note (userNote activity) to an existing incident\'s timeline',
  isWrite: true,
  inputSchema: AddActivityToIncidentSchema,
  handler: async (params, context: ToolContext) => {
    try {
      const client = createIncidentClient(context.config.grafanaConfig);
      
      const activityData: any = {
        incidentID: params.incidentId,
        activityKind: 'userNote',
        body: params.body,
      };
      
      if (params.eventTime) {
        activityData.eventTime = params.eventTime;
      }
      
      const response = await client.post('/IncidentService.AddActivity', activityData);
      
      return createToolResult({
        success: true,
        message: 'Activity added to incident',
        activityID: response.data.activityID,
      });
    } catch (error: any) {
      return createErrorResult(error.response?.data?.message || error.message);
    }
  },
};

export function registerIncidentTools(server: any) {
  server.registerTool(listIncidents);
  server.registerTool(getIncident);
  server.registerTool(createIncident);
  server.registerTool(addActivityToIncident);
}