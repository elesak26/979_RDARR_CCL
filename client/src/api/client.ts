const BASE = '/api';

// Store current user id for dev mode header
let currentUserId: string | null = null;
export function setCurrentUserId(id: string) { currentUserId = id; }
export function getCurrentUserId() { return currentUserId; }

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (currentUserId) headers['X-User-Id'] = currentUserId;
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function upload<T>(path: string, formData: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  if (currentUserId) headers['X-User-Id'] = currentUserId;
  const res = await fetch(`${BASE}${path}`, { method: 'POST', body: formData, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, formData: FormData) => upload<T>(path, formData),
};
