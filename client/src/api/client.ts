import { getAccessToken, getIdToken, isAuthEnabled, beginLogin } from '../auth/oidc';

const BASE = '/api';
const STORAGE_KEY = 'ccl-dev-user';

// When auth is on but the access token is missing/expired, kick off a fresh
// login redirect instead of firing a request the proxy will reject (401/403).
// Returns the Bearer header value, or null when auth is disabled.
function ensureBearer(): string | null {
  if (!isAuthEnabled()) return null;
  const token = getAccessToken();
  if (!token) {
    void beginLogin();
    throw new Error('Session expired — signing in again…');
  }
  return token;
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
  const bearer = ensureBearer();
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  // The Core JWKS-verifies the id_token (the access_token is opaque on the NBG IdP).
  const idToken = getIdToken();
  if (idToken) headers['X-Id-Token'] = idToken;
  const uid = getUserId();
  if (uid) headers['X-User-Id'] = uid;
  const res = await fetch(`${BASE}${path}`, { ...options, headers, ...(signal ? { signal } : {}) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function upload<T>(path: string, formData: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  const bearer = ensureBearer();
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  // The Core JWKS-verifies the id_token (the access_token is opaque on the NBG IdP).
  const idToken = getIdToken();
  if (idToken) headers['X-Id-Token'] = idToken;
  const uid = getUserId();
  if (uid) headers['X-User-Id'] = uid;
  const res = await fetch(`${BASE}${path}`, { method: 'POST', body: formData, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown, signal?: AbortSignal) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }, signal),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, formData: FormData) => upload<T>(path, formData),
};
