/**
 * Shared types for the entire site-sense pipe.
 * Single source of truth — imported by bridge AND extension.
 */

// ─── Accessibility Tree ─────────────────────────────────────────────

export interface AccessibilityNode {
  tag: string;
  role?: string;
  name?: string;
  interactive?: boolean;
  href?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
  children?: AccessibilityNode[];
}

// ─── Native Messaging Protocol (background ↔ MCP server) ───────────

export interface NativeCaptureRequest {
  type: 'capture_request';
  id: string;
  mode?: 'compact' | 'full';
}

export interface NativeCaptureResponse {
  type: 'capture_response';
  id: string;
  status: 'captured' | 'awaiting_approval' | 'denied' | 'error';
  data?: {
    url: string;
    title: string;
    accessibilityTree: AccessibilityNode[];
    screenshot: string;
    screenshotMimeType?: string;
    timestamp: string;
  };
  error?: string;
}

export interface NativeStatusRequest {
  type: 'status_request';
  id: string;
}

export interface NativeStatusResponse {
  type: 'status_response';
  id: string;
  connected: boolean;
  sessionApproved: boolean;
}

export type NativeMessage =
  | NativeCaptureRequest
  | NativeCaptureResponse
  | NativeStatusRequest
  | NativeStatusResponse;

// ─── Type Guards ────────────────────────────────────────────────────

export function isNativeCaptureRequest(msg: unknown): msg is NativeCaptureRequest {
  return (
    typeof msg === 'object' && msg !== null &&
    (msg as { type: string }).type === 'capture_request' &&
    typeof (msg as { id: unknown }).id === 'string'
  );
}

export function isNativeStatusRequest(msg: unknown): msg is NativeStatusRequest {
  return (
    typeof msg === 'object' && msg !== null &&
    (msg as { type: string }).type === 'status_request' &&
    typeof (msg as { id: unknown }).id === 'string'
  );
}

export function isNativeCaptureResponse(msg: unknown): msg is NativeCaptureResponse {
  return (
    typeof msg === 'object' && msg !== null &&
    (msg as { type: string }).type === 'capture_response' &&
    typeof (msg as { id: unknown }).id === 'string' &&
    typeof (msg as { status: unknown }).status === 'string'
  );
}

export function isNativeStatusResponse(msg: unknown): msg is NativeStatusResponse {
  return (
    typeof msg === 'object' && msg !== null &&
    (msg as { type: string }).type === 'status_response' &&
    typeof (msg as { id: unknown }).id === 'string' &&
    typeof (msg as { connected: unknown }).connected === 'boolean' &&
    typeof (msg as { sessionApproved: unknown }).sessionApproved === 'boolean'
  );
}

// ─── Inject → Content (postMessage) ─────────────────────────────────

export const CAPTURE_MESSAGE_TYPE = 'site-sense:capture' as const;

export interface InjectCaptureMessage {
  type: typeof CAPTURE_MESSAGE_TYPE;
  tree: AccessibilityNode;
}

export function isInjectCaptureMessage(data: unknown): data is InjectCaptureMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type: string }).type === CAPTURE_MESSAGE_TYPE &&
    'tree' in data &&
    typeof (data as { tree: unknown }).tree === 'object'
  );
}

// ─── Content → Background (chrome.runtime) ──────────────────────────

export type ContentMessage =
  | { type: 'capture_result'; tree: AccessibilityNode; url: string; title: string };

// ─── Popup → Background ─────────────────────────────────────────────

export type PopupMessage =
  | { type: 'session_approved' }
  | { type: 'session_denied' }
  | { type: 'get_state' }
  | { type: 'ping' }
  | { type: 'enable_all_sites' }
  | { type: 'disable_all_sites' };

export interface PopupStateResponse {
  sessionApproved: boolean;
  connected: boolean;
  hasPendingRequest: boolean;
}
