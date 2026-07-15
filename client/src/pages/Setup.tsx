import { useMemo, useState } from 'react';
import {
  MapPin, Home, Cloud, Link2, UsersRound, ShoppingBag, Globe,
  KeyRound, Check, Lock, LogIn, Network, CirclePlus, Save,
} from 'lucide-react';
import { Logo } from '../components/Logo';
import { PasswordInput } from '../components/PasswordInput';
import { PasteableInput } from '../components/PasteableInput';
import { useTheme } from '../theme/ThemeContext';
import { generateDomainSuggestions } from '../lib/domainSuggestions';

async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the execCommand fallback below
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

type Mode = 'local' | 'tunnel' | 'ddns' | null;

export function Setup({ onComplete }: { onComplete: () => void }) {
  const { theme } = useTheme();
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<Mode>(null);
  const [tunnelSubStep, setTunnelSubStep] = useState(0);
  const [baseUrl, setBaseUrl] = useState('');
  const [tunnelToken, setTunnelToken] = useState('');
  const [tunnelPhase, setTunnelPhase] = useState<'domain-check' | 'domain-names' | 'domain-suggestions' | 'cloudflare'>('domain-check');
  const [userName, setUserName] = useState('');
  const [partnerName, setPartnerName] = useState('');
  const [copiedDomain, setCopiedDomain] = useState<string | null>(null);
  const [showAdvancedPort, setShowAdvancedPort] = useState(false);
  const [containerPort, setContainerPort] = useState(() => window.location.port || '3000');
  const [uploadUrl, setUploadUrl] = useState('');
  const [subsKey, setSubsKey] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const domainSuggestions = useMemo(
    () => generateDomainSuggestions(userName, partnerName),
    [userName, partnerName]
  );

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
    setTunnelPhase('domain-check');
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
          USER_NAME: userName.trim() || undefined,
          PARTNER_NAME: partnerName.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        throw new Error(d.error ?? 'Failed to save');
      }
      setStep(4);
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
              <Logo size="lg" variant={theme} />
            </div>
            <p className="setup-desc">
              watch movies in perfect sync with someone. your files, your server, completely
              private, and free to use however you want.
            </p>
            <p className="setup-desc" style={{ opacity: 0.55, fontSize: '0.88em', marginTop: 0 }}>
              takes about 2–5 minutes to set up.
            </p>
            <button className="primary-btn setup-btn" onClick={() => setStep(1)}>let's go →</button>
          </div>
        )}

        {/* Step 1 — Where */}
        {step === 1 && (
          <div className="setup-step">
            <div className="setup-icon"><MapPin /></div>
            <h1 className="setup-title">where will you two be watching from?</h1>
            <p className="setup-desc">pick what fits — you can change this later</p>
            <div className="mode-columns">
              <div className="mode-card">
                <div className="mode-card-icon"><Home /></div>
                <div className="mode-card-title">home only</div>
                <div className="mode-card-desc">same wifi as your partner</div>
                <div className="mode-prereq-pills">
                  <span className="mode-prereq-pill mode-prereq-pill--ok">nothing needed</span>
                </div>
                <button className="mode-choose-btn" onClick={chooseLocal}>choose</button>
              </div>

              <div className="mode-card mode-card--featured">
                <span className="mode-card-badge">recommended</span>
                <div className="mode-card-icon"><Cloud /></div>
                <div className="mode-card-title">tunnel</div>
                <div className="mode-card-desc">watch from anywhere, free and secure</div>
                <div className="mode-prereq-pills">
                  <span className="mode-prereq-pill">needs a domain</span>
                  <span className="mode-prereq-pill">needs a free cloudflare account</span>
                </div>
                <button className="mode-choose-btn mode-choose-btn--primary" onClick={chooseTunnel}>choose</button>
              </div>

              <div className="mode-card">
                <div className="mode-card-icon"><Link2 /></div>
                <div className="mode-card-title">ddns</div>
                <div className="mode-card-desc">watch from anywhere, no domain needed</div>
                <div className="mode-prereq-pills">
                  <span className="mode-prereq-pill">needs router access</span>
                </div>
                <button className="mode-choose-btn" onClick={chooseDDNS}>choose</button>
              </div>
            </div>
            <button className="setup-back" onClick={() => setStep(0)}>← back</button>
          </div>
        )}

        {/* Step 2 — Cloudflare Tunnel (3 sub-steps) */}
        {step === 2 && mode === 'tunnel' && (
          <div className="setup-step">

            {tunnelPhase === 'domain-check' && (<>
              <div className="setup-icon"><Globe /></div>
              <h1 className="setup-title">quick check — got a domain already?</h1>
              <p className="setup-desc">
                the tunnel needs a domain name pointed at cloudflare. if you don't have one yet,
                that's normal — they're cheap and we can help you pick one.
              </p>
              <div className="domain-check-choices">
                <button className="secondary-btn" onClick={() => setTunnelPhase('cloudflare')}>
                  yep, i've got one →
                </button>
                <button className="primary-btn setup-btn" onClick={() => setTunnelPhase('domain-names')}>
                  nope, help me get one 🛍️
                </button>
              </div>
              <button className="setup-back" onClick={() => setStep(1)}>← back</button>
            </>)}

            {tunnelPhase === 'domain-names' && (<>
              <div className="setup-icon"><UsersRound /></div>
              <h1 className="setup-title">who's watching?</h1>
              <p className="setup-desc">two names, and we'll suggest some domain ideas just for you two.</p>
              <PasteableInput
                className="setup-input"
                placeholder="your name"
                value={userName}
                onChange={e => setUserName(e.target.value)}
                autoFocus
              />
              <PasteableInput
                className="setup-input"
                placeholder="their name"
                value={partnerName}
                onChange={e => setPartnerName(e.target.value)}
              />
              <div className="setup-nav">
                <button className="setup-back" onClick={() => setTunnelPhase('domain-check')}>← back</button>
                <button
                  className="primary-btn setup-btn"
                  onClick={() => setTunnelPhase('domain-suggestions')}
                  disabled={!userName.trim() || !partnerName.trim()}
                >
                  show me ideas →
                </button>
              </div>
            </>)}

            {tunnelPhase === 'domain-suggestions' && (<>
              <div className="setup-icon"><ShoppingBag /></div>
              <h1 className="setup-title">{userName} &amp; {partnerName}, here's a few ideas</h1>
              <p className="setup-desc">
                domains like this run about <strong>$3–12/year</strong> — cheaper than one
                streaming subscription. pick one, buy it, then come back and continue below.
              </p>
              <div className="domain-suggestion-list">
                {domainSuggestions.map(s => (
                  <div
                    key={s.domain}
                    className={`domain-suggestion-card${s.featured ? ' domain-suggestion-card--featured' : ''}`}
                  >
                    <span className="domain-suggestion-name">{s.domain}</span>
                    <div className="domain-suggestion-actions">
                      <button
                        type="button"
                        className="copy-btn"
                        onClick={async () => {
                          const ok = await copyToClipboard(s.domain);
                          if (ok) {
                            setCopiedDomain(s.domain);
                            setTimeout(() => setCopiedDomain(d => (d === s.domain ? null : d)), 2000);
                          }
                        }}
                      >
                        {copiedDomain === s.domain ? 'copied!' : 'copy'}
                      </button>
                      <a
                        className="domain-suggestion-cta"
                        href="https://www.spaceship.com/domain-search/"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        search on spaceship →
                      </a>
                    </div>
                  </div>
                ))}
              </div>
              <div className="setup-nav">
                <button className="setup-back" onClick={() => setTunnelPhase('domain-names')}>← back</button>
                <button className="primary-btn setup-btn" onClick={() => setTunnelPhase('cloudflare')}>
                  got one, continue →
                </button>
              </div>
            </>)}

            {tunnelPhase === 'cloudflare' && (<>

            {tunnelSubStep === 0 && (<>
              <div className="setup-task-header">
                <div className="setup-icon"><Cloud /></div>
                <h1 className="setup-title">create a cloudflare tunnel</h1>
              </div>
              <p className="setup-desc setup-desc--left">
                a cloudflare tunnel gives your server a public web address, with no static IP or port forwarding needed. it's free.
              </p>
              <div className="step-flow">
                <div className="step-flow-item">
                  <div className="step-flow-icon"><LogIn /></div>
                  <div className="step-flow-label">sign in to cloudflare</div>
                </div>
                <div className="step-flow-arrow">→</div>
                <div className="step-flow-item">
                  <div className="step-flow-icon"><Network /></div>
                  <div className="step-flow-label">networking → tunnels</div>
                </div>
                <div className="step-flow-arrow">→</div>
                <div className="step-flow-item">
                  <div className="step-flow-icon"><CirclePlus /></div>
                  <div className="step-flow-label">create a tunnel</div>
                </div>
                <div className="step-flow-arrow">→</div>
                <div className="step-flow-item">
                  <div className="step-flow-icon"><Save /></div>
                  <div className="step-flow-label">save it</div>
                </div>
              </div>
              <a
                className="external-cta-btn"
                href="https://dash.cloudflare.com/"
                target="_blank"
                rel="noopener noreferrer"
              >
                open dash.cloudflare.com ↗
              </a>
              <ol className="setup-instructions">
                <li>sign in (or create a free account)</li>
                <li>in the left sidebar, click <strong>Networking → Tunnels</strong></li>
                <li>click <strong>Create a tunnel</strong>, choose <strong>Cloudflared</strong>, and give it any name (e.g. "home")</li>
                <li>click <strong>Save tunnel</strong>. don't close this page, you'll need it next</li>
              </ol>
              <div className="setup-nav">
                <button className="setup-back" onClick={() => setTunnelPhase('domain-check')}>← back</button>
                <button className="primary-btn setup-btn" onClick={() => setTunnelSubStep(1)}>done, next →</button>
              </div>
            </>)}

            {tunnelSubStep === 1 && (<>
              <div className="setup-task-header">
                <div className="setup-icon"><KeyRound /></div>
                <h1 className="setup-title">connect the tunnel</h1>
              </div>
              <p className="setup-desc setup-desc--left">
                pookieflix runs and manages the connector itself — no separate install or terminal
                command needed. cloudflare's page shows you a command to run on your own computer,
                but you can skip that entirely.
              </p>

              <p className="setup-instructions-label">
                1. on the "install cloudflared connector" page, under <strong>Select Operating System</strong>, click <strong>Docker</strong> (not Windows/macOS/Debian/Red Hat):
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
                2. it'll show one command starting with <code>docker run cloudflare/cloudflared…</code>. copy that entire line —
              </p>
              <p className="setup-instructions-label">
                3. …and paste it here (the whole thing, don't bother editing it down — pookieflix will find the token in it automatically):
              </p>
              <PasteableInput
                className="setup-input"
                placeholder="paste the whole docker command (or just the token)"
                value={tunnelToken}
                onChange={e => setTunnelToken(e.target.value)}
                autoFocus
              />

              <div className="setup-nav">
                <button className="setup-back" onClick={() => setTunnelSubStep(0)}>← back</button>
                <button
                  className="primary-btn setup-btn"
                  onClick={() => setTunnelSubStep(2)}
                  disabled={!tunnelToken.trim()}
                >
                  next →
                </button>
              </div>
            </>)}

            {tunnelSubStep === 2 && (<>
              <div className="setup-task-header">
                <div className="setup-icon"><Globe /></div>
                <h1 className="setup-title">add a public hostname</h1>
              </div>
              <p className="setup-desc setup-desc--left">
                now tell cloudflare what web address to use for pookieflix. this only works for a
                domain whose nameservers are already set up in this cloudflare account — if your
                domain lives elsewhere, add it to cloudflare first.
              </p>
              <div className="cf-mockup">
                <div className="cf-mockup-caption">your tunnel → Routes tab</div>
                <div className="cf-mockup-route-row">
                  <span className="cf-mockup-route-btn">Add route</span>
                  <div className="cf-mockup-pointer">👆 click this</div>
                </div>
                <div className="cf-mockup-route-options">
                  <span className="cf-mockup-tab cf-mockup-tab--pick">Published application</span>
                  <span className="cf-mockup-tab cf-mockup-tab--dim">Private Network</span>
                </div>
              </div>
              <p className="setup-hint" style={{ marginBottom: 12 }}>
                (not "Private Network" — that needs the Cloudflare WARP client and won't let you just share a link)
              </p>
              <ol className="setup-instructions">
                <li>choose a subdomain (e.g. <em>watch</em>) and select a domain you have in cloudflare</li>
                <li>set <strong>Service URL</strong> to <code>http://localhost:{containerPort || '3000'}</code> — plain <code>http://</code>, not <code>https://</code>: cloudflare's edge handles the public HTTPS side</li>
                <li>save the route — your public URL will look like <em>https://watch.yourdomain.com</em>. paste it below</li>
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
                  <PasteableInput
                    className="setup-input"
                    inputMode="numeric"
                    placeholder="3000"
                    value={containerPort}
                    onChange={e => setContainerPort(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                </div>
              )}
              <PasteableInput
                className="setup-input"
                type="url"
                placeholder="https://watch.yourdomain.com"
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                autoFocus
              />
              <div className="setup-hint">must start with https://</div>
              <div className="setup-nav">
                <button className="setup-back" onClick={() => setTunnelSubStep(1)}>← back</button>
                <button
                  className="primary-btn setup-btn"
                  onClick={() => setStep(3)}
                  disabled={!baseUrl.trim().startsWith('https://')}
                >
                  next →
                </button>
              </div>
            </>)}

            </>)}
          </div>
        )}

        {/* Step 2 — DDNS */}
        {step === 2 && mode === 'ddns' && (
          <div className="setup-step">
            <div className="setup-task-header">
              <div className="setup-icon"><Link2 /></div>
              <h1 className="setup-title">set up ddns + port forwarding</h1>
            </div>
            <p className="setup-desc setup-desc--left">
              this gives your server a hostname that always follows your home IP address, even
              when it changes.
            </p>
            <a
              className="external-cta-btn"
              href="https://www.duckdns.org/"
              target="_blank"
              rel="noopener noreferrer"
            >
              open duckdns.org ↗
            </a>
            <ol className="setup-instructions">
              <li>sign in with google or github (it's free)</li>
              <li>pick a subdomain name. you'll get <em>yourname.duckdns.org</em></li>
              <li>install the duckdns updater on this computer so it keeps your IP current (instructions on their site for linux/mac/windows)</li>
              <li>log into your <strong>router</strong> (usually at 192.168.0.1 or 192.168.1.1) and find <strong>port forwarding</strong></li>
              <li>forward external port <strong>3000</strong> to <code>{window.location.hostname}</code> port <strong>3000</strong></li>
              <li>your public URL will be <em>http://yourname.duckdns.org:3000</em>. paste it below</li>
            </ol>
            <PasteableInput
              className="setup-input"
              type="url"
              placeholder="http://yourname.duckdns.org:3000"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              autoFocus
            />
            <div className="setup-hint">include the port number unless you set up HTTPS separately</div>
            <div className="setup-nav">
              <button className="setup-back" onClick={() => setStep(1)}>← back</button>
              <button
                className="primary-btn setup-btn"
                onClick={() => setStep(3)}
                disabled={!baseUrl.trim().startsWith('http')}
              >
                next →
              </button>
            </div>
          </div>
        )}

        {/* Step 3 — Password + Subtitles */}
        {step === 3 && (
          <div className="setup-step">
            <div className="setup-icon"><Lock /></div>
            <h1 className="setup-title">set your password</h1>
            <p className="setup-desc">
              {mode === 'local'
                ? "required before you finish, even for a home-only setup — anyone on your wifi could otherwise open the app with no login at all."
                : "required before you finish — without one, pookieflix would be wide open to anyone who finds the URL, tunnel or not."}
            </p>
            <PasswordInput
              className="setup-input"
              placeholder="at least 6 characters"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
            />
            <PasswordInput
              className="setup-input"
              placeholder="confirm password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void finish()}
            />
            <div className="setup-hint">you can change this later in settings</div>

            <hr style={{ margin: '4px 0 20px', borderColor: 'var(--border)' }} />

            <h2 className="settings-label" style={{ fontSize: 15, marginBottom: 8 }}>
              auto subtitles <span className="settings-optional">(optional)</span>
            </h2>
            <p className="setup-desc" style={{ textAlign: 'left', marginBottom: 12 }}>
              pookieflix can automatically fetch subtitles when you upload a video, or you can
              skip this for now and add it later in settings.
            </p>
            <a
              className="external-cta-btn"
              href="https://www.opensubtitles.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              open opensubtitles.com ↗
            </a>
            <ol className="setup-instructions">
              <li>create a free account</li>
              <li>go to your profile → <strong>API Access</strong> and copy your key</li>
              <li>paste it below</li>
            </ol>
            <PasteableInput
              className="setup-input"
              placeholder="paste api key here, or leave blank to skip"
              value={subsKey}
              onChange={e => setSubsKey(e.target.value)}
            />
            {error && <div className="home-error">{error}</div>}
            <div className="setup-nav">
              <button className="setup-back" onClick={() => {
                if (mode === 'local') setStep(1);
                else if (mode === 'tunnel') { setStep(2); setTunnelSubStep(2); }
                else setStep(2);
              }}>← back</button>
              <button
                className="primary-btn setup-btn"
                onClick={() => { void finish(); }}
                disabled={saving || password.length < 6 || password !== confirmPassword}
              >
                {saving ? 'saving…' : 'finish →'}
              </button>
            </div>
          </div>
        )}

        {/* Step 4 — Done */}
        {step === 4 && (
          <div className="setup-step">
            <div className="setup-icon"><Check /></div>
            <h1 className="setup-title">you're all set!</h1>
            <p className="setup-desc">
              {mode === 'local'
                ? `pookieflix is ready. share ${localUrl} with whoever you're watching with. they need to be on the same wifi.`
                : mode === 'tunnel'
                ? `pookieflix is live at ${baseUrl}. upload a video, share the room link, and enjoy.`
                : `pookieflix is ready at ${baseUrl}. upload a video and share the room link.`}
            </p>
            {mode === 'tunnel' && tunnelToken && (
              <p className="setup-desc" style={{ fontSize: '0.85em', opacity: 0.6, marginTop: 0 }}>
                the tunnel connector is already running — no further setup needed. it'll reconnect
                automatically on restart, and you can update the token anytime in Settings.
              </p>
            )}
            <button className="primary-btn setup-btn" onClick={onComplete}>
              go to library →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
