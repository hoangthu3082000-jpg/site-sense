/**
 * Inject script — runs in page context (world: "MAIN").
 *
 * Walks the DOM to build a compact accessibility tree.
 * Sends result to content script via window.postMessage.
 *
 * Limits: MAX_NODES=4000, MAX_DEPTH=30, labels truncated 100 chars.
 */

import { CAPTURE_MESSAGE_TYPE, type AccessibilityNode } from '../../shared/types';

// Guard against double-injection
declare global { interface Window { __siteSenseCaptureInstalled?: boolean; __siteSenseCaptureMode?: string } }
if (!window.__siteSenseCaptureInstalled) {
  window.__siteSenseCaptureInstalled = true;
}

const captureMode = (window.__siteSenseCaptureMode || 'compact') as 'compact' | 'full';
const MAX_NODES = captureMode === 'full' ? 4000 : 500;
const MAX_DEPTH = captureMode === 'full' ? 30 : 15;
const MAX_LABEL = captureMode === 'full' ? 100 : 60;
let nodeCount = 0;

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'CIRCLE',
  'RECT', 'LINE', 'POLYGON', 'POLYLINE', 'ELLIPSE',
]);

const INTERACTIVE_TAGS = new Set([
  'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY',
]);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'combobox', 'listbox', 'option', 'searchbox',
  'textbox', 'treeitem',
]);

const LANDMARK_TAGS = new Set(['NAV', 'MAIN', 'HEADER', 'FOOTER', 'SECTION', 'ARTICLE']);

function isVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  // Reject off-screen elements (common trick to hide injected content)
  if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight + 500 || rect.left > window.innerWidth + 500) return false;
  return true;
}

// Elements whose text content may contain secrets
const SENSITIVE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

// Strip injection markers and invisible characters from captured text
const INJECTION_TAGS = /<\/?(?:IMPORTANT|system|instructions|prompt|ignore|cmd)[^>]*>/gi;
const INVISIBLE_UNICODE = /[\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u00AD\u034F\u061C\u180E]/g;
const ANSI_ESCAPE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function sanitizeText(text: string): string {
  return text
    .replace(INJECTION_TAGS, '')
    .replace(INVISIBLE_UNICODE, '')
    .replace(ANSI_ESCAPE, '')
    .substring(0, MAX_LABEL);
}

function getLabel(el: Element): string {
  if (SENSITIVE_TAGS.has(el.tagName)) {
    return sanitizeText(el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');
  }
  const raw =
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    el.getAttribute('alt') ||
    (el as HTMLElement).innerText?.trim() ||
    '';
  return sanitizeText(raw);
}

const SAFE_HREF_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function sanitizeHref(href: string): string {
  try {
    const url = new URL(href);
    if (!SAFE_HREF_PROTOCOLS.has(url.protocol)) return ''; // reject javascript:, data:, etc.
    return url.origin + url.pathname;
  } catch {
    return ''; // reject unparseable URIs
  }
}

function walkDOM(el: Element, depth = 0): AccessibilityNode | null {
  if (depth > MAX_DEPTH || nodeCount >= MAX_NODES) return null;
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
  if (SKIP_TAGS.has(el.tagName)) return null;
  if (!isVisible(el)) return null;

  nodeCount++;

  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role') || undefined;
  const name = getLabel(el) || undefined;
  const isInteractive =
    INTERACTIVE_TAGS.has(el.tagName) ||
    INTERACTIVE_ROLES.has(role || '') ||
    el.hasAttribute('onclick') ||
    el.hasAttribute('tabindex');

  const children: AccessibilityNode[] = [];
  for (const child of el.children) {
    if (nodeCount >= MAX_NODES) break;
    const node = walkDOM(child, depth + 1);
    if (node) children.push(node);
  }

  if (!isInteractive && !name && children.length === 0) return null;
  // Compact mode: skip non-interactive, non-landmark nodes (keep only actionable elements)
  if (captureMode === 'compact' && !isInteractive && !LANDMARK_TAGS.has(el.tagName) && children.length === 0) return null;
  if (!isInteractive && !name && !role && children.length === 1 && !LANDMARK_TAGS.has(el.tagName)) {
    return children[0];
  }

  const node: AccessibilityNode = { tag };
  if (role) node.role = role;
  if (name) node.name = name;
  if (isInteractive) {
    node.interactive = true;
    const rect = el.getBoundingClientRect();
    node.boundingBox = {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    };
  }
  if (el.tagName === 'A' && (el as HTMLAnchorElement).href) {
    const href = sanitizeHref((el as HTMLAnchorElement).href);
    if (href) node.href = href;
  }
  if (children.length > 0) node.children = children;
  return node;
}

// Execute
nodeCount = 0;
const tree = walkDOM(document.body) || { tag: 'body', children: [] };
window.postMessage({ type: CAPTURE_MESSAGE_TYPE, tree }, location.origin);
