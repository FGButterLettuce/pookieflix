import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Users } from 'lucide-react';
import { clearViewer } from '../lib/viewer';

interface MarathonSummary {
  id: number;
  name: string;
  position: number;
  itemCount: number;
  doneCount: number;
}

export function Marathons() {
  const navigate = useNavigate();
  const [marathons, setMarathons] = useState<MarathonSummary[]>([]);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    fetch('/api/marathons')
      .then(r => {
        if (r.status === 401) { setAuthed(false); return null; }
        setAuthed(true);
        return r.json();
      })
      .then((d: { marathons: MarathonSummary[] } | null) => { if (d) setMarathons(d.marathons); })
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const createMarathon = async (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/marathons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json() as { marathon?: { id: number }; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      navigate(`/marathons/${data.marathon!.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setCreating(false);
    }
  };

  const switchProfile = () => {
    clearViewer();
    navigate('/whos-watching');
  };

  if (authed === false) {
    return (
      <div className="home-root">
        <header className="home-topbar">
          <Link to="/" className="settings-link" title="Back to library"><ArrowLeft /></Link>
        </header>
        <div className="marathons-signed-out">Please sign in to view marathons.</div>
      </div>
    );
  }
  if (authed === null) return null;

  return (
    <div className="home-root">
      <header className="home-topbar">
        <Link to="/" className="settings-link" title="Back to library"><ArrowLeft /></Link>
        <h1 className="marathons-heading">Marathons</h1>
        <button className="settings-link" title="Switch profile" onClick={switchProfile}><Users /></button>
      </header>

      <form className="marathon-new-form" onSubmit={createMarathon}>
        <input
          className="setup-input"
          placeholder="New marathon name"
          value={newName}
          onChange={e => setNewName(e.target.value)}
        />
        <button type="submit" className="primary-btn" disabled={creating || !newName.trim()}>
          <Plus size={16} /> Create
        </button>
      </form>
      {error && <div className="form-error">{error}</div>}

      <div className="marathon-card-grid">
        {marathons.map(m => (
          <Link key={m.id} to={`/marathons/${m.id}`} className="marathon-card">
            <div className="marathon-card-name">{m.name}</div>
            <div className="marathon-card-progress">{m.doneCount}/{m.itemCount} done</div>
          </Link>
        ))}
        {marathons.length === 0 && (
          <div className="marathons-empty">No marathons yet — create one above.</div>
        )}
      </div>
    </div>
  );
}
