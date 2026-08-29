import { app, session, shell, type BrowserWindow, type WebContents } from 'electron';

const DEV_SERVER_ORIGIN = process.env['ELECTRON_RENDERER_URL'];

/**
 * TraceDeck analyses private source code and must never become a channel for it to leave the
 * machine. These hardening steps are deliberately redundant: the renderer has no Node access,
 * cannot navigate away from the bundled UI, and any outbound request that is not the local
 * dev server or a local file is cancelled at the session layer.
 */

function isAllowedRequestUrl(rawUrl: string): boolean {
  if (rawUrl.startsWith('file://') || rawUrl.startsWith('devtools://')) return true;
  if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return true;
  if (DEV_SERVER_ORIGIN && rawUrl.startsWith(DEV_SERVER_ORIGIN)) return true;
  // The Vite dev client uses a websocket on the same origin.
  if (DEV_SERVER_ORIGIN && rawUrl.startsWith(DEV_SERVER_ORIGIN.replace(/^http/, 'ws'))) return true;
  return false;
}

function isAllowedNavigationUrl(rawUrl: string): boolean {
  if (rawUrl.startsWith('file://')) return true;
  if (DEV_SERVER_ORIGIN && rawUrl.startsWith(DEV_SERVER_ORIGIN)) return true;
  return false;
}

function contentSecurityPolicy(): string {
  const directives = [
    "default-src 'self'",
    "script-src 'self' blob:",
    // Tailwind and Cytoscape both inject inline style attributes at runtime.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ];

  if (DEV_SERVER_ORIGIN) {
    const ws = DEV_SERVER_ORIGIN.replace(/^http/, 'ws');
    // The dev server needs eval for the HMR runtime and a websocket for updates.
    directives[1] = `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${DEV_SERVER_ORIGIN}`;
    directives[5] = `connect-src 'self' ${DEV_SERVER_ORIGIN} ${ws}`;
  }

  return directives.join('; ');
}

/** Applied once, before any window is created. */
export function applyProcessSecurity(): void {
  app.enableSandbox();
}

export function applySessionSecurity(): void {
  const defaultSession = session.defaultSession;

  defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequestUrl(details.url) });
  });

  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy()],
      },
    });
  });

  // No feature of TraceDeck needs camera, microphone, geolocation, or notifications.
  defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  defaultSession.setPermissionCheckHandler(() => false);
}

export function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    // External links are handed to the OS browser rather than opened in a privileged window.
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigationUrl(url)) {
      event.preventDefault();
    }
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

export function hardenWindow(window: BrowserWindow): void {
  hardenWebContents(window.webContents);
}
