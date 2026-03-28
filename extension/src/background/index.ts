/**
 * Background service worker — dual permission mode.
 *
 * Default: activeTab (user clicks icon per page)
 * Power: all-sites (user enables toggle, content script registered globally)
 */

import {
  isNativeCaptureRequest,
  isNativeStatusRequest,
  type NativeCaptureResponse,
  type NativeStatusResponse,
  type ContentMessage,
  type PopupMessage,
  type PopupStateResponse,
  type AccessibilityNode,
} from '../../shared/types';

const NATIVE_HOST = 'com.sitesense.bridge';
const CAPTURE_TIMEOUT_MS = 8000;
const PING_ATTEMPTS = 10;
const PING_INTERVAL_MS = 100;
const CONTENT_SCRIPT_ID = 'site-sense-content';
const LOG = '[site-sense]';

// Reconnection: exponential backoff
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;
let reconnectDelay = RECONNECT_BASE_MS;

// ─── State ──────────────────────────────────────────────────────────

let sessionApproved = false;
let nativePort: chrome.runtime.Port | null = null;
let pendingCapture: { id: string; mode: 'compact' | 'full' } | null = null;
let allSitesMode = false;

// Capture coordination: Map of request ID → tree (supports concurrent captures)
const captureResults = new Map<string, AccessibilityNode>();
let captureInFlight = false; // concurrency lock

// ─── URL Validation (whitelist-first) ───────────────────────────────

const SAFE_PROTOCOLS = ['http://', 'https://'];

function isCapturableUrl(url: string | undefined): boolean {
  if (!url) return false;
  return SAFE_PROTOCOLS.some(p => url.startsWith(p));
}

// ─── Native Messaging ───────────────────────────────────────────────

function connectNative() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    reconnectDelay = RECONNECT_BASE_MS;

    nativePort.onMessage.addListener((msg: unknown) => {
      if (isNativeCaptureRequest(msg)) handleCaptureRequest(msg.id, msg.mode || 'compact');
      else if (isNativeStatusRequest(msg)) {
        sendNative({ type: 'status_response', id: msg.id, connected: true, sessionApproved } satisfies NativeStatusResponse);
      }
    });

    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      sessionApproved = false;
      disableAllSites();
      setTimeout(connectNative, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
    });
  } catch {
    setTimeout(connectNative, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
  }
}

function sendNative(msg: NativeCaptureResponse | NativeStatusResponse) {
  if (!nativePort) return;
  try { nativePort.postMessage(msg); } catch { /* closed */ }
}

// ─── All-Sites Mode ─────────────────────────────────────────────────

async function enableAllSites() {
  allSitesMode = true;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }).catch(() => {});
    await chrome.scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_ID,
      matches: ['http://*/*', 'https://*/*'],
      js: ['content.js'],
      runAt: 'document_idle' as chrome.scripting.RegisteredContentScript['runAt'],
      persistAcrossSessions: false,
    }]);
  } catch (err) {
    console.warn(LOG, 'registerContentScripts failed:', err);
  }
}

async function disableAllSites() {
  allSitesMode = false;
  try { await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }); }
  catch { /* not registered */ }
}

// ─── Content Script Readiness ───────────────────────────────────────

async function ensureContentScript(tabId: number): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ping' });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, PING_INTERVAL_MS));
    }
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    for (let i = 0; i < PING_ATTEMPTS; i++) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'ping' });
        return true;
      } catch {
        await new Promise(r => setTimeout(r, PING_INTERVAL_MS));
      }
    }
  } catch { /* no permission */ }

  return false;
}

// ─── Capture ────────────────────────────────────────────────────────

async function handleCaptureRequest(requestId: string, mode: 'compact' | 'full' = 'compact') {
  if (!sessionApproved) {
    pendingCapture = { id: requestId, mode };
    sendNative({ type: 'capture_response', id: requestId, status: 'awaiting_approval' });
    return;
  }

  // Concurrency lock: reject if another capture is in flight
  if (captureInFlight) {
    sendNative({
      type: 'capture_response', id: requestId, status: 'error',
      error: 'Another capture is in progress. Try again in a moment.',
    });
    return;
  }

  await performCapture(requestId, mode);
}

