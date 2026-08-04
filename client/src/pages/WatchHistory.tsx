import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, X } from 'lucide-react';
import { clearViewer } from '../lib/viewer';

interface SessionStats {
  count: number;
  firstAt: string | null;
  lastAt: string | null;
}

interface HistoryEntry {
  id: number;
  title: string;
  detectedAt: string;
  addedTo: MarathonSummary[];
  sessions: SessionStats;
}

interface MarathonSummary {
  id: number;
  name: string;
}

const NEW_LIST_VALUE = '__new__';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// "Watched" here means a synced room was actually started for the file —
// sessions are logged going forward only (the log is durable, unlike the
// short-lived rooms table, but it didn't exist before this shipped), so
// count 0 just means "before we started counting," not "never watched."
function formatSessions(s: SessionStats): string {
  if (s.count === 0) return 'No playback recorded yet';
  if (s.count === 1) return `Watched once, ${formatDate(s.firstAt!)}`;
  return `Watched ${s.count}×, ${formatDate(s.firstAt!)} – ${formatDate(s.lastAt!)}`;
}

export function WatchHistory() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [marathons, setMarathons] = useState<MarathonSummary[]>([]);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [addingId, setAddingId] = useState<number | null>(null);
  const [addName, setAddName] = useState('Watched');
  const [creatingNew, setCreatingNew] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dismissingId, setDismissingId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    fetch('/api/history')
      .then(r => {
        if (r.status === 401) { setAuthed(false); return null; }
        setAuthed(true);
        return r.json();
      })
      .then((d: { entries: HistoryEntry[] } | null) => { if (d) setEntries(d.entries); })
      .catch(() => {});
  }, []);

  // Re-scanning is idempotent (already-recorded and dismissed entries are
  // never re-added) so it's safe to kick off on every visit to this page —
  // it just picks up anything newly orphaned since the last visit.
  useEffect(() => {
    fetch('/api/history/scan', { method: 'POST' }).catch(() => {}).finally(load);
  }, [load]);

  useEffect(() => {
    fetch('/api/marathons')
      .then(r => r.ok ? r.json() : null)
      .then((d: { marathons: MarathonSummary[] } | null) => { if (d) setMarathons(d.marathons); })
      .catch(() => {});
  }, []);

  const switchProfile = () => {
    clearViewer();
    navigate('/whos-watching');
  };

  const openAdd = (entry: HistoryEntry) => {
    setError('');
    setAddingId(entry.id);
    if (marathons.length > 0) {
      setCreatingNew(false);
      setAddName(marathons[0].name);
    } else {
      setCreatingNew(true);
      setAddName('Watched');
    }
  };

  const cancelAdd = () => setAddingId(null);

  const submitAdd = async (e: FormEvent, entryId: number) => {
    e.preventDefault();
    const marathonName = addName.trim();
    if (!marathonName) return;
    setAdding(true);
    setError('');
    try {
      const res = await fetch(`/api/history/${entryId}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marathonName }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to add to list');
      // History is a permanent record — promoting is additive (playlist-
      // style), the entry stays put. Reload from the server so the "added
      // to" badge reflects the real state rather than guessing locally.
      setAddingId(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add to list');
    } finally {
      setAdding(false);
    }
  };

  const dismiss = async (entryId: number) => {
    setDismissingId(entryId);
    setError('');
    try {
      const res = await fetch(`/api/history/${entryId}`, { method: 'DELETE' });
      if (!res.ok) {
        // Never fail silently — same res.ok-check pattern as linkAutolink in
        // Home.tsx (Task 9): keep the row up so the user can see the
        // dismiss didn't take instead of optimistically removing it anyway.
        setError('Failed to dismiss');
        return;
      }
      setEntries(prev => prev.filter(e => e.id !== entryId));
    } catch {
      setError('Failed to dismiss');
    } finally {
      setDismissingId(null);
    }
  };

  if (authed === false) {
    return (
      <div className="home-root">
        <header className="home-topbar">
          <Link to="/" className="settings-link" title="Back to home"><ArrowLeft /></Link>
        </header>
        <div className="marathons-signed-out">Please sign in to view watch history.</div>
      </div>
    );
  }
  if (authed === null) return null;

  return (
    <div className="home-root">
      <header className="home-topbar">
        <Link to="/" className="settings-link" title="Back to home"><ArrowLeft /></Link>
        <h1 className="marathons-heading">Watch History</h1>
        <button className="settings-link" title="Switch profile" onClick={switchProfile}><Users /></button>
      </header>

      <div className="marathons-page-body">
        {error && <div className="form-error">{error}</div>}

        <div className="history-list">
          {entries.map(entry => (
            <div className="history-card" key={entry.id}>
              <div className="history-card-info">
                <div className="history-card-title">{entry.title}</div>
                <div className="history-card-date">{formatSessions(entry.sessions)}</div>
                <div className="history-card-date history-card-removed">Removed from library {formatDate(entry.detectedAt)}</div>
                {entry.addedTo.length > 0 && (
                  <div className="history-added-badges">
                    {entry.addedTo.map(m => (
                      <span className="history-added-badge" key={m.id}>In {m.name}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="history-card-actions">
                {addingId === entry.id ? (
                  <form className="history-add-form" onSubmit={e => submitAdd(e, entry.id)}>
                    {creatingNew || marathons.length === 0 ? (
                      <input
                        className="setup-input"
                        value={addName}
                        autoFocus
                        onChange={e => setAddName(e.target.value)}
                        placeholder="New list name"
                      />
                    ) : (
                      <select
                        className="setup-input"
                        value={addName}
                        autoFocus
                        onChange={e => {
                          if (e.target.value === NEW_LIST_VALUE) { setCreatingNew(true); setAddName('Watched'); }
                          else setAddName(e.target.value);
                        }}
                      >
                        {marathons.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                        <option value={NEW_LIST_VALUE}>+ New list…</option>
                      </select>
                    )}
                    <button type="submit" className="primary-btn" disabled={adding || !addName.trim()}>
                      {adding ? 'Adding…' : 'Add'}
                    </button>
                    <button type="button" className="link-btn" onClick={cancelAdd}>Cancel</button>
                  </form>
                ) : (
                  <button className="link-btn" onClick={() => openAdd(entry)}>+ Add to a list</button>
                )}
                <button
                  className="settings-link"
                  title="Dismiss"
                  onClick={() => dismiss(entry.id)}
                  disabled={dismissingId === entry.id}
                >
                  <X />
                </button>
              </div>
            </div>
          ))}
          {entries.length === 0 && (
            <div className="marathons-empty">
              Nothing here yet — this fills in automatically from movies you've watched and removed from your library.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
