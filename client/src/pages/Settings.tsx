import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';


interface SettingsData {
  APP_BASE_URL: string;
  UPLOAD_URL: string;
  OPENSUBTITLES_API_KEY: string;
}

export function Settings() {
  const navigate = useNavigate();
  const [values, setValues] = useState<SettingsData>({
    APP_BASE_URL: '',
    UPLOAD_URL: '',
    OPENSUBTITLES_API_KEY: '',
  });
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
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error('Failed to save');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setError('Failed to save settings');
    } finally {
      setSaving(false);
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
    <div className="setup-root">
      <div className="setup-card" style={{ maxWidth: 480 }}>
        <button className="setup-back" style={{ marginBottom: 16 }} onClick={() => navigate('/')}>
          ← Back to library
        </button>
        <h1 className="setup-title" style={{ marginBottom: 24 }}>Settings</h1>

        <label className="settings-label">Public domain</label>
        <input
          className="setup-input"
          type="url"
          placeholder="https://watch.yourdomain.com"
          value={values.APP_BASE_URL}
          onChange={set('APP_BASE_URL')}
        />
        <div className="setup-hint" style={{ marginBottom: 20 }}>Used to generate room invite links</div>

        <label className="settings-label">Local network URL <span className="settings-optional">(optional)</span></label>
        <input
          className="setup-input"
          type="url"
          placeholder="http://192.168.0.91:3000"
          value={values.UPLOAD_URL}
          onChange={set('UPLOAD_URL')}
        />
        <div className="setup-hint" style={{ marginBottom: 20 }}>Direct upload path bypassing Cloudflare</div>

        <label className="settings-label">OpenSubtitles API key <span className="settings-optional">(optional)</span></label>
        <input
          className="setup-input"
          type="text"
          placeholder="Your API key"
          value={values.OPENSUBTITLES_API_KEY}
          onChange={set('OPENSUBTITLES_API_KEY')}
        />
        <div className="setup-hint" style={{ marginBottom: 24 }}>Auto-fetch subtitles on upload</div>

        {error && <div className="home-error" style={{ marginBottom: 12 }}>{error}</div>}

        <button className="primary-btn" style={{ width: '100%' }} onClick={save} disabled={saving}>
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save settings'}
        </button>

        <hr style={{ margin: '28px 0', borderColor: 'var(--border)' }} />
        <h2 className="settings-label" style={{ fontSize: 15, marginBottom: 16 }}>Change password</h2>

        <label className="settings-label">New password</label>
        <input
          className="setup-input"
          type="password"
          placeholder="At least 6 characters"
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
        />

        <label className="settings-label" style={{ marginTop: 12 }}>Confirm password</label>
        <input
          className="setup-input"
          type="password"
          placeholder="Repeat new password"
          value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && void changePassword()}
        />

        {pwError && <div className="home-error" style={{ margin: '8px 0' }}>{pwError}</div>}

        <button className="primary-btn" style={{ width: '100%', marginTop: 12 }} onClick={() => void changePassword()} disabled={pwSaving}>
          {pwSaving ? 'Saving…' : pwSaved ? '✓ Password changed' : 'Change password'}
        </button>
      </div>
    </div>
  );
}
