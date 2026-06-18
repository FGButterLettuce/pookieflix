import { useState } from 'react';

const STEPS = ['Welcome', 'Your Domain', 'Local Upload', 'Subtitles', 'Done'];

export function Setup({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const [baseUrl, setBaseUrl] = useState('');
  const [uploadUrl, setUploadUrl] = useState('');
  const [subsKey, setSubsKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const next = () => setStep(s => s + 1);
  const back = () => setStep(s => s - 1);

  const finish = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          APP_BASE_URL: baseUrl.trim(),
          UPLOAD_URL: uploadUrl.trim(),
          OPENSUBTITLES_API_KEY: subsKey.trim(),
        }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        throw new Error(d.error ?? 'Failed to save');
      }
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save settings');
      setSaving(false);
    }
  };

  return (
    <div className="setup-root">
      <div className="setup-card">
        {/* Progress dots */}
        <div className="setup-dots">
          {STEPS.map((_, i) => (
            <div key={i} className={`setup-dot ${i === step ? 'active' : i < step ? 'done' : ''}`} />
          ))}
        </div>

        {step === 0 && (
          <div className="setup-step">
            <div className="setup-icon">🎬</div>
            <h1 className="setup-title">Welcome to WatchTogether</h1>
            <p className="setup-desc">
              Self-hosted watch parties — your files, your server, no third-party.
              Let's get you set up in a minute.
            </p>
            <button className="primary-btn setup-btn" onClick={next}>Get started →</button>
          </div>
        )}

        {step === 1 && (
          <div className="setup-step">
            <div className="setup-icon">🌐</div>
            <h1 className="setup-title">What's your domain?</h1>
            <p className="setup-desc">
              The public URL where WatchTogether is accessible. This is used to generate room invite links.
            </p>
            <input
              className="setup-input"
              type="url"
              placeholder="https://watch.yourdomain.com"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              autoFocus
            />
            <div className="setup-hint">Include https:// — e.g. https://watch.example.com</div>
            <div className="setup-nav">
              <button className="setup-back" onClick={back}>← Back</button>
              <button
                className="primary-btn setup-btn"
                onClick={next}
                disabled={!baseUrl.trim().startsWith('http')}
              >
                Next →
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="setup-step">
            <div className="setup-icon">⚡</div>
            <h1 className="setup-title">Local network upload</h1>
            <p className="setup-desc">
              If your server is behind Cloudflare or a reverse proxy, large file uploads may be blocked.
              Set your local network address to upload directly — bypassing any limits.
            </p>
            <input
              className="setup-input"
              type="url"
              placeholder="http://192.168.0.91:3000 (optional)"
              value={uploadUrl}
              onChange={e => setUploadUrl(e.target.value)}
            />
            <div className="setup-hint">Leave blank if you're not behind a proxy, or don't upload large files.</div>
            <div className="setup-nav">
              <button className="setup-back" onClick={back}>← Back</button>
              <button className="primary-btn setup-btn" onClick={next}>Next →</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="setup-step">
            <div className="setup-icon">CC</div>
            <h1 className="setup-title">Subtitles</h1>
            <p className="setup-desc">
              WatchTogether can auto-fetch subtitles from OpenSubtitles when you upload a video.
              Paste your API key below to enable this.
            </p>
            <input
              className="setup-input"
              type="text"
              placeholder="OpenSubtitles API key (optional)"
              value={subsKey}
              onChange={e => setSubsKey(e.target.value)}
            />
            <div className="setup-hint">
              Get a free key at <span style={{ color: 'var(--accent)' }}>opensubtitles.com/en/consumers</span>
            </div>
            {error && <div className="home-error">{error}</div>}
            <div className="setup-nav">
              <button className="setup-back" onClick={back}>← Back</button>
              <button className="primary-btn setup-btn" onClick={() => { void finish(); next(); }} disabled={saving}>
                {saving ? 'Saving…' : 'Finish →'}
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="setup-step">
            <div className="setup-icon">✓</div>
            <h1 className="setup-title">You're all set!</h1>
            <p className="setup-desc">
              WatchTogether is ready. Upload a video to your library and share the link.
            </p>
            <button className="primary-btn setup-btn" onClick={onComplete}>
              Go to library →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
