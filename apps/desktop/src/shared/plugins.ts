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

export type UserPluginPermission =
  | "canvas:read"
  | "canvas:write"
  | "presentation:read"
  | "presentation:write"
  | "storage";

export interface UserPluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  apiVersion: 1;
  permissions: UserPluginPermission[];
  commands: { id: string; title: string }[];
}

export interface UserPluginPackage {
  manifest: UserPluginManifest;
  source: string;
}

export interface UserPluginState {
  manifest: UserPluginManifest;
  enabled: boolean;
  status: PluginStatus;
  error?: string;
}
