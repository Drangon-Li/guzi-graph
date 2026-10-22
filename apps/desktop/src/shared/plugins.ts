export type PluginStatus = "disabled" | "starting" | "running" | "error";

export interface PluginState {
  id: string;
  name: string;
  description: string;
  version: string;
  capabilities: string[];
  enabled: boolean;
  status: PluginStatus;
  port: number;
  endpoint?: string;
  token?: string;
  error?: string;
}

export interface PluginRequest {
  requestId: string;
  command: string;
  arguments: Record<string, unknown>;
  expiresAt?: number;
}

export interface PluginResponse {
  requestId: string;
  result?: unknown;
  error?: { code: string; message: string };
}
