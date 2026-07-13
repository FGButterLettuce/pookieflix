import { useState } from 'react';
import { Logo } from '../components/Logo';
import { useTheme } from '../theme/ThemeContext';

type Mode = 'local' | 'tunnel' | 'ddns' | null;

export function Setup({ onComplete }: { onComplete: () => void }) {
  const { theme } = useTheme();
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<Mode>(null);
  const [tunnelSubStep, setTunnelSubStep] = useState(0);
  const [baseUrl, setBaseUrl] = useState('');
  const [tunnelToken, setTunnelToken] = useState('');
  const [showAdvancedPort, setShowAdvancedPort] = useState(false);
  const [containerPort, setContainerPort] = useState(() => window.location.port || '3000');
  const [uploadUrl, setUploadUrl] = useState('');
  const [subsKey, setSubsKey] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const localUrl = `${window.location.protocol}//${window.location.host}`;

  const chooseLocal = () => {
    setMode('local');
    setBaseUrl(localUrl);
    setUploadUrl(localUrl);
    setStep(3);
  };

  const chooseTunnel = () => {
    setMode('tunnel');
    setBaseUrl('https://');
    setUploadUrl(localUrl);
    setTunnelSubStep(0);
    setStep(2);
  };

  const chooseDDNS = () => {
    setMode('ddns');
    setBaseUrl('http://');
    setUploadUrl(localUrl);
    setStep(2);
  };

  const finish = async () => {
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }
    setSaving(true);
    setError('');
    try {
      // Set the password first - it issues the session cookie the
      // following /api/setup call needs once a password exists.
      const pwRes = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: password }),
      });
      if (!pwRes.ok) {
        const d = await pwRes.json() as { error?: string };
        throw new Error(d.error ?? 'Failed to set password');
      }

      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          APP_BASE_URL: baseUrl.trim(),
          UPLOAD_URL: uploadUrl.trim() || undefined,
          OPENSUBTITLES_API_KEY: subsKey.trim() || undefined,
          TUNNEL_TOKEN: tunnelToken.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        throw new Error(d.error ?? 'Failed to save');
      }
      setStep(4);
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save settings');
      setSaving(false);
    }
  };

  const dotStep = step === 0 ? 0 : step === 1 ? 1 : step <= 3 ? 2 : 3;

  return (
    <div className="setup-root">
      <div className="setup-card">
        <div className="setup-dots">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`setup-dot ${i === dotStep ? 'active' : i < dotStep ? 'done' : ''}`} />
          ))}
        </div>

        {/* Step 0 — Welcome */}
        {step === 0 && (
          <div className="setup-step">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
              <Logo size="lg" variant={theme === 'dark' ? 'dark' : 'light'} />
            </div>
            <p className="setup-desc">
              Watch movies in perfect sync with someone. Your files, your server, completely
              private, and free to use however you want.
            </p>
            <p className="setup-desc" style={{ opacity: 0.55, fontSize: '0.88em', marginTop: 0 }}>
              Takes about 2–5 minutes to set up.
            </p>
            <button className="primary-btn setup-btn" onClick={() => setStep(1)}>Let's go →</button>
          </div>
        )}

        {/* Step 1 — Where */}
        {step === 1 && (
          <div className="setup-step">
            <div className="setup-icon">📍</div>
            <h1 className="setup-title">Where will you watch from?</h1>
            <p className="setup-desc">Pick the option that fits your situation.</p>
            <div className="setup-choice-group">
              <button className="setup-choice" onClick={chooseLocal}>
                <span className="setup-choice-title">🏠 Only at home</span>
                <span className="setup-choice-desc">
                  You and the other person share the same Wi-Fi. Quickest setup, works right away, no accounts needed.
                </span>
              </button>
              <button className="setup-choice" onClick={chooseTunnel}>
                <span className="setup-choice-title">☁️ From anywhere: Cloudflare Tunnel</span>
                <span className="setup-choice-desc">
                  Best option for remote watching. Free, secure, no port forwarding needed.
                  Requires a Cloudflare account and a domain name you own.
                </span>
              </button>
              <button className="setup-choice" onClick={chooseDDNS}>
                <span className="setup-choice-title">🔗 From anywhere: DDNS</span>
                <span className="setup-choice-desc">
                  Good if you don't have a domain. Uses a free hostname (e.g. myname.duckdns.org).
                  Requires opening a port on your router.
                </span>
              </button>
            </div>
            <button className="setup-back" onClick={() => setStep(0)}>← Back</button>
          </div>
        )}

        {/* Step 2 — Cloudflare Tunnel (3 sub-steps) */}
        {step === 2 && mode === 'tunnel' && (
          <div className="setup-step">

            {tunnelSubStep === 0 && (<>
              <div className="setup-icon">☁️</div>
              <h1 className="setup-title">Create a Cloudflare Tunnel</h1>
              <p className="setup-desc">
                A Cloudflare Tunnel gives your server a public web address, with no static IP or port forwarding needed. It's free.
              </p>
              <ol className="setup-instructions">
                <li>Go to <strong>dash.cloudflare.com</strong> and sign in (or create a free account)</li>
                <li>In the left sidebar, click <strong>Networking → Tunnels</strong></li>
                <li>Click <strong>Create a tunnel</strong>, choose <strong>Cloudflared</strong>, and give it any name (e.g. "home")</li>
                <li>Click <strong>Save tunnel</strong>. Don't close this page, you'll need it next</li>
              </ol>
              <div className="setup-nav">
                <button className="setup-back" onClick={() => setStep(1)}>← Back</button>
                <button className="primary-btn setup-btn" onClick={() => setTunnelSubStep(1)}>Done, next →</button>
              </div>
            </>)}

            {tunnelSubStep === 1 && (<>
              <div className="setup-icon">🔑</div>
              <h1 className="setup-title">Connect the tunnel</h1>
              <p className="setup-desc">
                PookieFlix runs and manages the connector itself — no separate install or terminal
                command needed. Cloudflare's page shows you a command to run on your own computer,
                but you can skip that entirely.
              </p>

              <p className="setup-instructions-label">
                1. On the "Install cloudflared connector" page, under <strong>Select Operating System</strong>, click <strong>Docker</strong> (not Windows/macOS/Debian/Red Hat):
              </p>
              <div className="cf-mockup">
                <div className="cf-mockup-caption">Select Operating System</div>
                <div className="cf-mockup-tabs">
                  <span className="cf-mockup-tab">Windows</span>
                  <span className="cf-mockup-tab">macOS</span>
                  <span className="cf-mockup-tab">Debian</span>
                  <span className="cf-mockup-tab">Red Hat</span>
                  <div className="cf-mockup-pick-wrap">
                    <span className="cf-mockup-tab cf-mockup-tab--pick">Docker</span>
                    <div className="cf-mockup-pointer">👆 click this one</div>
                  </div>
                </div>
              </div>

              <p className="setup-instructions-label" style={{ marginTop: 16 }}>
                2. It'll show one command starting with <code>docker run cloudflare/cloudflared…</code>. Copy that entire line —
              </p>
              <p className="setup-instructions-label">
                3. …and paste it here (the whole thing, don't bother editing it down — PookieFlix will find the token in it automatically):
              </p>
              <input
                className="setup-input"
                type="text"
                placeholder="Paste the whole Docker command (or just the token)"
                value={tunnelToken}
                onChange={e => setTunnelToken(e.target.value)}
                autoFocus
              />

              <div className="setup-nav">
                <button className="setup-back" onClick={() => setTunnelSubStep(0)}>← Back</button>
                <button
                  className="primary-btn setup-btn"
                  onClick={() => setTunnelSubStep(2)}
                  disabled={!tunnelToken.trim()}
                >
                  Next →
                </button>
              </div>
            </>)}

            {tunnelSubStep === 2 && (<>
              <div className="setup-icon">🌐</div>
              <h1 className="setup-title">Add a public hostname</h1>
              <p className="setup-desc">
                Now tell Cloudflare what web address to use for PookieFlix. This only works for a
                domain whose nameservers are already set up in this Cloudflare account — if your
                domain lives elsewhere (Namecheap, GoDaddy, etc. without being added to Cloudflare),
                add it to Cloudflare first.
              </p>
              <ol className="setup-instructions">
                <li>Back in the Cloudflare dashboard, go to your tunnel's <strong>Routes</strong> tab</li>
                <li>Click <strong>Add route</strong>, then choose <strong>Published application</strong> (not "Private Network" — that requires the Cloudflare WARP client and won't let you just share a link)</li>
                <li>Choose a subdomain (e.g. <em>watch</em>) and select a domain you have in Cloudflare</li>
                <li>Set <strong>Service URL</strong> to <code>http://localhost:{containerPort || '3000'}</code> — plain <code>http://</code>, not <code>https://</code>: Cloudflare's edge handles the public HTTPS side, PookieFlix itself only speaks HTTP internally</li>
                <li>Save the route</li>
                <li>Your public URL will look like <em>https://watch.yourdomain.com</em>. Paste it below</li>
              </ol>

              <button
                type="button"
                className="setup-advanced-toggle"
                onClick={() => setShowAdvancedPort(v => !v)}
              >
                {showAdvancedPort ? '▾' : '▸'} Advanced: PookieFlix isn't on port 3000
              </button>
              {showAdvancedPort && (
                <div className="setup-advanced-panel">
                  <p className="setup-hint" style={{ marginBottom: 8 }}>
                    If port 3000 on your machine was already taken by something else, you likely just
                    remapped the <em>outside</em> port when starting the container (e.g. <code>-p 8080:3000</code>) —
                    that doesn't change anything here, since the Service URL above refers to PookieFlix's
                    own port <em>inside</em> its container, which stays 3000 by default either way.{' '}
                    Only change this if you also set a custom <code>PORT</code> environment variable for
                    PookieFlix itself.
                  </p>
                  <label className="settings-label">Container port</label>
                  <input
                    className="setup-input"
                    type="text"
                    inputMode="numeric"
                    placeholder="3000"
                    value={containerPort}
                    onChange={e => setContainerPort(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                </div>
              )}
              <input
                className="setup-input"
                type="url"
                placeholder="https://watch.yourdomain.com"
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                autoFocus
              />
              <div className="setup-hint">Must start with https://</div>
              <div className="setup-nav">
                <button className="setup-back" onClick={() => setTunnelSubStep(1)}>← Back</button>
                <button
                  className="primary-btn setup-btn"
                  onClick={() => setStep(3)}
                  disabled={!baseUrl.trim().startsWith('https://')}
                >
                  Next →
                </button>
              </div>
            </>)}
          </div>
        )}

        {/* Step 2 — DDNS */}
        {step === 2 && mode === 'ddns' && (
          <div className="setup-step">
            <div className="setup-icon">🔗</div>
            <h1 className="setup-title">Set up DDNS + port forwarding</h1>
            <p className="setup-desc">
              This gives your server a hostname that always follows your home IP address, even when it changes.
            </p>
            <ol className="setup-instructions">
              <li>Go to <strong>duckdns.org</strong> and sign in with Google or GitHub (it's free)</li>
              <li>Pick a subdomain name. You'll get <em>yourname.duckdns.org</em></li>
              <li>Install the DuckDNS updater on this computer so it keeps your IP current (instructions on their site for Linux/Mac/Windows)</li>
              <li>Log into your <strong>router</strong> (usually at 192.168.0.1 or 192.168.1.1) and find <strong>Port Forwarding</strong></li>
              <li>Forward external port <strong>3000</strong> to <code>{window.location.hostname}</code> port <strong>3000</strong></li>
              <li>Your public URL will be <em>http://yourname.duckdns.org:3000</em>. Paste it below</li>
            </ol>
            <input
              className="setup-input"
              type="url"
              placeholder="http://yourname.duckdns.org:3000"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              autoFocus
            />
            <div className="setup-hint">Include the port number unless you set up HTTPS separately</div>
            <div className="setup-nav">
              <button className="setup-back" onClick={() => setStep(1)}>← Back</button>
              <button
                className="primary-btn setup-btn"
                onClick={() => setStep(3)}
                disabled={!baseUrl.trim().startsWith('http')}
              >
                Next →
              </button>
            </div>
          </div>
        )}

        {/* Step 3 — Password + Subtitles */}
        {step === 3 && (
          <div className="setup-step">
            <div className="setup-icon">🔒</div>
            <h1 className="setup-title">Set your password</h1>
            <p className="setup-desc">
              {mode === 'local'
                ? 'Required before you finish, even for a home-only setup — anyone on your Wi-Fi could otherwise open the app with no login at all.'
                : 'Required before you finish — without one, PookieFlix would be wide open to anyone who finds the URL, tunnel or not.'}
            </p>
            <input
              className="setup-input"
              type="password"
              placeholder="At least 6 characters"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
            />
            <input
              className="setup-input"
              type="password"
              placeholder="Confirm password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void finish()}
            />
            <div className="setup-hint">You can change this later in Settings</div>

            <hr style={{ margin: '4px 0 20px', borderColor: 'var(--border)' }} />

            <h2 className="settings-label" style={{ fontSize: 15, marginBottom: 8 }}>
              Auto subtitles <span className="settings-optional">(optional)</span>
            </h2>
            <p className="setup-desc" style={{ textAlign: 'left', marginBottom: 12 }}>
              PookieFlix can automatically fetch subtitles when you upload a video, or you can
              skip this for now and add it later in Settings.
            </p>
            <ol className="setup-instructions">
              <li>Go to <strong>opensubtitles.com</strong> and create a free account</li>
              <li>Go to your profile → <strong>API Access</strong> and copy your key</li>
              <li>Paste it below</li>
            </ol>
            <input
              className="setup-input"
              type="text"
              placeholder="Paste API key here, or leave blank to skip"
              value={subsKey}
              onChange={e => setSubsKey(e.target.value)}
            />
            {error && <div className="home-error">{error}</div>}
            <div className="setup-nav">
              <button className="setup-back" onClick={() => {
                if (mode === 'local') setStep(1);
                else if (mode === 'tunnel') { setStep(2); setTunnelSubStep(2); }
                else setStep(2);
              }}>← Back</button>
              <button
                className="primary-btn setup-btn"
                onClick={() => { void finish(); }}
                disabled={saving || password.length < 6 || password !== confirmPassword}
              >
                {saving ? 'Saving…' : 'Finish →'}
              </button>
            </div>
          </div>
        )}

        {/* Step 4 — Done */}
        {step === 4 && (
          <div className="setup-step">
            <div className="setup-icon">✓</div>
            <h1 className="setup-title">You're all set!</h1>
            <p className="setup-desc">
              {mode === 'local'
                ? `PookieFlix is ready. Share ${localUrl} with whoever you're watching with. They need to be on the same Wi-Fi.`
                : mode === 'tunnel'
                ? `PookieFlix is live at ${baseUrl}. Upload a video, share the room link, and enjoy.`
                : `PookieFlix is ready at ${baseUrl}. Upload a video and share the room link.`}
            </p>
            {mode === 'tunnel' && tunnelToken && (
              <p className="setup-desc" style={{ fontSize: '0.85em', opacity: 0.6, marginTop: 0 }}>
                The tunnel connector is already running — no further setup needed. It'll reconnect
                automatically on restart, and you can update the token anytime in Settings.
              </p>
            )}
            <button className="primary-btn setup-btn" onClick={onComplete}>
              Go to library →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
