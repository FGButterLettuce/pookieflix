import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ArrowLeft, Info } from 'lucide-react';
import { Logo } from '../components/Logo';
import { useTheme } from '../theme/ThemeContext';
import { PasswordInput } from '../components/PasswordInput';
import { PasteableInput } from '../components/PasteableInput';


interface TunnelStatus {
  state: 'stopped' | 'starting' | 'connected' | 'error';
  message?: string;
  connectedAt?: number;
}

interface SettingsData {
  APP_BASE_URL: string;
  UPLOAD_URL: string;
  OPENSUBTITLES_API_KEY: string;
  USER_NAME: string;
  PARTNER_NAME: string;
  TUNNEL_CONFIGURED: boolean;
  TUNNEL_STATUS: TunnelStatus;
}

const TUNNEL_STATUS_LABEL: Record<TunnelStatus['state'], string> = {
  stopped: 'Not connected',
  starting: 'Connecting…',
  connected: 'Connected',
  error: 'Connection error',
};

export function Settings() {
  const { theme } = useTheme();
  const [values, setValues] = useState<SettingsData>({
    APP_BASE_URL: '',
    UPLOAD_URL: '',
    OPENSUBTITLES_API_KEY: '',
    USER_NAME: '',
    PARTNER_NAME: '',
    TUNNEL_CONFIGURED: false,
    TUNNEL_STATUS: { state: 'stopped' },
  });
  const [tunnelToken, setTunnelToken] = useState('');
  const [removingTunnel, setRemovingTunnel] = useState(false);
  const [reconnectingTunnel, setReconnectingTunnel] = useState(false);
  const [reconnected, setReconnected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwSaved, setPwSaved] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((d: SettingsData) => setValues(d))
      .catch(() => {});
  }, []);

  // Poll tunnel status live while a tunnel is configured, so "Connecting…"
  // resolves to "Connected"/"Connection error" without a manual refresh.
  useEffect(() => {
    if (!values.TUNNEL_CONFIGURED) return;
    const interval = setInterval(() => {
      fetch('/api/settings')
        .then(r => r.json())
        .then((d: SettingsData) => setValues(v => ({ ...v, TUNNEL_CONFIGURED: d.TUNNEL_CONFIGURED, TUNNEL_STATUS: d.TUNNEL_STATUS })))
        .catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [values.TUNNEL_CONFIGURED]);

  const set = (key: keyof SettingsData) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues(v => ({ ...v, [key]: e.target.value }));

  const save = async () => {
    if (!values.APP_BASE_URL.trim().startsWith('http')) {
      setError('Domain must start with http:// or https://');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, TUNNEL_TOKEN: tunnelToken.trim() || undefined }),
      });
      if (!res.ok) throw new Error('Failed to save');
      if (tunnelToken.trim()) {
        setValues(v => ({ ...v, TUNNEL_CONFIGURED: true, TUNNEL_STATUS: { state: 'starting' } }));
        setTunnelToken('');
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const removeTunnel = async () => {
    setRemovingTunnel(true);
    try {
      const res = await fetch('/api/settings/tunnel', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed');
      setValues(v => ({ ...v, TUNNEL_CONFIGURED: false, TUNNEL_STATUS: { state: 'stopped' } }));
    } catch {
      setError('Failed to remove tunnel');
    } finally {
      setRemovingTunnel(false);
    }
  };

  // Drops and re-establishes the tunnel with the same token — recovers a
  // stuck/failing connection (e.g. one of cloudflared's edge connections
  // caught in a retry loop) without needing to re-paste the token.
  const reconnectTunnel = async () => {
    setReconnectingTunnel(true);
    setError('');
    try {
      const res = await fetch('/api/settings/tunnel/reconnect', { method: 'POST' });
      if (!res.ok) throw new Error('Failed');
      setValues(v => ({ ...v, TUNNEL_STATUS: { state: 'starting' } }));
      setReconnected(true);
      setTimeout(() => setReconnected(false), 2500);
    } catch {
      setError('Failed to reconnect tunnel');
    } finally {
      setReconnectingTunnel(false);
    }
  };

  const changePassword = async () => {
    setPwError('');
    if (newPassword.length < 6) { setPwError('Must be at least 6 characters'); return; }
    if (newPassword !== confirmPassword) { setPwError('Passwords don\'t match'); return; }
    setPwSaving(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword }),
      });
      if (!res.ok) throw new Error('Failed');
      setNewPassword('');
      setConfirmPassword('');
      setPwSaved(true);
      setTimeout(() => setPwSaved(false), 2500);
    } catch { setPwError('Failed to change password'); }
    setPwSaving(false);
  };

  return (
    <div className="home-root">
      <header className="home-topbar">
        <span className="home-logo"><Logo size="sm" variant={theme} /></span>
        <Link to="/" className="settings-link" title="Back to library"><ArrowLeft /></Link>
      </header>

      <div className="settings-page">
        <h1 className="settings-page-title">Settings</h1>

        <section className="settings-section">
          <h2 className="settings-section-title">Account</h2>

          <div className="settings-field">
            <label className="settings-label">Your name</label>
            <PasteableInput
              className="setup-input"
              placeholder="e.g. Niranjan"
              value={values.USER_NAME}
              onChange={set('USER_NAME')}
            />
            <div className="setup-hint" style={{ marginBottom: 0 }}>Used for personalized domain suggestions if you set up a Cloudflare Tunnel</div>
          </div>

          <div className="settings-field">
            <label className="settings-label">Partner's name</label>
            <PasteableInput
              className="setup-input"
              placeholder="e.g. Anu"
              value={values.PARTNER_NAME}
              onChange={set('PARTNER_NAME')}
            />
            <div className="setup-hint" style={{ marginBottom: 0 }}>Same, also used for domain suggestions</div>
          </div>

          <div className="settings-divider" />

          <div className="settings-subsection-label">Change password</div>
          <div className="settings-field">
            <label className="settings-label">New password</label>
            <PasswordInput
              className="setup-input"
              placeholder="At least 6 characters"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Confirm password</label>
            <PasswordInput
              className="setup-input"
              placeholder="Repeat new password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void changePassword()}
            />
          </div>
          {pwError && <div className="home-error" style={{ marginBottom: 12 }}>{pwError}</div>}
          <button className="primary-btn" style={{ width: '100%', marginTop: 0 }} onClick={() => void changePassword()} disabled={pwSaving}>
            {pwSaving ? 'Saving…' : pwSaved ? '✓ Password changed' : 'Change password'}
          </button>
        </section>

        <section className="settings-section">
          <h2 className="settings-section-title">Access</h2>

          <div className="settings-field">
            <label className="settings-label">Public domain</label>
            <PasteableInput
              className="setup-input"
              type="url"
              placeholder="https://watch.yourdomain.com"
              value={values.APP_BASE_URL}
              onChange={set('APP_BASE_URL')}
            />
            <div className="setup-hint" style={{ marginBottom: 0 }}>Used to generate room invite links</div>
          </div>

          <div className="settings-field">
            <label className="settings-label">Local network URL <span className="settings-optional">(optional)</span></label>
            <PasteableInput
              className="setup-input"
              type="url"
              placeholder="http://192.168.0.91:3000"
              value={values.UPLOAD_URL}
              onChange={set('UPLOAD_URL')}
            />
            <div className="setup-hint" style={{ marginBottom: 0 }}>Direct upload path bypassing Cloudflare</div>
          </div>

          <div className="settings-field">
            <label className="settings-label">Cloudflare Tunnel</label>
            <div className="tunnel-card">
              <div className="tunnel-card-header">
                <span
                  className={`tunnel-status-dot tunnel-status-dot--${values.TUNNEL_CONFIGURED ? values.TUNNEL_STATUS.state : 'stopped'}`}
                />
                <span className="tunnel-status-label">
                  {values.TUNNEL_CONFIGURED ? TUNNEL_STATUS_LABEL[values.TUNNEL_STATUS.state] : 'Not configured'}
                </span>
                {values.TUNNEL_STATUS.state === 'error' && values.TUNNEL_STATUS.message && (
                  <Tooltip.Provider delayDuration={800}>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <button type="button" className="tunnel-status-detail-btn" aria-label="Connection error details">
                          <Info size={14} />
                        </button>
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content className="tooltip-content" sideOffset={6}>
                          {values.TUNNEL_STATUS.message}
                          <Tooltip.Arrow className="tooltip-arrow" />
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                )}
              </div>

              <a
                className="external-cta-btn"
                href="https://dash.cloudflare.com/"
                target="_blank"
                rel="noopener noreferrer"
              >
                open dash.cloudflare.com ↗
              </a>
              <PasteableInput
                className="setup-input"
                placeholder={values.TUNNEL_CONFIGURED ? 'Paste a new token to replace this tunnel' : 'Paste a token to enable a tunnel'}
                value={tunnelToken}
                onChange={e => setTunnelToken(e.target.value)}
              />
              <div className="setup-hint" style={{ marginBottom: 12 }}>
                From your tunnel's "Install connector" step — paste the whole command shown there,
                we'll find the token in it. PookieFlix runs and manages the tunnel itself, no separate
                container or install needed.
              </div>
              {values.TUNNEL_CONFIGURED && (
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    className="setup-back"
                    onClick={() => void reconnectTunnel()}
                    disabled={reconnectingTunnel}
                    title="Drop and re-establish the tunnel connection — useful if it's been stuck or lagging"
                  >
                    {reconnectingTunnel ? 'Reconnecting…' : reconnected ? '✓ Reconnected' : 'Reconnect tunnel'}
                  </button>
                  <button
                    className="setup-back"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => void removeTunnel()}
                    disabled={removingTunnel}
                  >
                    {removingTunnel ? 'Removing…' : 'Remove tunnel'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h2 className="settings-section-title">Advanced</h2>
          <div className="settings-field">
            <label className="settings-label">OpenSubtitles API key <span className="settings-optional">(optional)</span></label>
            <PasteableInput
              className="setup-input"
              placeholder="Your API key"
              value={values.OPENSUBTITLES_API_KEY}
              onChange={set('OPENSUBTITLES_API_KEY')}
            />
            <div className="setup-hint" style={{ marginBottom: 0 }}>Auto-fetch subtitles on upload</div>
          </div>
        </section>

        {error && <div className="home-error" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="primary-btn" style={{ width: '100%' }} onClick={save} disabled={saving}>
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save settings'}
        </button>
      </div>
    </div>
  );
}
