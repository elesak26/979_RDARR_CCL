import { isAuthEnabled, beginLogin, clearSessionCache } from '../auth/oidc';

const BASE = '/api';
const STORAGE_KEY = 'ccl-dev-user';

// Authentication travels as the Core's encrypted httpOnly session cookie, which
// the browser attaches automatically — hence `credentials: 'include'` on every
// call and no Authorization / X-Id-Token header anywhere.
//
// There is deliberately NO pre-emptive expiry check here. The previous version
// asked getAccessToken(), which reported the token gone 30 seconds before it
// actually expired and triggered a full-page redirect to the IdP — that is what
// users saw as "it refreshed and moved me to another screen". The browser now
// has no idea when anything expires; it simply makes the call, and only a real
// 401 from the Core starts a new sign-in.
const withCreds = (init: RequestInit): RequestInit => ({ ...init, credentials: 'include' });

// A 401 now means one thing only: the server-side session is gone or expired.
// Start a fresh sign-in and return a never-settling promise so callers do not
// flash an error during the redirect that is already underway.
const REAUTH_KEY = 'ccl-reauth-at';
const REAUTH_COOLDOWN_MS = 30_000;

function reauthenticate<T>(): Promise<T> {
  // Guard against a redirect loop: if signing in again still yields 401 (e.g. the
  // identity has no matching user record), bouncing to the IdP would spin
  // forever. Only redirect if we have not just come back from one.
  const last = Number(sessionStorage.getItem(REAUTH_KEY) || 0);
  if (Date.now() - last < REAUTH_COOLDOWN_MS) {
    return Promise.reject(new Error('Session expired. Please reload the page to sign in again.'));
  }
  sessionStorage.setItem(REAUTH_KEY, String(Date.now()));
  clearSessionCache();
  void beginLogin();
  return new Promise<T>(() => {});
}

function getUserId(): string | null {
  // sessionStorage for current tab; localStorage as cross-tab fallback
  return sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY);
}

export function setCurrentUserId(id: string) {
  sessionStorage.setItem(STORAGE_KEY, id);
  localStorage.setItem(STORAGE_KEY, id);
}
export function getCurrentUserId() { return getUserId(); }

async function request<T>(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  const uid = getUserId();
  if (uid) headers['X-User-Id'] = uid;
  const res = await fetch(`${BASE}${path}`, withCreds({ ...options, headers, ...(signal ? { signal } : {}) }));
  if (res.status === 401 && isAuthEnabled()) return reauthenticate<T>();
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function upload<T>(path: string, formData: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  const uid = getUserId();
  if (uid) headers['X-User-Id'] = uid;
  const res = await fetch(`${BASE}${path}`, withCreds({ method: 'POST', body: formData, headers }));
  if (res.status === 401 && isAuthEnabled()) return reauthenticate<T>();
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  // RFC 5987 form wins — it is the one that survives non-ASCII names.
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

// Download a file from an authenticated endpoint.
//
// A plain <a href="/api/..."> or window.open() is a browser navigation: it
// cannot carry the Authorization / X-Id-Token / X-User-Id headers the Core now
// requires. While DISABLE_LOGIN was on that did not matter, so every download in
// the app was wired that way. The moment login was enabled the Core answered
// those navigations with 401 + application/json, and the browser dutifully saved
// the error body — which is why "Export to Excel" produced a file named
// "excel.json" (name taken from the URL's last segment plus the JSON type).
//
// Fetch the bytes with the same headers as any other API call, then hand the
// browser a blob URL. Errors reject so the caller can surface them, instead of
// silently saving a corrupt file.
export async function download(path: string, fallbackName = 'download'): Promise<void> {
  const headers: Record<string, string> = {};
  const uid = getUserId();
  if (uid) headers['X-User-Id'] = uid;

  const res = await fetch(`${BASE}${path}`, withCreds({ headers }));
  if (res.status === 401 && isAuthEnabled()) return reauthenticate<void>();
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFromDisposition(res.headers.get('Content-Disposition')) || fallbackName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick — revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Props for an element that behaves like a download link but is NOT an <a href>.
// Keeping a real href alongside an onClick handler looks harmless, but a
// middle-click or "Save link as" bypasses the handler and performs the raw
// navigation — which is exactly the unauthenticated request that saves the
// Core's 401 JSON. There is no way to attach headers to those, so the href is
// removed entirely and keyboard activation is provided explicitly.
export function downloadLinkProps(path: string, name: string, onError: (msg: string) => void) {
  const go = () => {
    download(path, name).catch(e => onError(e instanceof Error ? e.message : 'Download failed'));
  };
  return {
    role: 'link',
    tabIndex: 0,
    onClick: (e: { preventDefault: () => void; stopPropagation: () => void }) => {
      e.preventDefault();
      e.stopPropagation();
      go();
    },
    onKeyDown: (e: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      go();
    },
  };
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown, signal?: AbortSignal) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }, signal),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, formData: FormData) => upload<T>(path, formData),
  download,
};
