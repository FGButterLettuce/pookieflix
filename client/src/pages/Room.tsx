import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { VideoPlayer } from '../components/VideoPlayer';
import type { VideoPlayerHandle } from '../components/VideoPlayer';
import { RoomStatus } from '../components/RoomStatus';
import { Logo } from '../components/Logo';
import { useTheme } from '../theme/ThemeContext';
import { WsClient } from '../lib/wsClient';
import { rlog } from '../lib/remoteLogger';
import type { VideoController } from '../lib/videoController';
import type {
  RoomState,
  PeerStatus,
  ServerMessage,
} from '../types';

function guessTitle(filename: string): string {
  let t = filename.replace(/\.mp4$/i, '').replace(/[._]/g, ' ');
  t = t.replace(/\b(19|20)\d{2}\b.*/i, '');
  t = t.replace(/\b(480p|576p|720p|1080p|2160p|4k|uhd|hdr|bluray|brrip|webrip|web[-. ]dl|dvdrip|hdtv|x264|x265|hevc|avc|remux|repack)\b.*/gi, '');
  return t.replace(/\s+/g, ' ').trim();
}

const HEARTBEAT_INTERVAL = 500;

// Chrome has added experimental native HLS support and now passes canPlayType
// for it too, but its segment queue doesn't reliably survive a long paused/
// suspended buffer before playback starts (as this app's sync-then-PLAY_AT
// flow does) — DEMUXER_ERROR_COULD_NOT_PARSE fires the moment playback
// actually begins. Safari's native HLS is the mature, battle-tested one, so
// restrict this path to real Safari and let everything else use direct MP4.
function isSafari(): boolean {
  return /^((?!chrome|crios|fxios|edg|android).)*safari/i.test(navigator.userAgent);
}

function supportsHLS(): boolean {
  const v = document.createElement('video');
  return isSafari() && v.canPlayType('application/vnd.apple.mpegurl') !== '';
}

interface RoomInfo {
  viewerId: string;
  isHost: boolean;
  roomState: RoomState;
  viewerCount: number;
  mediaUrl: string;
  mediaFilename: string;
  subtitleUrl?: string;
  hlsUrl?: string;
}

