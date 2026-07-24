import type { ErrorDescriptor } from "@imgent/contracts";

export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_APP_VERSION = "0.1.0";
export const CONTROL_BODY_LIMIT = 1024 * 1024;
export const CONTROL_REQUEST_TIMEOUT_MS = 2_000;

export type ServiceState = "starting" | "ready" | "degraded" | "stopping";

export interface ControlMeta {
  protocolVersion: number;
  appVersion: string;
  instanceId: string;
  instanceKey: string;
  state: ServiceState;
  startedAt: string;
  configHash: string;
}

export interface ControlSuccess<T> {
  ok: true;
  data: T;
  requestId: string;
}

export interface ControlFailure {
  ok: false;
  error: ErrorDescriptor;
  requestId: string;
}

export type ControlResponse<T> = ControlSuccess<T> | ControlFailure;
