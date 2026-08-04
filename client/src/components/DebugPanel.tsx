import { useEffect, useRef, useState } from 'react';
import { X, Trash2 } from 'lucide-react';

interface LogEntry {
  ts: number;
  device: string;
  level: string;
  msg: string;
}

interface Props {
  onClose: () => void;
}

const SEVERITY_LABEL: Record<string, string> = { warn: 'MEDIUM', error: 'HIGH' };
const SEVERITY_COLOR: Record<string, string> = { warn: '#fb923c', error: '#f87171' };

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function DebugPanel({ onClose }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource('/api/debug/logs/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      if (ev.data === 'clear') { setEntries([]); return; }
      try {
        const e = JSON.parse(ev.data) as LogEntry;
        if (e.level !== 'warn' && e.level !== 'error') return;
        setEntries(prev => [...prev.slice(-199), e]);
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const clearLogs = () => {
    void fetch('/api/debug/logs', { method: 'DELETE' });
  };

  return (
    <div className="debug-panel">
      <div className="debug-panel-header">
        <span className="debug-panel-title">
          errors &amp; warnings
          <span className={`debug-panel-status ${connected ? 'debug-panel-status--live' : ''}`}>
            {connected ? 'live' : 'connecting…'}
          </span>
        </span>
        <div className="debug-panel-actions">
          <button className="debug-panel-icon-btn" onClick={clearLogs} title="Clear all logs">
            <Trash2 size={14} />
          </button>
          <button className="debug-panel-icon-btn" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="debug-panel-list" ref={listRef}>
        {entries.length === 0 ? (
          <div className="debug-panel-empty">no errors or warnings yet</div>
        ) : (
          entries.map((e, i) => (
            <div className="debug-entry" key={i}>
              <div className="debug-entry-meta">
                <span className="debug-entry-severity" style={{ color: SEVERITY_COLOR[e.level] }}>
                  {SEVERITY_LABEL[e.level] ?? e.level.toUpperCase()}
                </span>
                <span className="debug-entry-device">{e.device}</span>
                <span className="debug-entry-time">{fmtTime(e.ts)}</span>
              </div>
              <div className="debug-entry-msg">{e.msg}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
