import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LibraryFile } from '../types';

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

  const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';

  const [library, setLibrary] = useState<LibraryFile[]>([]);
  const [uploadUrl, setUploadUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadingName, setUploadingName] = useState('');
  const [error, setError] = useState('');
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const [thumbErrors, setThumbErrors] = useState<Set<string>>(new Set());
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [fetchingSubFile, setFetchingSubFile] = useState<string | null>(null);

  const loadLibrary = useCallback(() => {
    fetch('/api/library')
      .then(r => r.json())
      .then((d: { files: LibraryFile[] }) => setLibrary(d.files))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then((c: { uploadUrl: string | null }) => {
      if (c.uploadUrl) setUploadUrl(c.uploadUrl);
    }).catch(() => {});
    loadLibrary();
    const interval = setInterval(loadLibrary, 3000);
    return () => clearInterval(interval);
  }, [loadLibrary]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  };

  const uploadFile = async (file: File) => {
    setError('');
    if (!file.name.toLowerCase().endsWith('.mp4') && file.type !== 'video/mp4') {
      setError('Only MP4 files are supported.');
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setUploadingName(file.name);

    try {
      const formData = new FormData();
      formData.append('video', file);

      const result = await new Promise<{ roomToken: string; roomUrl: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
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

      window.location.href = result.roomUrl;
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

  const fetchSubtitles = async (filename: string) => {
    setFetchingSubFile(filename);
    try {
      await fetch(`/api/library/${encodeURIComponent(filename)}/subtitles`, { method: 'POST' });
      const poll = setInterval(() => {
        fetch('/api/library').then(r => r.json()).then((d: { files: LibraryFile[] }) => {
          setLibrary(d.files);
          const f = d.files.find(f => f.filename === filename);
          if (!f || !f.subtitleFetching) { clearInterval(poll); setFetchingSubFile(null); }
        }).catch(() => {});
      }, 1500);
    } catch {
      setFetchingSubFile(null);
    }
  };

  return (
    <div className="home-root">
      <header className="home-topbar">
        <span className="home-logo">WatchTogether</span>
      </header>

      {/* Upload zone */}
      {isHttps && uploadUrl ? (
        <a className="upload-zone upload-zone-lan" href={uploadUrl} target="_self">
          <div className="upload-icon">⬆</div>
          <div className="upload-label">Click to open uploader on local network</div>
          <div className="upload-hint">
            Large files can't upload through Cloudflare — this opens <strong>{uploadUrl}</strong> directly
          </div>
        </a>
      ) : (
        <div
          className={`upload-zone ${uploading ? 'uploading' : ''}`}
          onClick={() => !uploading && fileInputRef.current?.click()}
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
          ) : (
            <>
              <div className="upload-icon">⬆</div>
              <div className="upload-label">Drop an MP4 here or click to upload</div>
              <div className="upload-hint">Uploads go to your library and are never auto-deleted</div>
            </>
          )}
        </div>
      )}
      <input ref={fileInputRef} type="file" accept="video/mp4,.mp4" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); }} />
      {error && <div className="home-error">{error}</div>}

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
                      title={`${f.filename} — click to rename`}
                      onClick={() => startRename(f.filename)}
                    >
                      {f.filename}
                    </div>
                  )}
                  <div className="lib-meta-row">
                    <span className="lib-size">{formatBytes(f.size)}</span>
                    {f.hasSubtitles && <span className="lib-sub-badge" title="Subtitles available">CC</span>}
                    {f.subtitleFetching && <span className="lib-sub-badge lib-sub-fetching" title="Fetching subtitles…">CC…</span>}
                    {f.lastTime > 5 && (
                      <span className="lib-resume" title="Resume position">
                        ↩ {formatTime(f.lastTime)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="lib-actions">
                  <button className="lib-watch-btn" onClick={() => createRoomFrom(f.filename)}>
                    {f.lastTime > 5 ? 'Resume' : 'Watch'}
                  </button>
                  {!f.hasSubtitles && !f.subtitleFetching && (
                    <button className="lib-sub-btn" disabled={fetchingSubFile === f.filename}
                      onClick={() => fetchSubtitles(f.filename)} title="Fetch subtitles from OpenSubtitles">
                      {fetchingSubFile === f.filename ? '…' : 'CC'}
                    </button>
                  )}
                  <button
                    className="lib-delete-btn"
                    disabled={deletingFile === f.filename}
                    onClick={() => deleteFile(f.filename)}
                    title="Delete from library"
                  >
                    {deletingFile === f.filename ? '…' : '🗑'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
