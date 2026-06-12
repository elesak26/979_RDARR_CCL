import { useEffect, useState, type ReactNode } from 'react';
import { getAuthConfig, getAccessToken, beginLogin, completeLoginIfCallback } from './oidc';

/**
 * Wraps the app. Before rendering, ensures the user is authenticated via NBG
 * Identity when auth is enabled. When auth is disabled (local dev / before the
 * identity secrets are configured on the Core), it passes straight through so
 * the existing dev dropdown behaviour is unchanged.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'authed' | 'error'>('checking');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await getAuthConfig();
        if (cancelled) return;
        if (!cfg.enabled) {
          setStatus('authed'); // auth off → behave exactly as before
          return;
        }
        // Returning from NBG Identity with ?code= ?
        const handled = await completeLoginIfCallback();
        if (cancelled) return;
        if (handled || getAccessToken()) {
          setStatus('authed');
          return;
        }
        // No token yet → start the login redirect (no return after this).
        await beginLogin();
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Login error');
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'authed') return <>{children}</>;

  if (status === 'error') {
    return (
      <div className="layout" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: 420, padding: 24 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Sign-in failed</div>
          <div className="small" style={{ marginBottom: 16 }}>{error}</div>
          <button
            className="btn primary"
            onClick={() => {
              sessionStorage.clear();
              window.location.assign('/');
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="layout" style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ textAlign: 'center', color: 'var(--muted)' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🔐</div>
        <div>Signing in…</div>
      </div>
    </div>
  );
}
