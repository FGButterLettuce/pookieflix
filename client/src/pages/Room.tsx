import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { VideoPlayer } from '../components/VideoPlayer';
import { RoomStatus } from '../components/RoomStatus';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel';
import { WsClient } from '../lib/wsClient';
import { rlog } from '../lib/remoteLogger';
import type { VideoController } from '../lib/videoController';
import type {
  RoomState,
  PeerStatus,
  DiagnosticsData,
  ServerMessage,
} from '../types';
import type { WsStatus } from '../lib/wsClient';

const IS_DEV = true; // always show diagnostics for now
const HEARTBEAT_INTERVAL = 500;

interface RoomInfo {
  viewerId: string;
  isHost: boolean;
  roomState: RoomState;
  viewerCount: number;
  mediaUrl: string;
  mediaFilename: string;
  subtitleUrl?: string;
}

export function Room() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [roomState, setRoomState] = useState<RoomState>('WAITING_FOR_VIEWERS');
  const [viewerCount, setViewerCount] = useState(0);
  const setWsStatus = (status: WsStatus) => {
    diagnosticsRef.current = { ...diagnosticsRef.current, wsStatus: status };
  };
  const [peerStatus, setPeerStatus] = useState<PeerStatus>({ bufferedAhead: -1, mediaTime: 0, seeking: false, waiting: false });
  const [copied, setCopied] = useState(false);
  const [fatalError, setFatalError] = useState('');

  const vcRef = useRef<VideoController | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const diagnosticsRef = useRef<DiagnosticsData>({
    ownBufferedAhead: 0,
    peerBufferedAhead: -1,
    drift: 0,
    roomState: 'WAITING_FOR_VIEWERS',
    wsStatus: 'connecting',
    viewerCount: 0,
    playbackRate: 1,
    mediaTime: 0,
    isHost: false,
    readyState: 0,
    waiting: false,
    serverCmdPending: false,
  });
  const [diagnostics, setDiagnostics] = useState<DiagnosticsData>(diagnosticsRef.current);

  // ── WebSocket setup ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!token) { navigate('/'); return; }

    const ws = new WsClient(token);
    wsRef.current = ws;

    ws.onStatus(status => {
      setWsStatus(status);
      diagnosticsRef.current = { ...diagnosticsRef.current, wsStatus: status };
    });

    ws.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case 'JOINED': {
          rlog.log(`JOINED host=${msg.isHost} state=${msg.roomState} subs=${!!msg.subtitleUrl}`);
          setRoomInfo({
            viewerId: msg.viewerId,
            isHost: msg.isHost,
            roomState: msg.roomState,
            viewerCount: 1,
            mediaUrl: msg.mediaUrl,
            mediaFilename: msg.mediaFilename,
            subtitleUrl: msg.subtitleUrl,
          });
          setRoomState(msg.roomState);
          diagnosticsRef.current = { ...diagnosticsRef.current, isHost: msg.isHost };
          break;
        }

        case 'ROOM_UPDATE': {
          rlog.log(`ROOM_UPDATE state=${msg.state} viewers=${msg.viewerCount}`);
          setRoomState(msg.state);
          setViewerCount(msg.viewerCount);
          diagnosticsRef.current = {
            ...diagnosticsRef.current,
            roomState: msg.state,
            viewerCount: msg.viewerCount,
          };
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
          diagnosticsRef.current = {
            ...diagnosticsRef.current,
            peerBufferedAhead: msg.bufferedAhead,
          };
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

      // Update diagnostics
      const peer = peerStatusRef.current;
      const drift = peer.mediaTime > 0 ? hb.mediaTime - peer.mediaTime : 0;
      diagnosticsRef.current = {
        ...diagnosticsRef.current,
        ownBufferedAhead: hb.bufferedAhead,
        drift,
        playbackRate: hb.playbackRate,
        mediaTime: hb.mediaTime,
        readyState: hb.readyState,
        waiting: hb.waiting,
        serverCmdPending: hb.serverCommandPending,
      };
      setDiagnostics({ ...diagnosticsRef.current });
    }, HEARTBEAT_INTERVAL);
  }, []);

  // ── VideoController ready ──────────────────────────────────────────────────

  const handleControllerReady = useCallback((vc: VideoController) => {
    vcRef.current = vc;
    startHeartbeat();
    vc.on((event) => {
      if (event === 'error') {
        setFatalError('This browser cannot play the video — the codec may not be supported (e.g. H.265/HEVC). Try a different browser or ask the host to re-encode to H.264.');
      }
    });
  }, [startHeartbeat]);

  // ── User action callbacks ──────────────────────────────────────────────────

  const handleUserPlay = useCallback(() => {
    wsRef.current?.send({ type: 'USER_ACTION', data: { action: 'PLAY' } });
  }, []);

  const handleUserPause = useCallback(() => {
    wsRef.current?.send({ type: 'USER_ACTION', data: { action: 'PAUSE' } });
  }, []);

  const handleUserSeek = useCallback((time: number) => {
    wsRef.current?.send({ type: 'USER_ACTION', data: { action: 'SEEK', mediaTime: time } });
  }, []);

  // ── Peer status ref (avoid closure stale value in heartbeat) ───────────────
  const peerStatusRef = useRef(peerStatus);
  useEffect(() => { peerStatusRef.current = peerStatus; }, [peerStatus]);

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
        <span className="room-title">{roomInfo.mediaFilename}</span>
        <RoomStatus state={roomState} viewerCount={viewerCount || roomInfo.viewerCount} />
        <button
          className="copy-btn"
          onClick={copyLink}
          title="Copy invite link"
        >
          {copied ? '✓ Copied!' : '⎘ Copy link'}
        </button>
      </div>

      <div className="room-player">
        <VideoPlayer
          src={roomInfo.mediaUrl}
          subtitleUrl={roomInfo.subtitleUrl}
          onControllerReady={handleControllerReady}
          onUserPlay={handleUserPlay}
          onUserPause={handleUserPause}
          onUserSeek={handleUserSeek}
        />

        {(roomState === 'BUFFERING' || roomState === 'WAITING_FOR_VIEWERS' || roomState === 'RESYNCING' || roomState === 'SEEKING') && (
          <div className="video-overlay">
            <div className="overlay-content">
              {roomState === 'WAITING_FOR_VIEWERS' ? (
                <>
                  <div className="overlay-icon">⏳</div>
                  <div className="overlay-title">Waiting for the other viewer</div>
                  <div className="overlay-sub">Share this link:</div>
                  <div className="overlay-url">{roomUrl}</div>
                  <button className="copy-btn-lg" onClick={copyLink}>
                    {copied ? '✓ Copied!' : 'Copy invite link'}
                  </button>
                </>
              ) : (
                <>
                  <div className="spinner" />
                  <div className="overlay-title">
                    {roomState === 'BUFFERING' ? 'Buffering…' : 'Syncing…'}
                  </div>
                  {peerStatus.bufferedAhead >= 0 && (
                    <div className="overlay-sub">
                      Peer buffer: {peerStatus.bufferedAhead.toFixed(1)}s
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {IS_DEV && <DiagnosticsPanel data={diagnostics} />}
    </div>
  );
}
