#!/usr/bin/env node

/**
 * site-sense Native Messaging Host
 *
 * Thin relay between Chrome extension (native messaging on stdin/stdout)
 * and the MCP server (Unix domain socket).
 *
 * Chrome starts this process when the extension calls connectNative().
 * It connects to the MCP server's socket and pipes messages both ways.
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  encodeNativeMessage,
  createNativeMessageReader,
} from './native-messaging.js';

const SOCKET_DIR = path.join(os.tmpdir(), 'site-sense');

// Scan directory for bridge-*.sock files, sorted newest first (by mtime)
function findSockets(): string[] {
  try {
    return fs.readdirSync(SOCKET_DIR)
      .filter(f => /^bridge-\d+\.sock$/.test(f))
      .map(f => ({ path: path.join(SOCKET_DIR, f), mtime: fs.statSync(path.join(SOCKET_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => f.path);
  } catch {
    return [];
  }
}

function main() {
  const sockets = findSockets();
  if (sockets.length === 0) {
    const errorMsg = encodeNativeMessage({
      type: 'error',
      error: 'No MCP server running. Start a CLI session first.',
    });
    process.stdout.write(errorMsg);
    process.exit(1);
  }

  // Try the most recent socket
  const socket = net.createConnection(sockets[0]);

  // Extension → MCP server: read native messaging from stdin, forward to socket
  const stdinReader = createNativeMessageReader();

  process.stdin.on('data', (chunk: Buffer) => {
    stdinReader.push(chunk);
    let msg: unknown;
    while ((msg = stdinReader.read()) !== null) {
      const encoded = encodeNativeMessage(msg);
      socket.write(encoded);
    }
  });

  // MCP server → Extension: read from socket, write native messaging to stdout
  const socketReader = createNativeMessageReader();

  socket.on('data', (chunk: Buffer) => {
    socketReader.push(chunk);
    let msg: unknown;
    while ((msg = socketReader.read()) !== null) {
      const encoded = encodeNativeMessage(msg);
      process.stdout.write(encoded);
    }
  });

  // Error handling
  socket.on('error', (err: Error) => {
    const errorMsg = encodeNativeMessage({
      type: 'error',
      error: `Failed to connect to MCP server: ${err.message}. Is the MCP server running?`,
    });
    process.stdout.write(errorMsg);
    process.exit(1);
  });

  socket.on('close', () => {
    process.exit(0);
  });

  process.stdin.on('end', () => {
    socket.destroy();
    process.exit(0);
  });
}

main();
