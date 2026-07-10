import type { RoomState } from '../types';

interface Props {
  state: RoomState;
  viewerCount: number;
}

const STATE_LABELS: Record<RoomState, string> = {
  WAITING_FOR_VIEWERS: 'Waiting for the other viewer…',
  READY_CHECK: 'Both viewers connected, buffering…',
  PLAYING: 'Playing',
  USER_PAUSED: 'Paused',
  BUFFERING: 'Buffering, waiting for both viewers…',
  SEEKING: 'Seeking, syncing…',
  RESYNCING: 'Re-syncing…',
  ENDED: 'Video ended',
};

const STATE_COLORS: Record<RoomState, string> = {
  WAITING_FOR_VIEWERS: '#60a5fa',
  READY_CHECK: '#facc15',
  PLAYING: '#4ade80',
  USER_PAUSED: '#94a3b8',
  BUFFERING: '#fb923c',
  SEEKING: '#fb923c',
  RESYNCING: '#fb923c',
  ENDED: '#a78bfa',
};

export function RoomStatus({ state, viewerCount }: Props) {
  const isTransient = ['BUFFERING', 'SEEKING', 'RESYNCING', 'WAITING_FOR_VIEWERS', 'READY_CHECK'].includes(state);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 12px',
      borderRadius: 20,
      background: 'rgba(0,0,0,0.6)',
      border: `1px solid ${STATE_COLORS[state]}40`,
      backdropFilter: 'blur(8px)',
    }}>
      {isTransient && (
        <span style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: STATE_COLORS[state],
          animation: 'pulse 1.2s ease-in-out infinite',
        }} />
      )}
      <span style={{ color: STATE_COLORS[state], fontSize: 13, fontWeight: 500 }}>
        {STATE_LABELS[state]}
      </span>
      <span style={{ color: '#475569', fontSize: 12 }}>
        {viewerCount}/2
      </span>
    </div>
  );
}