async function performCapture(requestId: string, mode: 'compact' | 'full' = 'compact') {
  captureInFlight = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id || !isCapturableUrl(tab.url)) {
      sendNative({
        type: 'capture_response', id: requestId, status: 'error',
        error: tab?.url ? `Cannot capture ${tab.url}` : 'No active tab',
      });
      return;
    }

    // Check window isn't minimized (screenshot would fail)
    if (tab.windowId) {
      try {
        const win = await chrome.windows.get(tab.windowId);
        if (win.state === 'minimized') {
          sendNative({
            type: 'capture_response', id: requestId, status: 'error',
            error: 'Cannot capture: browser window is minimized. Restore it first.',
          });
          return;
        }
      } catch { /* windows.get failed — continue anyway */ }
    }

    const ready = await ensureContentScript(tab.id);
    if (!ready) {
      const hint = allSitesMode
        ? 'Content script failed to load. Try refreshing the page.'
        : 'Click the site-sense icon on this page first, or enable "All-sites access" in the popup.';
      sendNative({ type: 'capture_response', id: requestId, status: 'error', error: hint });
      return;
    }

    // Set active request ID so content script result can be correlated
    activeRequestId = requestId;
    captureResults.delete(requestId);

    // Inject capture script — set mode in MAIN world before injection
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (m: string) => { (window as any).__siteSenseCaptureMode = m; },
      args: [mode],
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['inject.js'],
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
    });

    const tree = await waitForTree(requestId, CAPTURE_TIMEOUT_MS);

    // Screenshot: compact=JPEG quality 50 (~80KB), full=PNG (~1MB)
    let screenshot = '';
    let screenshotMimeType = 'image/png';
    try {
      if (mode === 'full') {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
        screenshot = dataUrl?.replace(/^data:image\/png;base64,/, '') || '';
        screenshotMimeType = 'image/png';
      } else {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 50 });
        screenshot = dataUrl?.replace(/^data:image\/jpeg;base64,/, '') || '';
        screenshotMimeType = 'image/jpeg';
      }
    } catch (err) {
      console.warn(LOG, 'screenshot failed (tab may have changed):', err);
    }

    sendNative({
      type: 'capture_response', id: requestId, status: 'captured',
      data: {
        url: tab.url!,
        title: tab.title || '',
        accessibilityTree: tree ? [tree] : [],
        screenshot,
        screenshotMimeType,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error(LOG, 'capture failed:', err);
    sendNative({
      type: 'capture_response', id: requestId, status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    captureInFlight = false;
    captureResults.delete(requestId);
  }
}

function waitForTree(requestId: string, timeoutMs: number): Promise<AccessibilityNode | null> {
  return new Promise((resolve) => {
    if (captureResults.has(requestId)) {
      resolve(captureResults.get(requestId)!);
      return;
    }

    const timer = setTimeout(() => { clearInterval(poller); resolve(null); }, timeoutMs);
    const poller = setInterval(() => {
      if (captureResults.has(requestId)) {
        clearTimeout(timer);
        clearInterval(poller);
        resolve(captureResults.get(requestId)!);
      }
    }, 50);
  });
}

// ─── Message Handling ───────────────────────────────────────────────

// Track the active request ID so content script results can be correlated
let activeRequestId: string | null = null;

chrome.runtime.onMessage.addListener((msg: ContentMessage | PopupMessage, sender, sendResponse) => {
  // Validate sender is our own extension
  if (sender.id !== chrome.runtime.id) return;

  if (msg.type === 'capture_result' && 'tree' in msg) {
    if (activeRequestId) {
      captureResults.set(activeRequestId, msg.tree);
    }
    return;
  }

  if (msg.type === 'ping') {
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'session_approved') {
    sessionApproved = true;
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id && isCapturableUrl(tab.url)) {
          try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
          } catch { /* no permission — OK for default mode */ }
        }
        if (pendingCapture) {
          const req = pendingCapture;
          pendingCapture = null;
          await performCapture(req.id, req.mode);
        }
      } catch (err) {
        console.error(LOG, 'session_approved handler failed:', err);
      }
    })();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'session_denied') {
    sessionApproved = false;
    if (pendingCapture) {
      sendNative({ type: 'capture_response', id: pendingCapture.id, status: 'denied' });
      pendingCapture = null;
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'enable_all_sites') {
    enableAllSites();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'disable_all_sites') {
    disableAllSites();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'get_state') {
    sendResponse({
      sessionApproved,
      connected: nativePort !== null,
      hasPendingRequest: pendingCapture !== null,
    } satisfies PopupStateResponse);
    return true;
  }
});

// ─── Cleanup ────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(() => {
  captureResults.clear();
  activeRequestId = null;
});

// ─── Initialize ─────────────────────────────────────────────────────

connectNative();
