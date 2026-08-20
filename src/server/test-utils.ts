import type { Express } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export function listen(app: Express): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
    server.on('error', reject);
  });
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}