import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  encodeNativeMessage,
  createNativeMessageReader,
} from './native-messaging.js';

const SOCKET_DIR = path.join(os.tmpdir(), 'site-sense');

function findTestSocket(): string {
  const files = fs.readdirSync(SOCKET_DIR).filter(f => /^bridge-\d+\.sock$/.test(f));
  if (files.length === 0) throw new Error('No socket found');
  return path.join(SOCKET_DIR, files[files.length - 1]);
}

/**
 * Integration test: validates MCP server ↔ native host ↔ simulated extension.
 *
 * We start the MCP server, then connect a mock "native host" to the Unix socket,
 * simulating what the Chrome extension + native host relay would do.
 */
describe('MCP Server integration', () => {
  let mcpProcess: ChildProcess;
  let mcpReader: ReturnType<typeof createNativeMessageReader>;
  let mcpStdout = '';

  function sendMCPRequest(request: object): Promise<object> {
    return new Promise((resolve) => {
      const json = JSON.stringify(request) + '\n';
      mcpProcess.stdin!.write(json);

      const handler = (chunk: Buffer) => {
        mcpStdout += chunk.toString();
        const lines = mcpStdout.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === (request as { id: number }).id) {
              mcpProcess.stdout!.off('data', handler);
              mcpStdout = '';
              resolve(parsed);
              return;
            }
          } catch {
            // partial line, continue
          }
        }
      };

      mcpProcess.stdout!.on('data', handler);
    });
  }

  beforeAll(async () => {
    // Start MCP server
    const serverPath = path.resolve(
      import.meta.dirname,
      '../../dist/bridge/src/index.js'
    );

    mcpProcess = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for a bridge-*.sock to appear
    await new Promise<void>((resolve, reject) => {
      const maxWait = 5000;
      const start = Date.now();
      const check = () => {
        try {
          findTestSocket(); // throws if none found
          resolve();
        } catch {
          if (Date.now() - start > maxWait) reject(new Error('Socket never appeared'));
          else setTimeout(check, 100);
        }
      };
      check();
    });

    // Initialize MCP
    const initResp = await sendMCPRequest({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    });
    expect((initResp as any).result.serverInfo.name).toBe('site-sense');

    // Send initialized notification
    mcpProcess.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
        '\n'
    );
  });

  afterAll(() => {
    mcpProcess?.kill('SIGTERM');
  });

  it('lists two tools', async () => {
    const resp = await sendMCPRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const tools = (resp as any).result.tools;
    expect(tools).toHaveLength(2);
    expect(tools.map((t: any) => t.name).sort()).toEqual([
      'site_sense_capture',
      'site_sense_status',
    ]);
  });

  it('reports disconnected when no extension', async () => {
    const resp = await sendMCPRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'site_sense_status', arguments: {} },
    });
    const text = (resp as any).result.content[0].text;
    const status = JSON.parse(text);
    expect(status.connected).toBe(false);
  });

  it('returns error on capture when no extension', async () => {
    const resp = await sendMCPRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'site_sense_capture', arguments: {} },
    });
    const content = (resp as any).result.content[0];
    expect(content.text).toContain('not connected');
    expect((resp as any).result.isError).toBe(true);
  });

  it('relays capture via Unix socket to simulated extension', async () => {
    // Connect a mock extension to the socket
    const socket = net.createConnection(findTestSocket());
    const reader = createNativeMessageReader();

    await new Promise<void>((resolve) => socket.on('connect', resolve));

    // Request capture via MCP
    const capturePromise = sendMCPRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'site_sense_capture', arguments: {} },
    });

    // Mock extension reads the request from socket
    const captureReq = await new Promise<any>((resolve) => {
      socket.on('data', (chunk) => {
        reader.push(chunk);
        const msg = reader.read();
        if (msg) resolve(msg);
      });
    });

    expect(captureReq.type).toBe('capture_request');
    expect(captureReq.id).toBeTruthy();

    // Mock extension sends back a capture response
    const mockResponse = {
      type: 'capture_response',
      id: captureReq.id,
      status: 'captured',
      data: {
        url: 'https://example.com',
        title: 'Example Domain',
        accessibilityTree: [
          {
            tag: 'body',
            children: [
              {
                tag: 'a',
                name: 'More information...',
                href: 'https://www.iana.org/domains/example',
                interactive: true,
                boundingBox: { x: 50, y: 200, width: 180, height: 20 },
              },
            ],
          },
        ],
        screenshot: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
        timestamp: new Date().toISOString(),
      },
    };

    socket.write(encodeNativeMessage(mockResponse));

    // Verify MCP response
    const resp = await capturePromise;
    const content = (resp as any).result.content;

    // First content: text with URL, title, tree (wrapped in untrusted-data delimiters)
    const rawText = content[0].text;
    expect(rawText).toContain('[BEGIN UNTRUSTED PAGE CONTENT');
    expect(rawText).toContain('[END UNTRUSTED PAGE CONTENT]');
    // Extract JSON between delimiters
    const jsonStart = rawText.indexOf('{');
    const jsonEnd = rawText.lastIndexOf('}') + 1;
    const textContent = JSON.parse(rawText.substring(jsonStart, jsonEnd));
    expect(textContent.url).toContain('example.com');
    expect(textContent.title).toBe('Example Domain');
    expect(textContent.accessibilityTree).toBeDefined();

    // Second content: screenshot image
    expect(content[1].type).toBe('image');
    expect(content[1].mimeType).toBe('image/png');

    socket.destroy();
  });

  it('reports connected after extension connects', async () => {
    const socket = net.createConnection(findTestSocket());
    const reader = createNativeMessageReader();

    await new Promise<void>((resolve) => socket.on('connect', resolve));

    // Request status via MCP
    const statusPromise = sendMCPRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'site_sense_status', arguments: {} },
    });

    // Mock extension receives status_request and responds
    const statusReq = await new Promise<any>((resolve) => {
      socket.on('data', (chunk) => {
        reader.push(chunk);
        const msg = reader.read();
        if (msg) resolve(msg);
      });
    });

    expect(statusReq.type).toBe('status_request');

    socket.write(
      encodeNativeMessage({
        type: 'status_response',
        id: statusReq.id,
        connected: true,
        sessionApproved: true,
      })
    );

    const resp = await statusPromise;
    const status = JSON.parse((resp as any).result.content[0].text);
    expect(status.connected).toBe(true);
    expect(status.sessionApproved).toBe(true);

    socket.destroy();
  });
});
