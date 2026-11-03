// A minimal MCP client for tests: connects to a server over an in-memory
// transport pair and sends JSON-RPC requests, without the client package.

import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';

export interface TestClient {
  /** The server's answer to initialize: serverInfo, capabilities, instructions. */
  readonly initialized: { readonly instructions?: string; readonly serverInfo: { readonly name: string } };
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** tools/call; the result's content blocks, and whether it's an error result. */
  callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: ContentBlock[] }>;
  close(): Promise<void>;
}

export type ContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export async function connect(server: McpServer): Promise<TestClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  clientSide.onmessage = (message) => {
    const response = message as { id?: number; result?: unknown; error?: { code: number; message: string } };
    if (response.id === undefined) return; // a notification
    const waiting = pending.get(response.id);
    pending.delete(response.id);
    if (response.error !== undefined) waiting?.reject(new Error(`${response.error.code}: ${response.error.message}`));
    else waiting?.resolve(response.result);
  };
  await server.connect(serverSide);
  await clientSide.start();

  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      void clientSide.send({ jsonrpc: '2.0', id, method, params });
    });

  const initialized = (await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } })) as TestClient['initialized'];
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    initialized,
    request,
    async callTool(name, args) {
      const result = (await request('tools/call', { name, arguments: args })) as { isError?: boolean; content: ContentBlock[] };
      return { isError: result.isError === true, content: result.content };
    },
    close: () => clientSide.close(),
  };
}