export function Room() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const { theme } = useTheme();
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [roomState, setRoomState] = useState<RoomState>('WAITING_FOR_VIEWERS');
  const [viewerCount, setViewerCount] = useState(0);
  const [peerStatus, setPeerStatus] = useState<PeerStatus>({ bufferedAhead: -1, mediaTime: 0, seeking: false, waiting: false });
  const [copied, setCopied] = useState(false);
  const [fatalError, setFatalError] = useState('');

  const [subtitleUrl, setSubtitleUrl] = useState<string | undefined>();
  const [showSubPicker, setShowSubPicker] = useState(false);
  const [subQuery, setSubQuery] = useState('');
  const [subResults, setSubResults] = useState<{ fileId: number; label: string }[]>([]);
  const [subSearching, setSubSearching] = useState(false);
  const [subApplying, setSubApplying] = useState(false);
  const [subSyncing, setSubSyncing] = useState(false);
  const [subSynced, setSubSynced] = useState(false);
  const [subSyncError, setSubSyncError] = useState('');
  const [subUndoing, setSubUndoing] = useState(false);

  const [previewMode, setPreviewMode] = useState(false);
  const previewModeRef = useRef(false);
  useEffect(() => { previewModeRef.current = previewMode; }, [previewMode]);

  const vcRef = useRef<VideoController | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const videoPlayerRef = useRef<VideoPlayerHandle>(null);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stallCountRef = useRef(0);       // how many quick re-stalls since last stable run
  const lastPlayStartRef = useRef(0);    // epoch ms when PLAYING was last entered
  const prevRoomStateRef = useRef<RoomState>('WAITING_FOR_VIEWERS');
  const peerEverJoinedRef = useRef(false); // true once viewerCount reached 2

  // ── WebSocket setup ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!token) { navigate('/'); return; }

    const ws = new WsClient(token);
    wsRef.current = ws;

    ws.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case 'JOINED': {
          rlog.log(`JOINED host=${msg.isHost} state=${msg.roomState} subs=${!!msg.subtitleUrl} hls=${!!msg.hlsUrl}`);
          setRoomInfo({
            viewerId: msg.viewerId,
            isHost: msg.isHost,
            roomState: msg.roomState,
            viewerCount: 1,
            mediaUrl: msg.mediaUrl,
            mediaFilename: msg.mediaFilename,
            subtitleUrl: msg.subtitleUrl,
            hlsUrl: msg.hlsUrl,
          });
          setSubtitleUrl(msg.subtitleUrl);
          setSubQuery(guessTitle(msg.mediaFilename));
          setRoomState(msg.roomState);
          break;
        }

        case 'ROOM_UPDATE': {
          rlog.log(`ROOM_UPDATE state=${msg.state} viewers=${msg.viewerCount}`);
          const prev = prevRoomStateRef.current;
          if (msg.state === 'PLAYING') lastPlayStartRef.current = Date.now();
          if (msg.state === 'BUFFERING' && prev === 'PLAYING') {
            const playedMs = Date.now() - lastPlayStartRef.current;
            if (playedMs < 12_000) stallCountRef.current += 1;
            else if (playedMs > 25_000) stallCountRef.current = Math.max(0, stallCountRef.current - 1);
          }
          prevRoomStateRef.current = msg.state;
          if (msg.viewerCount >= 2) peerEverJoinedRef.current = true;
          setRoomState(msg.state);
          setViewerCount(msg.viewerCount);
          break;
        }

        case 'PAUSE': {
          rlog.log(`CMD PAUSE at=${msg.mediaTime.toFixed(2)}`);
          vcRef.current?.applyPause(msg.mediaTime);
          break;
        }

        case 'SEEK': {
          rlog.log(`CMD SEEK to=${msg.mediaTime.toFixed(2)}`);
          vcRef.current?.applySeek(msg.mediaTime);
          break;
        }

        case 'PLAY': {
          rlog.log('CMD PLAY');
          vcRef.current?.applyPlay();
          break;
        }

        case 'PLAY_AT': {
          const lag = msg.wallClockTime - Date.now();
          rlog.log(`CMD PLAY_AT time=${msg.mediaTime.toFixed(2)} lag=${lag}ms`);
          vcRef.current?.schedulePlayAt(msg.mediaTime, msg.wallClockTime);
          break;
        }

        case 'RATE_ADJUST': {
          rlog.log(`CMD RATE rate=${msg.playbackRate}`);
          vcRef.current?.applyRateAdjust(msg.playbackRate);
          break;
        }

        case 'PEER_STATUS': {
          setPeerStatus({
            bufferedAhead: msg.bufferedAhead,
            mediaTime: msg.mediaTime,
            seeking: msg.seeking,
            waiting: msg.waiting,
          });
          break;
        }

        case 'ERROR': {
          rlog.error(`SERVER_ERROR: ${msg.message}`);
          setFatalError(msg.message);
          break;
        }
      }
    });

    ws.connect();

    return () => {
      ws.destroy();
      if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
    };
  }, [token, navigate]);

  // ── Heartbeat loop ─────────────────────────────────────────────────────────

  const lastLoggedHbRef = useRef(0);

  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);

    heartbeatIntervalRef.current = setInterval(() => {
      const vc = vcRef.current;
      const ws = wsRef.current;
      if (!vc || !ws) return;

      const hb = vc.getHeartbeat();
      ws.send({ type: 'HEARTBEAT', data: hb });

      // Log heartbeat every 5s or when state is notable
      const now = Date.now();
      if (now - lastLoggedHbRef.current > 5000 || hb.waiting || hb.serverCommandPending) {
        lastLoggedHbRef.current = now;
        rlog.log(`HB rs=${hb.readyState} buf=${hb.bufferedAhead.toFixed(1)}s wait=${hb.waiting} srvCmd=${hb.serverCommandPending} paused=${hb.paused}`);
      }
    }, HEARTBEAT_INTERVAL);
  }, []);

  // ── VideoController ready ──────────────────────────────────────────────────

  const handleControllerReady = useCallback((vc: VideoController) => {
    vcRef.current = vc;
    startHeartbeat();
    vc.on((event) => {
      if (event === 'error') {
        setFatalError('This browser cannot play the video. The codec may not be supported (e.g. H.265/HEVC); try a different browser or ask the host to re-encode to H.264.');
      }
    });
  }, [startHeartbeat]);

  // ── User action callbacks ──────────────────────────────────────────────────

  const handleUserPlay = useCallback(() => {
    if (previewModeRef.current) return;
    wsRef.current?.send({ type: 'USER_ACTION', data: { action: 'PLAY' } });
  }, []);

  const handleUserPause = useCallback(() => {
    if (previewModeRef.current) return;
    wsRef.current?.send({ type: 'USER_ACTION', data: { action: 'PAUSE' } });
  }, []);

  const handleUserSeek = useCallback((time: number) => {
    if (previewModeRef.current) return;
    wsRef.current?.send({ type: 'USER_ACTION', data: { action: 'SEEK', mediaTime: time } });
  }, []);

  // Exit preview when peer joins — server's PLAY_AT naturally resets position
  useEffect(() => {
    if (previewMode && roomState !== 'WAITING_FOR_VIEWERS') {
      setPreviewMode(false);
    }
  }, [roomState, previewMode]);

  // ── Peer status ref (avoid closure stale value in heartbeat) ───────────────
  const peerStatusRef = useRef(peerStatus);
  useEffect(() => { peerStatusRef.current = peerStatus; }, [peerStatus]);

  // ── Subtitle picker ────────────────────────────────────────────────────────

  const searchSubs = useCallback(async () => {
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
  }, [subQuery]);

  const applySub = useCallback(async (fileId: number) => {
    if (!roomInfo) return;
    setSubApplying(true);
    try {
      await fetch(`/api/library/${encodeURIComponent(roomInfo.mediaFilename)}/subtitles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      });
      // Cache-bust so the track element re-fetches the new VTT
      setSubtitleUrl(`/api/subtitle/${token}?v=${Date.now()}`);
      setSubSynced(false);
      setSubSyncError('');
      setShowSubPicker(false);
      setSubResults([]);
    } finally {
      setSubApplying(false);
    }
  }, [roomInfo, token]);

  const removeSubs = useCallback(() => {
    setSubtitleUrl(undefined);
    setShowSubPicker(false);
    setSubResults([]);
    setSubSynced(false);
    setSubSyncError('');
  }, []);

  const syncSubs = useCallback(async () => {
    if (!roomInfo) return;
    setSubSyncing(true);
    setSubSyncError('');
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(roomInfo.mediaFilename)}/subtitles/sync`, {
        method: 'POST',
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setSubSyncError(data.error ?? 'Sync failed');
        return;
      }
      setSubSynced(true);
      setSubtitleUrl(`/api/subtitle/${token}?v=${Date.now()}`);
    } catch {
      setSubSyncError('Sync failed');
    } finally {
      setSubSyncing(false);
    }
  }, [roomInfo, token]);

  const undoSyncSubs = useCallback(async () => {
    if (!roomInfo) return;
    setSubUndoing(true);
    try {
      await fetch(`/api/library/${encodeURIComponent(roomInfo.mediaFilename)}/subtitles/sync/undo`, {
        method: 'POST',
      });
    } finally {
      setSubSynced(false);
      setSubtitleUrl(`/api/subtitle/${token}?v=${Date.now()}`);
      setSubUndoing(false);
    }
  }, [roomInfo, token]);

  // ── Copy room link ─────────────────────────────────────────────────────────

  const copyLink = async () => {
    const url = window.location.href;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
      } else {
        const el = document.createElement('textarea');
        el.value = url;
        el.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* ignore */ }
  };

  // ── Error / loading states ─────────────────────────────────────────────────

  if (fatalError) {
    return (
      <div className="room-error">
        <div className="room-error-card">
          <h2>Room unavailable</h2>
          <p>{fatalError}</p>
          <button className="primary-btn" onClick={() => navigate('/')}>Back to home</button>
        </div>
      </div>
    );
  }

  if (!roomInfo) {
    return (
      <div className="room-loading">
        <div className="spinner" />
        <span>Connecting…</span>
      </div>
    );
  }

  const roomUrl = window.location.href;

  return (
    <div className="room-container">
      <div className="room-header">
        <span className="room-logo">
          <img src="/favicon.svg" alt="" className="room-logo-icon" />
          <span className="room-logo-full"><Logo size="sm" mark={false} variant={theme} /></span>
        </span>
        <span className="room-title" title={roomInfo.mediaFilename}>{guessTitle(roomInfo.mediaFilename)}</span>
        <RoomStatus state={roomState} viewerCount={viewerCount || roomInfo.viewerCount} />
        <div className="room-actions">
          <button
            className={`copy-btn sub-btn${subtitleUrl ? ' sub-btn--active' : ''}`}
            onClick={() => setShowSubPicker(v => !v)}
            title={subtitleUrl ? 'Subtitles on · click to change' : 'Subtitles off · click to search'}
          >
            CC{subtitleUrl ? ' ✓' : ''}
          </button>
          <button
            className="copy-btn"
            onClick={copyLink}
            title="Copy invite link"
          >
            {copied ? '✓ Copied!' : '⎘ Copy link'}
          </button>
        </div>
      </div>

      {showSubPicker && (
        <div className="sub-picker">
          <div className="sub-picker-row">
            <input
              className="sub-picker-input"
              value={subQuery}
              onChange={e => setSubQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void searchSubs()}
              placeholder="Search for subtitles…"
              autoFocus
            />
            <button className="copy-btn" onClick={() => void searchSubs()} disabled={subSearching}>
              {subSearching ? '…' : 'Search'}
            </button>
            {subtitleUrl && (
              <button className="copy-btn sub-remove-btn" onClick={removeSubs} disabled={subSyncing || subUndoing} title="Turn off subtitles">
                Off
              </button>
            )}
            {subtitleUrl && (
              <button className="copy-btn" onClick={() => void syncSubs()} disabled={subSyncing || subUndoing}>
                {subSyncing ? 'Syncing…' : 'Sync subtitles'}
              </button>
            )}
          </div>
          {subSynced && (
            <p className="sub-sync-status">
              Synced. <button className="sub-sync-undo" onClick={() => void undoSyncSubs()} disabled={subSyncing || subUndoing}>Undo</button>
            </p>
          )}
          {subSyncError && <p className="sub-no-results">{subSyncError}</p>}
          {subResults.length > 0 && (
            <ul className="sub-results">
              {subResults.map(r => (
                <li key={r.fileId} className="sub-result">
                  <span className="sub-result-label">{r.label}</span>
                  <button
                    className="copy-btn"
                    onClick={() => void applySub(r.fileId)}
                    disabled={subApplying}
                  >
                    {subApplying ? '…' : 'Use'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {subResults.length === 0 && !subSearching && subQuery && (
            <p className="sub-no-results">No results yet, hit Search</p>
          )}
        </div>
      )}

      <div className="room-player">
        <VideoPlayer
          ref={videoPlayerRef}
          src={roomInfo.hlsUrl && supportsHLS() ? roomInfo.hlsUrl : roomInfo.mediaUrl}
          subtitleUrl={subtitleUrl}
          onControllerReady={handleControllerReady}
          onUserPlay={handleUserPlay}
          onUserPause={handleUserPause}
          onUserSeek={handleUserSeek}
        />

        {previewMode && (
          <div className="preview-banner">
            <span>previewing · pookie's join will reset position</span>
            <button onClick={() => {
              videoPlayerRef.current?.videoElement?.pause();
              setPreviewMode(false);
            }}>exit preview</button>
          </div>
        )}

        {!previewMode && (roomState === 'BUFFERING' || roomState === 'WAITING_FOR_VIEWERS' || roomState === 'RESYNCING' || roomState === 'SEEKING') && (
          <div className="video-overlay">
            <div className="overlay-content">
              {roomState === 'WAITING_FOR_VIEWERS' ? (
                peerEverJoinedRef.current ? (
                  <>
                    <div className="overlay-title">they disconnected, paused until they're back</div>
                    <div className="overlay-sub">send them this link if they need to rejoin:</div>
                    <div className="overlay-url">{roomUrl}</div>
                    <button className="copy-btn-lg" onClick={copyLink}>
                      {copied ? '✓ copied!' : 'copy link'}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="overlay-icon">🎬</div>
                    <div className="overlay-title">waiting for them to show up</div>
                    <div className="overlay-sub">share this link to get them in:</div>
                    <div className="overlay-url">{roomUrl}</div>
                    <button className="copy-btn-lg" onClick={copyLink}>
                      {copied ? '✓ copied!' : 'copy invite link'}
                    </button>
                    <button className="copy-btn preview-btn" onClick={() => {
                      setPreviewMode(true);
                      videoPlayerRef.current?.videoElement?.play();
                    }}>
                      preview
                    </button>
                  </>
                )
              ) : (
                <>
                  <div className="overlay-title">
                    {roomState === 'SEEKING'
                      ? 'jumping to that spot…'
                      : roomState === 'RESYNCING'
                      ? 'getting you both back in sync…'
                      : (() => {
                          const peerLow = peerStatus.bufferedAhead >= 0 && peerStatus.bufferedAhead < 0.5;
                          const stalls = stallCountRef.current;
                          if (peerLow) return stalls >= 2 ? 'their connection is a bit slow, giving them extra time to load' : 'waiting for them to load up 🍿';
                          if (stalls >= 3) return 'slow connection detected, buffering a bit more so it plays smoothly';
                          if (stalls >= 1) return 'had a couple of hiccups, building up a bit more buffer';
                          return 'almost ready…';
                        })()}
                  </div>
                  {roomState === 'BUFFERING' && stallCountRef.current >= 1 && (
                    <div className="overlay-sub" style={{ marginTop: 6 }}>
                      {stallCountRef.current >= 3
                        ? 'the app is waiting for a bigger head start to keep things uninterrupted'
                        : 'it stopped briefly, so we\'re loading a little more ahead before continuing'}
                    </div>
                  )}
                  {peerStatus.bufferedAhead >= 0 && roomState === 'BUFFERING' && (
                    <div className="overlay-buffer-bar">
                      <div
                        className="overlay-buffer-fill"
                        style={{ width: `${Math.min(100, (peerStatus.bufferedAhead / 3) * 100)}%` }}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
