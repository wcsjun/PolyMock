export interface RouteResponse {
  status: number;
  contentType?: string;
  body: unknown;
}

export interface Route {
  id: string;
  protocol: 'http';
  method: string;
  path: string;
  response: RouteResponse;
  createdAt: number;
}
