export const DEFAULT_SERVICE_ID = 'default';

export interface RouteResponse {
  status: number;
  contentType?: string;
  body: unknown;
}

export interface Service {
  id: string;
  name: string;
  port: number;
  createdAt: number;
}

export interface Route {
  id: string;
  serviceId: string;
  protocol: 'http';
  method: string;
  path: string;
  name?: string;
  response: RouteResponse;
  createdAt: number;
}

export interface PersistedState {
  version: 1;
  services: Service[];
  routes: Route[];
}
