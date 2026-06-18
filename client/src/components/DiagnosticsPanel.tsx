import type { DiagnosticsData } from '../types';

interface Props {
  data: DiagnosticsData;
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

const READY_LABELS = ['EMPTY', 'METADATA', 'CURRENT', 'FUTURE', 'ENOUGH'];
function readyLabel(rs: number): string {
  return `${rs} ${READY_LABELS[rs] ?? '?'}`;
}

function statusColor(status: DiagnosticsData['wsStatus']): string {
  switch (status) {
    case 'open': return '#4ade80';
    case 'connecting': return '#facc15';
    default: return '#f87171';
  }
}

export function DiagnosticsPanel({ data }: Props) {
  return (
    <div style={{
      position: 'fixed',
      bottom: 8,
      right: 8,
      background: 'rgba(0,0,0,0.85)',
      color: '#e2e8f0',
      padding: '10px 14px',
      borderRadius: 8,
      fontFamily: 'monospace',
      fontSize: 11,
      lineHeight: 1.7,
      zIndex: 9999,
      minWidth: 200,
      border: '1px solid rgba(255,255,255,0.1)',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4, color: '#94a3b8', letterSpacing: '0.05em' }}>
        DIAGNOSTICS {data.isHost ? '(host)' : '(viewer)'}
      </div>
      <div>room: <b style={{ color: roomStateColor(data.roomState) }}>{data.roomState}</b></div>
      <div>viewers: {data.viewerCount}/2</div>
      <div>time: {fmt(data.mediaTime, 2)}s</div>
      <div>buffer (own): <b style={{ color: data.ownBufferedAhead < 2 ? '#f87171' : '#4ade80' }}>
        {fmt(data.ownBufferedAhead)}s
      </b></div>
      <div>buffer (peer): <b style={{ color: data.peerBufferedAhead < 2 ? '#f87171' : '#4ade80' }}>
        {data.peerBufferedAhead >= 0 ? `${fmt(data.peerBufferedAhead)}s` : '—'}
      </b></div>
      <div>drift: <b style={{ color: Math.abs(data.drift) > 0.25 ? '#facc15' : '#4ade80' }}>
        {fmt(data.drift, 3)}s
      </b></div>
      <div>rate: {fmt(data.playbackRate, 2)}x</div>
      <div>ready: <b style={{ color: data.readyState < 3 ? '#f87171' : '#4ade80' }}>{readyLabel(data.readyState)}</b></div>
      <div>waiting: <b style={{ color: data.waiting ? '#f87171' : '#4ade80' }}>{data.waiting ? 'yes' : 'no'}</b></div>
      <div>srvCmd: <b style={{ color: data.serverCmdPending ? '#facc15' : '#94a3b8' }}>{data.serverCmdPending ? 'pending' : 'idle'}</b></div>
      <div>ws: <b style={{ color: statusColor(data.wsStatus) }}>{data.wsStatus}</b></div>
      <div>hls: <b style={{ color: data.usingHLS ? '#4ade80' : '#94a3b8' }}>{data.usingHLS ? 'yes' : 'no'}</b></div>
    </div>
  );
}

function roomStateColor(state: DiagnosticsData['roomState']): string {
  switch (state) {
    case 'PLAYING': return '#4ade80';
    case 'BUFFERING': return '#facc15';
    case 'USER_PAUSED': return '#94a3b8';
    case 'WAITING_FOR_VIEWERS': return '#60a5fa';
    case 'SEEKING':
    case 'RESYNCING': return '#fb923c';
    case 'ENDED': return '#a78bfa';
    default: return '#e2e8f0';
  }
}
