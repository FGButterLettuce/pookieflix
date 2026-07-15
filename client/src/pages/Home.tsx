import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { PasswordInput } from '../components/PasswordInput';
import { useTheme } from '../theme/ThemeContext';
import type { LibraryFile } from '../types';



const LANG_FLAGS: Record<string, string> = {
  en: '🇬🇧', fr: '🇫🇷', de: '🇩🇪', es: '🇪🇸', pt: '🇵🇹',
  it: '🇮🇹', nl: '🇳🇱', pl: '🇵🇱', ru: '🇷🇺', ja: '🇯🇵',
  ko: '🇰🇷', zh: '🇨🇳', ar: '🇸🇦', tr: '🇹🇷', sv: '🇸🇪',
  da: '🇩🇰', fi: '🇫🇮', nb: '🇳🇴', cs: '🇨🇿', ro: '🇷🇴',
  hu: '🇭🇺', el: '🇬🇷', he: '🇮🇱', th: '🇹🇭', vi: '🇻🇳',
  id: '🇮🇩', hi: '🇮🇳',
};
function langFlag(code: string): string { return LANG_FLAGS[code] ?? code.toUpperCase(); }

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTime(seconds: number): string {
  return formatDuration(seconds);
}

function progressPct(lastTime: number, duration: number): number {
  if (!duration || !lastTime) return 0;
  return Math.min(100, (lastTime / duration) * 100);
}

