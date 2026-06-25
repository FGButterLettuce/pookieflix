import { useState } from 'react';
import { Logo } from '../components/Logo';

type Mode = 'local' | 'tunnel' | 'ddns' | null;

function detectOS(): 'windows' | 'mac' | 'linux' {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'windows';
  if (ua.includes('Mac')) return 'mac';
  return 'linux';
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button className="copy-btn" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="setup-code-block">
      <code>{code}</code>
      <CopyButton text={code} />
    </div>
  );
}

export function Setup({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<Mode>(null);
  const [tunnelSubStep, setTunnelSubStep] = useState(0);
  const [os, setOs] = useState(detectOS());
  const [baseUrl, setBaseUrl] = useState('');
  const [tunnelToken, setTunnelToken] = useState('');
  const [uploadUrl, setUploadUrl] = useState('');
  const [subsKey, setSubsKey] = useState('');
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
    setUploadUrl(localUrl);
    setTunnelSubStep(0);
    setStep(2);
  };

  const chooseDDNS = () => {
    setMode('ddns');
    setUploadUrl(localUrl);
    setStep(2);
  };

  const finish = async () => {
    setSaving(true);
    setError('');
    try {
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

  const installCmd = {
    linux: 'curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb && sudo dpkg -i cloudflared.deb',
    mac: 'brew install cloudflare/cloudflare/cloudflared',
    windows: 'winget install --id Cloudflare.cloudflared',
  }[os];

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
              <Logo size="lg" />
            </div>
            <p className="setup-desc">
              Watch movies in perfect sync with someone — your files, your server, completely private.
              No accounts, no subscriptions, no limits.
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
                  You and the other person share the same Wi-Fi. Quickest setup — works right away, no accounts needed.
                </span>
              </button>
              <button className="setup-choice" onClick={chooseTunnel}>
                <span className="setup-choice-title">☁️ From anywhere — Cloudflare Tunnel</span>
                <span className="setup-choice-desc">
                  Best option for remote watching. Free, secure, no port forwarding needed.
                  Requires a Cloudflare account and a domain name you own.
                </span>
              </button>
              <button className="setup-choice" onClick={chooseDDNS}>
                <span className="setup-choice-title">🔗 From anywhere — DDNS</span>
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
                A Cloudflare Tunnel gives your server a public web address — no static IP or port forwarding needed. It's free.
              </p>
              <ol className="setup-instructions">
                <li>Go to <strong>dash.cloudflare.com</strong> and sign in (or create a free account)</li>
                <li>In the left sidebar, click <strong>Networking → Tunnels</strong></li>
                <li>Click <strong>Create a tunnel</strong>, choose <strong>Cloudflared</strong>, and give it any name (e.g. "home")</li>
                <li>Click <strong>Save tunnel</strong> — don't close this page, you'll need it next</li>
              </ol>
              <div className="setup-nav">
                <button className="setup-back" onClick={() => setStep(1)}>← Back</button>
                <button className="primary-btn setup-btn" onClick={() => setTunnelSubStep(1)}>Done, next →</button>
              </div>
            </>)}

            {tunnelSubStep === 1 && (<>
              <div className="setup-icon">⚙️</div>
              <h1 className="setup-title">Install the connector</h1>
              <p className="setup-desc">
                Cloudflare needs a small program running on this computer to route traffic. Install it now.
              </p>

              <div className="setup-os-tabs">
                {(['linux', 'mac', 'windows'] as const).map(o => (
                  <button key={o} className={`setup-os-tab ${os === o ? 'active' : ''}`} onClick={() => setOs(o)}>
                    {o === 'linux' ? '🐧 Linux' : o === 'mac' ? '🍎 Mac' : '🪟 Windows'}
                  </button>
                ))}
              </div>

              <p className="setup-instructions-label">1. Install cloudflared:</p>
              <CodeBlock code={installCmd} />

              <p className="setup-instructions-label" style={{ marginTop: 16 }}>
                2. Back in the Cloudflare dashboard, copy the token shown under <strong>"Install connector"</strong> — it's the long string in the command they show you. Paste it here:
              </p>
              <input
                className="setup-input"
                type="text"
                placeholder="Paste your tunnel token here"
                value={tunnelToken}
                onChange={e => setTunnelToken(e.target.value)}
              />
              <div className="setup-hint">Looks like: eyJhIjoiYWJjZGVm… (very long string)</div>

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
                Now tell Cloudflare what web address to use for WatchTogether.
              </p>
              <ol className="setup-instructions">
                <li>Back in the Cloudflare dashboard, go to the <strong>Public Hostname</strong> tab</li>
                <li>Click <strong>Add a public hostname</strong></li>
                <li>Choose a subdomain (e.g. <em>watch</em>) and select a domain you have in Cloudflare</li>
                <li>Set <strong>Type</strong> to <em>HTTP</em> and <strong>URL</strong> to <code>localhost:3000</code></li>
                <li>Click <strong>Save hostname</strong></li>
                <li>Your public URL will be something like <em>https://watch.yourdomain.com</em> — paste it below</li>
              </ol>
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
              <li>Go to <strong>duckdns.org</strong> and sign in with Google or GitHub — it's free</li>
              <li>Pick a subdomain name — you'll get <em>yourname.duckdns.org</em></li>
              <li>Install the DuckDNS updater on this computer so it keeps your IP current (instructions on their site for Linux/Mac/Windows)</li>
              <li>Log into your <strong>router</strong> (usually at 192.168.0.1 or 192.168.1.1) and find <strong>Port Forwarding</strong></li>
              <li>Forward external port <strong>3000</strong> to <code>{window.location.hostname}</code> port <strong>3000</strong></li>
              <li>Your public URL will be <em>http://yourname.duckdns.org:3000</em> — paste it below</li>
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

        {/* Step 3 — Subtitles */}
        {step === 3 && (
          <div className="setup-step">
            <div className="setup-icon">CC</div>
            <h1 className="setup-title">
              Auto subtitles{' '}
              <span style={{ opacity: 0.4, fontSize: '0.55em', fontWeight: 400 }}>optional</span>
            </h1>
            <p className="setup-desc">
              WatchTogether can automatically fetch subtitles when you upload a video.
              Skip this for now — you can always add it later in Settings.
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
                disabled={saving}
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
                ? `PookieFlix is ready. Share ${localUrl} with whoever you're watching with — they need to be on the same Wi-Fi.`
                : mode === 'tunnel'
                ? `PookieFlix is live at ${baseUrl}. Upload a video, share the room link, and enjoy.`
                : `PookieFlix is ready at ${baseUrl}. Upload a video and share the room link.`}
            </p>
            {mode === 'tunnel' && tunnelToken && (
              <p className="setup-desc" style={{ fontSize: '0.85em', opacity: 0.6, marginTop: 0 }}>
                To make the tunnel start automatically, add <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>TUNNEL_TOKEN</code> to your docker-compose environment and run with the <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>tunnel</code> profile.
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
