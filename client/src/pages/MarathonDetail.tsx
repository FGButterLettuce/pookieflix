import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowUp, ArrowDown, Plus, Trash2, Users } from 'lucide-react';
import { getViewer, clearViewer, type Viewer } from '../lib/viewer';

type Status = 'pending' | 'done' | 'skipped';

interface Review {
  viewer: Viewer;
  score: number | null;
  note: string | null;
}

interface Item {
  id: number;
  position: number;
  title: string;
  libraryFilename: string | null;
  status: Status;
  reviews: Review[];
}

interface LibraryFile {
  filename: string;
}

const STATUS_LABEL: Record<Status, string> = {
  pending: 'Pending',
  done: 'Done',
  skipped: 'Skipped',
};

export function MarathonDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const viewer = getViewer();

  const [name, setName] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [libraryFiles, setLibraryFiles] = useState<LibraryFile[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [newLibraryFilename, setNewLibraryFilename] = useState('');
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [draftScore, setDraftScore] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    fetch(`/api/marathons/${id}`)
      .then(r => {
        if (r.status === 401) { setAuthed(false); return null; }
        setAuthed(true);
        return r.json();
      })
      .then((d: { name: string; items: Item[] } | null) => {
        if (d) { setName(d.name); setItems(d.items); }
      })
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!viewer) { navigate('/whos-watching'); return; }
    load();
    fetch('/api/library')
      .then(r => r.json())
      .then((d: { files: LibraryFile[] }) => setLibraryFiles(d.files))
      .catch(() => {});
  }, [load, viewer, navigate]);

  const addItem = async (e: FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setError('');
    try {
      const res = await fetch(`/api/marathons/${id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, libraryFilename: newLibraryFilename || null }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setNewTitle('');
      setNewLibraryFilename('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const setStatus = async (itemId: number, status: Status) => {
    await fetch(`/api/marathons/${id}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    load();
  };

  const move = async (itemId: number, direction: 'up' | 'down') => {
    await fetch(`/api/marathons/${id}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ move: direction }),
    });
    load();
  };

  const deleteItem = async (itemId: number) => {
    if (!window.confirm('Remove this item from the marathon?')) return;
    await fetch(`/api/marathons/${id}/items/${itemId}`, { method: 'DELETE' });
    load();
  };

  const deleteMarathon = async () => {
    if (!window.confirm(`Delete "${name}" and all its items and reviews?`)) return;
    await fetch(`/api/marathons/${id}`, { method: 'DELETE' });
    navigate('/marathons');
  };

  const playLinkedFile = async (filename: string) => {
    setError('');
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });
      const data = await res.json() as { roomToken?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to start room');
      navigate(`/room/${data.roomToken!}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start room');
    }
  };

  const startEditingReview = (item: Item) => {
    const mine = item.reviews.find(r => r.viewer === viewer);
    setEditingItemId(item.id);
    setDraftScore(mine?.score != null ? String(mine.score) : '');
    setDraftNote(mine?.note ?? '');
  };

  const isLinkedFileAvailable = (filename: string) => libraryFiles.some(f => f.filename === filename);

  const saveReview = async (itemId: number) => {
    if (!viewer) return;
    const score = draftScore.trim() ? Number(draftScore) : null;
    if (score !== null && (!Number.isInteger(score) || score < 1 || score > 10)) {
      setError('Score must be a whole number from 1 to 10');
      return;
    }
    setError('');
    await fetch(`/api/marathons/${id}/items/${itemId}/review`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer, score, note: draftNote.trim() || null }),
    });
    setEditingItemId(null);
    load();
  };

  const switchProfile = () => {
    clearViewer();
    navigate('/whos-watching');
  };

  if (authed === false) {
    return (
      <div className="home-root">
        <header className="home-topbar">
          <Link to="/marathons" className="settings-link" title="Back to marathons"><ArrowLeft /></Link>
        </header>
        <div className="marathons-signed-out">Please sign in to view this marathon.</div>
      </div>
    );
  }
  if (authed === null || !viewer) return null;

  return (
    <div className="home-root">
      <header className="home-topbar">
        <Link to="/marathons" className="settings-link" title="Back to marathons"><ArrowLeft /></Link>
        <h1 className="marathons-heading">{name}</h1>
        <button className="settings-link" title="Switch profile" onClick={switchProfile}><Users /></button>
        <button className="settings-link" title="Delete marathon" onClick={deleteMarathon}><Trash2 /></button>
      </header>

      {error && <div className="form-error">{error}</div>}

      <ul className="marathon-item-list">
        {items.map((item, index) => (
          <li key={item.id} className="marathon-item-row">
            <div className="marathon-item-move">
              <button disabled={index === 0} onClick={() => move(item.id, 'up')} title="Move up"><ArrowUp size={14} /></button>
              <button disabled={index === items.length - 1} onClick={() => move(item.id, 'down')} title="Move down"><ArrowDown size={14} /></button>
            </div>

            <div className="marathon-item-main">
              {item.libraryFilename && isLinkedFileAvailable(item.libraryFilename) ? (
                <button
                  type="button"
                  className="marathon-item-title marathon-item-title-linked"
                  onClick={() => playLinkedFile(item.libraryFilename!)}
                >
                  {item.title}
                </button>
              ) : (
                <span className="marathon-item-title">{item.title}</span>
              )}

              <div className="marathon-item-scores">
                {(['user', 'partner'] as Viewer[]).map(v => {
                  const r = item.reviews.find(rv => rv.viewer === v);
                  return (
                    <span key={v} className="marathon-item-score">
                      {v === 'user' ? 'U' : 'P'}: {r?.score != null ? `${r.score}/10` : '—'}
                    </span>
                  );
                })}
              </div>
            </div>

            <select
              className="marathon-status-select"
              value={item.status}
              onChange={e => setStatus(item.id, e.target.value as Status)}
            >
              <option value="pending">{STATUS_LABEL.pending}</option>
              <option value="done">{STATUS_LABEL.done}</option>
              <option value="skipped">{STATUS_LABEL.skipped}</option>
            </select>

            <button className="settings-link" title="Rate" onClick={() => startEditingReview(item)}>Review</button>
            <button className="settings-link" title="Delete item" onClick={() => deleteItem(item.id)}><Trash2 size={14} /></button>

            {editingItemId === item.id && (
              <div className="marathon-review-editor">
                <input
                  className="setup-input"
                  type="number"
                  min={1}
                  max={10}
                  placeholder="Score (1-10)"
                  value={draftScore}
                  onChange={e => setDraftScore(e.target.value)}
                />
                <input
                  className="setup-input"
                  placeholder="Note (optional)"
                  value={draftNote}
                  onChange={e => setDraftNote(e.target.value)}
                />
                <button className="primary-btn" onClick={() => saveReview(item.id)}>Save</button>
                <button className="settings-link" onClick={() => setEditingItemId(null)}>Cancel</button>
              </div>
            )}
          </li>
        ))}
        {items.length === 0 && <li className="marathons-empty">No items yet — add one below.</li>}
      </ul>

      <form className="marathon-new-form" onSubmit={addItem}>
        <input
          className="setup-input"
          placeholder="Movie title"
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
        />
        <select
          className="marathon-status-select"
          value={newLibraryFilename}
          onChange={e => setNewLibraryFilename(e.target.value)}
        >
          <option value="">Not in library</option>
          {libraryFiles.map(f => (
            <option key={f.filename} value={f.filename}>{f.filename}</option>
          ))}
        </select>
        <button type="submit" className="primary-btn" disabled={!newTitle.trim()}>
          <Plus size={16} /> Add
        </button>
      </form>
    </div>
  );
}