export function Home() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { theme } = useTheme();
  const [library, setLibrary] = useState<LibraryFile[]>([]);
  const [uploadUrl, setUploadUrl] = useState('');
  const [subtitleLang, setSubtitleLang] = useState('en');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadingName, setUploadingName] = useState('');
  const [uploadedRoomUrl, setUploadedRoomUrl] = useState('');
  const [error, setError] = useState('');
  const [lanLink, setLanLink] = useState('');
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const [thumbErrors, setThumbErrors] = useState<Set<string>>(new Set());
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const [subPickerFile, setSubPickerFile] = useState<string | null>(null);
  const [subQuery, setSubQuery] = useState('');
  const [subResults, setSubResults] = useState<{ fileId: number; label: string }[]>([]);
  const [subSearching, setSubSearching] = useState(false);
  const [subApplying, setSubApplying] = useState(false);
  const [subUploading, setSubUploading] = useState(false);
  const [subUploadError, setSubUploadError] = useState('');
  const [subAutoLoading, setSubAutoLoading] = useState(false);
  const [subRemoving, setSubRemoving] = useState(false);
  const subFileInputRef = useRef<HTMLInputElement>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const loadLibrary = useCallback(() => {
    fetch('/api/library')
      .then(r => {
        if (r.status === 401) { setAuthed(false); return null; }
        return r.json();
      })
      .then((d: { files: LibraryFile[] } | null) => { if (d) setLibrary(d.files); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: { authed: boolean }) => setAuthed(d.authed))
      .catch(() => setAuthed(false));
    fetch('/api/config').then(r => r.json()).then((c: { uploadUrl: string | null; subtitleLang?: string }) => {
      if (c.uploadUrl) setUploadUrl(c.uploadUrl);
      if (c.subtitleLang) setSubtitleLang(c.subtitleLang);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!authed) return;
    loadLibrary();
    const interval = setInterval(loadLibrary, 3000);
    return () => clearInterval(interval);
  }, [authed, loadLibrary]);

  const login = async () => {
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword }),
      });
      if (res.ok) { setAuthed(true); setLoginPassword(''); }
      else setLoginError('Wrong password');
    } catch { setLoginError('Could not connect'); }
    setLoginLoading(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  };

  const uploadFile = async (file: File) => {
    setError('');
    setLanLink('');
    if (!file.name.toLowerCase().endsWith('.mp4') && file.type !== 'video/mp4') {
      setError('Only MP4 files are supported.');
      return;
    }

    const onUploadOrigin = !!uploadUrl && new URL(uploadUrl).origin === window.location.origin;

    if (uploadUrl && !onUploadOrigin) {
      if (window.location.protocol === 'https:' && uploadUrl.startsWith('http://')) {
        // Browsers block HTTPS pages from reaching plain-HTTP servers (mixed content) —
        // no fetch will ever get through here even when on the same LAN.
        setError('Your browser blocks this HTTPS page from reaching the LAN server directly. Open the link below to upload from there instead.');
        setLanLink(uploadUrl);
        return;
      }
      try {
        await fetch(`${uploadUrl}/api/config`, { signal: AbortSignal.timeout(3000) });
      } catch {
        setError('You need to be on the same Wi-Fi as the server to upload files. Connect to the local network and try again.');
        return;
      }
    }

    setUploading(true);
    setUploadProgress(0);
    setUploadingName(file.name);

    try {
      const formData = new FormData();
      formData.append('video', file);

      const result = await new Promise<{ roomToken: string; roomUrl: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', uploadUrl && !onUploadOrigin ? `${uploadUrl}/api/upload` : '/api/upload');
        xhr.withCredentials = true;
        xhr.upload.addEventListener('progress', e => {
          if (e.lengthComputable) setUploadProgress(Math.round(e.loaded / e.total * 100));
        });
        xhr.addEventListener('load', () => {
          if (xhr.status === 201) resolve(JSON.parse(xhr.responseText));
          else {
            try { reject(new Error(JSON.parse(xhr.responseText).error || 'Upload failed')); }
            catch { reject(new Error('Upload failed')); }
          }
        });
        xhr.addEventListener('error', () => reject(new Error('Network error')));
        xhr.send(formData);
      });

      setUploadedRoomUrl(result.roomUrl);
      setUploading(false);
      setUploadingName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setUploading(false);
      setUploadingName('');
    }
  };

  const createRoomFrom = async (filename: string) => {
    setError('');
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });
      const data = await res.json() as { roomToken?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      navigate(`/room/${data.roomToken!}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const deleteFile = async (filename: string) => {
    setDeletingFile(filename);
    try {
      await fetch(`/api/library/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      loadLibrary();
    } catch {
      setError('Delete failed');
    } finally {
      setDeletingFile(null);
    }
  };

  const [transcodeBusy, setTranscodeBusy] = useState<string | null>(null);
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);

  const transcodeAction = async (filename: string, action: 'cancel' | 'pause' | 'resume' | 'restart') => {
    setTranscodeBusy(filename);
    try {
      await fetch(`/api/library/${encodeURIComponent(filename)}/transcode/${action}`, { method: 'POST' });
      loadLibrary();
    } catch {
      setError('Transcode action failed');
    } finally {
      setTranscodeBusy(null);
    }
  };

  const resetProgress = async (filename: string) => {
    setOpenMenuFor(null);
    try {
      await fetch(`/api/library/${encodeURIComponent(filename)}/reset-progress`, { method: 'POST' });
      loadLibrary();
    } catch {
      setError('Reset failed');
    }
  };

  const startRename = (filename: string) => {
    setRenamingFile(filename);
    setRenameValue(filename);
  };

  const commitRename = async (oldFilename: string) => {
    const newFilename = renameValue.trim();
    setRenamingFile(null);
    if (!newFilename || newFilename === oldFilename) return;
    const finalName = newFilename.toLowerCase().endsWith('.mp4') ? newFilename : newFilename + '.mp4';
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(oldFilename)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newFilename: finalName }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) setError(data.error ?? 'Rename failed');
      else loadLibrary();
    } catch {
      setError('Rename failed');
    }
  };


  const openSubPicker = (filename: string) => {
    const query = filename.replace(/\.mp4$/i, '');
    setSubPickerFile(filename);
    setSubQuery(query);
    setSubResults([]);
    setSubUploadError('');
    if (query) {
      setSubSearching(true);
      fetch(`/api/subtitle-search?q=${encodeURIComponent(query)}`)
        .then(r => r.json())
        .then((d: { results: { fileId: number; label: string }[] }) => setSubResults(d.results ?? []))
        .catch(() => {})
        .finally(() => setSubSearching(false));
    }
  };

  const closeSubPicker = () => {
    setSubPickerFile(null);
    setSubResults([]);
    setSubUploadError('');
  };

  const uploadSubFile = async (file: File) => {
    if (!subPickerFile) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'srt' && ext !== 'vtt') {
      setSubUploadError('Only .srt and .vtt files are supported');
      return;
    }
    setSubUploading(true);
    setSubUploadError('');
    try {
      const form = new FormData();
      form.append('subtitle', file);
      const res = await fetch(`/api/library/${encodeURIComponent(subPickerFile)}/subtitle-upload`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setSubUploadError(d.error ?? 'Upload failed');
      } else {
        closeSubPicker();
        loadLibrary();
      }
    } catch {
      setSubUploadError('Upload failed');
    } finally {
      setSubUploading(false);
    }
  };

  const autoPick = async () => {
    if (!subPickerFile) return;
    setSubAutoLoading(true);
    await fetch(`/api/library/${encodeURIComponent(subPickerFile)}/subtitles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    }).catch(() => {});
    setSubAutoLoading(false);
    closeSubPicker();
    loadLibrary();
  };

  const removeSub = async () => {
    if (!subPickerFile) return;
    setSubRemoving(true);
    await fetch(`/api/library/${encodeURIComponent(subPickerFile)}/subtitles`, { method: 'DELETE' }).catch(() => {});
    setSubRemoving(false);
    loadLibrary();
  };

  const searchSubs = async () => {
    if (!subQuery.trim()) return;
    setSubSearching(true);
    setSubResults([]);
    try {
      const res = await fetch(`/api/subtitle-search?q=${encodeURIComponent(subQuery.trim())}`);
      const data = await res.json() as { results: { fileId: number; label: string }[] };
      setSubResults(data.results ?? []);
    } finally {
      setSubSearching(false);
    }
  };

  const applySub = async (filename: string, fileId: number, label: string) => {
    setSubApplying(true);
    try {
      await fetch(`/api/library/${encodeURIComponent(filename)}/subtitles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, label }),
      });
      closeSubPicker();
      loadLibrary();
    } finally {
      setSubApplying(false);
    }
  };

  if (authed === false) {
    return (
      <div className="home-root" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="setup-card" style={{ maxWidth: 360, width: '100%' }}>
          <div className="overlay-icon" style={{ fontSize: 32, marginBottom: 12 }}>🎬</div>
          <h1 className="setup-title" style={{ marginBottom: 20 }}>PookieFlix</h1>
          <PasswordInput
            className="setup-input"
            placeholder="Password"
            value={loginPassword}
            autoFocus
            onChange={e => setLoginPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void login()}
          />
          {loginError && <div className="home-error" style={{ margin: '8px 0' }}>{loginError}</div>}
          <button className="primary-btn" style={{ width: '100%', marginTop: 12 }} onClick={() => void login()} disabled={loginLoading}>
            {loginLoading ? 'Checking…' : 'Sign in'}
          </button>
        </div>
      </div>
    );
  }

  if (authed === null) return null; // loading

  return (
    <div className="home-root">
      <header className="home-topbar">
        <span className="home-logo"><Logo size="sm" variant={theme} /></span>
        <Link to="/settings" className="settings-link" title="Settings">⚙</Link>
      </header>

      {/* Upload zone */}
      <div
        className={`upload-zone ${uploading || uploadedRoomUrl ? 'uploading' : ''}`}
        onClick={() => !uploading && !uploadedRoomUrl && fileInputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={handleDrop}
      >
        {uploading ? (
          <div className="upload-progress-inner">
            <div className="spinner" />
            <span className="upload-filename">{uploadingName}</span>
            <div className="upload-bar">
              <div className="upload-bar-fill" style={{ width: `${uploadProgress}%` }} />
            </div>
            <span className="upload-pct">{uploadProgress}%</span>
          </div>
        ) : uploadedRoomUrl ? (
          <div className="upload-progress-inner">
            <div className="upload-icon">✓</div>
            <div className="upload-label">Upload complete</div>
            <a className="primary-btn" href={uploadedRoomUrl} style={{ marginTop: 10 }}>
              Watch on PookieFlix →
            </a>
            <button className="secondary-btn" style={{ marginTop: 8 }} onClick={() => setUploadedRoomUrl('')}>
              Upload another
            </button>
          </div>
        ) : (
          <>
            <div className="upload-icon">⬆</div>
            <div className="upload-label">Drop an MP4 here or click to upload</div>
            <div className="upload-hint">Uploads go to your library and are never auto-deleted</div>
          </>
        )}
      </div>
      <input ref={fileInputRef} type="file" accept="video/mp4,.mp4" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); }} />
      {error && (
        <div className="home-error">
          {error}
          {lanLink && (
            <>
              {' '}
              <a href={lanLink} target="_blank" rel="noreferrer">Open LAN link to upload →</a>
            </>
          )}
        </div>
      )}

      {/* Library grid */}
      {library.length === 0 && !uploading ? (
        <div className="library-empty">
          <div className="library-empty-icon">🎬</div>
          <div>Your library is empty. Upload a video to get started.</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
            You can also drop files into <code>data/media/library/</code> on the server.
          </div>
        </div>
      ) : (
        <div className="library-grid">
          {library.map(f => {
            const pct = progressPct(f.lastTime, f.duration);
            const hasThumb = f.thumbReady && !thumbErrors.has(f.filename);

            return (
              <div key={f.filename} className="lib-card">
                {/* Thumbnail */}
                <div className="lib-thumb-wrap" onClick={() => createRoomFrom(f.filename)}>
                  {hasThumb ? (
                    <img
                      className="lib-thumb"
                      src={`${f.thumbUrl}?v=${f.lastPlayedAt}`}
                      alt=""
                      onError={() => setThumbErrors(s => new Set([...s, f.filename]))}
                    />
                  ) : (
                    <div className="lib-thumb-placeholder">
                      {f.thumbReady ? '🎬' : <span className="thumb-spinner" />}
                    </div>
                  )}
                  <div className="lib-play-overlay">▶</div>
                  {f.duration > 0 && (
                    <span className="lib-duration">{formatDuration(f.duration)}</span>
                  )}
                  {pct > 1 && (
                    <div className="lib-progress-bar">
                      <div className="lib-progress-fill" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>

                {/* Info row */}
                <div className="lib-info">
                  {renamingFile === f.filename ? (
                    <input
                      className="lib-rename-input"
                      value={renameValue}
                      autoFocus
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(f.filename)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename(f.filename);
                        if (e.key === 'Escape') setRenamingFile(null);
                      }}
                    />
                  ) : (
                    <div
                      className="lib-name"
                      title={`Click to rename ${f.filename}`}
                      onClick={() => startRename(f.filename)}
                    >
                      {f.filename}
                    </div>
                  )}
                  <div className="lib-meta-row">
                    <span className="lib-size">{formatBytes(f.size)}</span>
                    {f.subtitleFetching && <span className="lib-sub-badge lib-sub-fetching" title="Fetching subtitles…">CC…</span>}
                    {!f.subtitleFetching && f.hasSubtitles && (
                      <span className="lib-sub-badge" title="Subtitles loaded">CC ✓ {langFlag(subtitleLang)}</span>
                    )}
                    {f.transcodeStatus === 'running' && (
                      <span className="lib-sub-badge lib-sub-fetching" title="Transcoding to HLS…">HLS…</span>
                    )}
                    {f.transcodeStatus === 'paused' && (
                      <span className="lib-sub-badge" title="Transcode paused">HLS ⏸</span>
                    )}
                    {f.transcodeStatus === 'queued' && (
                      <span className="lib-sub-badge" title="Waiting for another transcode to finish first">HLS queued</span>
                    )}
                    {f.lastTime > 5 && (
                      <span className="lib-resume" title="Resume position">
                        ↩ {formatTime(f.lastTime)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions — Watch/Resume is the only action that lives on
                    the card itself. Everything else (subtitles, transcode
                    controls, reset progress, delete) is one tap away in the
                    "⋯" menu instead of crowding a card this small. */}
                <div className="lib-actions">
                  <div className="lib-actions-row">
                    <button className="lib-watch-btn" onClick={() => createRoomFrom(f.filename)}>
                      {f.lastTime > 5 ? 'Resume' : 'Watch'}
                    </button>
                    <div className="lib-menu-wrap">
                      <button
                        className={`lib-menu-btn${openMenuFor === f.filename ? ' lib-menu-btn--open' : ''}`}
                        onClick={() => setOpenMenuFor(openMenuFor === f.filename ? null : f.filename)}
                        title="More actions"
                      >
                        ⋯
                      </button>
                      {openMenuFor === f.filename && (
                        <>
                          <div className="lib-menu-backdrop" onClick={() => setOpenMenuFor(null)} />
                          <div className="lib-menu">
                            <button
                              className={`lib-menu-item${f.hasSubtitles ? ' lib-menu-item--sub-active' : ''}`}
                              onClick={() => { setOpenMenuFor(null); openSubPicker(f.filename); }}
                            >
                              {f.hasSubtitles ? `✓ Subtitles (${langFlag(subtitleLang)})` : 'Add subtitles'}
                            </button>

                            {f.transcodeStatus === 'queued' && (
                              <button
                                className="lib-menu-item"
                                disabled={transcodeBusy === f.filename}
                                onClick={() => void transcodeAction(f.filename, 'cancel')}
                              >
                                ⏹ Cancel (queued)
                              </button>
                            )}
                            {f.transcodeStatus === 'running' && (
                              <>
                                <button
                                  className="lib-menu-item"
                                  disabled={transcodeBusy === f.filename}
                                  onClick={() => void transcodeAction(f.filename, 'pause')}
                                >
                                  ⏸ Pause transcode
                                </button>
                                <button
                                  className="lib-menu-item"
                                  disabled={transcodeBusy === f.filename}
                                  onClick={() => void transcodeAction(f.filename, 'cancel')}
                                >
                                  ⏹ Cancel transcode
                                </button>
                              </>
                            )}
                            {f.transcodeStatus === 'paused' && (
                              <>
                                <button
                                  className="lib-menu-item"
                                  disabled={transcodeBusy === f.filename}
                                  onClick={() => void transcodeAction(f.filename, 'resume')}
                                >
                                  ▶ Resume transcode
                                </button>
                                <button
                                  className="lib-menu-item"
                                  disabled={transcodeBusy === f.filename}
                                  onClick={() => void transcodeAction(f.filename, 'cancel')}
                                >
                                  ⏹ Cancel transcode
                                </button>
                              </>
                            )}
                            {(f.transcodeStatus === 'complete' || f.transcodeStatus === 'none') && (
                              <button
                                className="lib-menu-item"
                                disabled={transcodeBusy === f.filename}
                                onClick={() => void transcodeAction(f.filename, 'restart')}
                              >
                                ↻ {f.transcodeStatus === 'complete' ? 'Re-transcode' : 'Transcode now'}
                              </button>
                            )}

                            {f.lastTime > 5 && (
                              <button className="lib-menu-item" onClick={() => void resetProgress(f.filename)}>
                                ↺ Start over
                              </button>
                            )}

                            <div className="lib-menu-divider" />
                            <button
                              className="lib-menu-item lib-menu-item--danger"
                              disabled={deletingFile === f.filename}
                              onClick={() => { setOpenMenuFor(null); deleteFile(f.filename); }}
                            >
                              🗑 {deletingFile === f.filename ? 'Deleting…' : 'Delete'}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Subtitle modal */}
      {subPickerFile && (() => {
        const currentFile = library.find(f => f.filename === subPickerFile);
        const hasSub = currentFile?.hasSubtitles ?? false;
        return (
        <div className="sub-modal-overlay" onClick={closeSubPicker}>
          <div className="sub-modal" onClick={e => e.stopPropagation()}>
            <div className="sub-modal-header">
              <div>
                <div className="sub-modal-title">Subtitles</div>
                <div className="sub-modal-filename">{subPickerFile}</div>
              </div>
              <button className="sub-modal-close" onClick={closeSubPicker}>✕</button>
            </div>

            {/* Current status */}
            <div className="sub-modal-section sub-modal-status-row">
              <div className={`sub-modal-status ${hasSub ? 'sub-modal-status--active' : ''}`}>
                <span className="sub-modal-status-dot" />
                {hasSub ? 'Subtitles active' : 'No subtitles'}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="lib-sub-btn" onClick={() => void autoPick()} disabled={subAutoLoading}>
                  {subAutoLoading ? '…' : 'Auto-pick'}
                </button>
                {hasSub && (
                  <button className="lib-sub-btn sub-remove-btn" onClick={() => void removeSub()} disabled={subRemoving}>
                    {subRemoving ? '…' : 'Remove'}
                  </button>
                )}
              </div>
            </div>

            {/* Upload section */}
            <div className="sub-modal-section">
              <div className="sub-modal-label">Upload your own</div>
              <div
                className="sub-upload-zone"
                onClick={() => subFileInputRef.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void uploadSubFile(f); }}
              >
                {subUploading ? <span className="spinner" /> : <span>Drop a .srt or .vtt here, or click to browse</span>}
              </div>
              <input
                ref={subFileInputRef}
                type="file"
                accept=".srt,.vtt"
                style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) void uploadSubFile(f); e.target.value = ''; }}
              />
              {subUploadError && <div className="sub-modal-error">{subUploadError}</div>}
            </div>

            {/* Search section */}
            <div className="sub-modal-section">
              <div className="sub-modal-label">Search OpenSubtitles</div>
              <div className="sub-search-row">
                <input
                  className="sub-search-input"
                  value={subQuery}
                  autoFocus
                  onChange={e => setSubQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && void searchSubs()}
                  placeholder="Movie title…"
                />
                <button className="lib-sub-btn" onClick={() => void searchSubs()} disabled={subSearching}>
                  {subSearching ? '…' : 'Search'}
                </button>
              </div>
              {(hasSub || subResults.length > 0) && (
                <ul className="sub-modal-results">
                  {hasSub && (
                    <li className="sub-modal-result sub-modal-result--active">
                      <span className="sub-modal-result-label">
                        {currentFile?.subtitleName ?? 'Subtitle loaded'}
                      </span>
                      <span className="sub-modal-result-active-badge">✓ Active</span>
                    </li>
                  )}
                  {subResults.map(r => (
                    <li key={r.fileId} className="sub-modal-result">
                      <span className="sub-modal-result-label">{r.label}</span>
                      <button className="lib-sub-btn" onClick={() => void applySub(subPickerFile, r.fileId, r.label)} disabled={subApplying}>
                        {subApplying ? '…' : 'Use'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {subResults.length === 0 && !subSearching && subQuery && (
                <div className="sub-modal-hint">No results found.</div>
              )}
              {!hasSub && subResults.length === 0 && !subSearching && !subQuery && (
                <div className="sub-modal-hint">Search for a subtitle above, or upload your own file.</div>
              )}
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}
