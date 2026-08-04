import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Users, Trash2, Plus, Pencil, GripVertical, ChevronDown, Search, Film, RotateCcw,
  Check, MoreVertical, Play, Archive, ImagePlus, ArrowUp, ArrowDown, LayoutGrid, Rows3,
} from 'lucide-react';
import { getViewer, clearViewer, type Viewer } from '../lib/viewer';
import { cleanLibraryDisplayName } from '../lib/cleanFilename';
import type { LibraryFile, TmdbCandidate } from '../types';
import { EditableText } from '../components/EditableText';

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
  posterPath: string | null;
  tmdbId: number | null;
}


// Same red -> green language everywhere a score shows up: chat bubbles, the
// slider's fill + big readout number. Only ever computes the 0-100 position;
// CSS resolves the actual color via color-mix() against the app's real
// --danger/--success tokens. Ported verbatim from the mockup's scoreColorMix.
function scoreColorMix(value: number): string {
  const pct = (((value - 1) / 9) * 100).toFixed(1);
  return `color-mix(in oklch, var(--success) ${pct}%, var(--danger))`;
}

const SPRING_FACTOR = 0.14;
const SPRING_THRESHOLD = 0.02;

/**
 * Spring-follow readout: the returned value continuously eases toward
 * `target` on its own requestAnimationFrame loop (the technique behind
 * Framer Motion's useSpring for a live-changing target) — smooth at any
 * drag speed because it's decoupled from how often the slider fires input
 * events. Ported from the mockup's tick()/paintReadout() loop: same lerp
 * factor (0.14) and settle threshold (0.02).
 */
function useSpringValue(target: number): number {
  const [displayed, setDisplayed] = useState(target);
  const displayedRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (reduceMotion) {
      displayedRef.current = target;
      setDisplayed(target);
      return;
    }
    const tick = () => {
      const delta = target - displayedRef.current;
      if (Math.abs(delta) < SPRING_THRESHOLD) {
        displayedRef.current = target;
        setDisplayed(target);
        rafRef.current = null;
        return;
      }
      displayedRef.current += delta * SPRING_FACTOR;
      setDisplayed(displayedRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [target]);

  return displayed;
}

// Clips to the parent's width and, only when the cleaned name still doesn't
// fit, scrolls it into view on hover — never wraps/overflows past the tile.
function MarqueeText({ text }: { text: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowPx, setOverflowPx] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    const el = textRef.current;
    if (!container || !el) return;
    const overflow = el.scrollWidth - container.clientWidth;
    setOverflowPx(overflow > 0 ? overflow : 0);
  }, [text]);

  return (
    <div className="marquee-text" ref={containerRef}>
      <span
        ref={textRef}
        className={overflowPx > 0 ? 'is-overflowing' : undefined}
        style={overflowPx > 0 ? ({ '--marquee-distance': `${overflowPx}px` } as CSSProperties) : undefined}
      >
        {text}
      </span>
    </div>
  );
}

const STATUS_HINT_UNLINKED = 'Not in your library — tracked title only';
const STATUS_HINT_MISSING = 'Linked file no longer available';

export function MarathonDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const viewer = getViewer();

  const [name, setName] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [libraryFiles, setLibraryFiles] = useState<LibraryFile[]>([]);
  const [names, setNames] = useState({ user: 'Person 1', partner: 'Person 2' });
  const [newTitle, setNewTitle] = useState('');
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [expandedItemIds, setExpandedItemIds] = useState<Set<number>>(new Set());
  const [openMenuItemId, setOpenMenuItemId] = useState<number | null>(null);
  const [thumbErrorIds, setThumbErrorIds] = useState<Set<number>>(new Set());
  // Big banner cards make sense for browsing/reviewing, but they're
  // unwieldy to drag-reorder — a compact row mode is much easier to
  // reorder many items in. Remembered across visits, not per-list.
  const [viewMode, setViewMode] = useState<'cards' | 'list'>(
    () => (localStorage.getItem('pookieflix-list-view-mode') === 'list' ? 'list' : 'cards')
  );
  useEffect(() => { localStorage.setItem('pookieflix-list-view-mode', viewMode); }, [viewMode]);
  const [librarySearch, setLibrarySearch] = useState('');
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [draggedItemId, setDraggedItemId] = useState<number | null>(null);
  const [dragOverItemId, setDragOverItemId] = useState<number | null>(null);
  const [error, setError] = useState('');

  // TMDB poster picker — offered automatically right after a manually-tracked
  // (no library file) item is created, and re-offerable any time afterward
  // via the item's "Add poster" control for anything still posterless.
  const [posterSearchingId, setPosterSearchingId] = useState<number | null>(null);
  const [posterPickerItemId, setPosterPickerItemId] = useState<number | null>(null);
  const [posterCandidates, setPosterCandidates] = useState<TmdbCandidate[]>([]);
  const [settingPoster, setSettingPoster] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/marathons/${id}`)
      .then(r => {
        if (r.status === 401) { setAuthed(false); return null; }
        if (!r.ok) { setAuthed(true); setNotFound(true); return null; }
        setAuthed(true);
        setNotFound(false);
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
    fetch('/api/settings')
      .then(r => r.json())
      .then((d: { USER_NAME?: string; PARTNER_NAME?: string }) => {
        setNames({
          user: d.USER_NAME?.trim() || 'Person 1',
          partner: d.PARTNER_NAME?.trim() || 'Person 2',
        });
      })
      .catch(() => {});
  }, [load, viewer, navigate]);

  const isLinkedFileAvailable = (filename: string) => libraryFiles.some(f => f.filename === filename);
  const libraryFileFor = (filename: string | null) => (filename ? libraryFiles.find(f => f.filename === filename) : undefined);

  const renameMarathon = async (nextName: string) => {
    await fetch(`/api/marathons/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nextName }),
    });
    load();
  };

  const renameItem = async (itemId: number, nextTitle: string) => {
    await fetch(`/api/marathons/${id}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: nextTitle }),
    });
    load();
  };

  const addFromLibrary = async (filename: string) => {
    setError('');
    try {
      const title = cleanLibraryDisplayName(filename);
      const res = await fetch(`/api/marathons/${id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, libraryFilename: filename }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const addManualItem = async (e: FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setError('');
    try {
      const res = await fetch(`/api/marathons/${id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, libraryFilename: null }),
      });
      const data = await res.json() as { item?: { id: number }; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setNewTitle('');
      load();
      if (data.item) void searchAndOfferPoster(data.item.id, title);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  // Looks up TMDB for the given title and, if any candidates with a poster
  // come back, opens the picker for itemId. TMDB being unconfigured (503),
  // a bad/empty response, or a network error are all treated the same way —
  // silently do nothing, matching "gracefully hidden when unconfigured"
  // rather than surfacing an error for what's an optional nicety.
  const searchAndOfferPoster = async (itemId: number, title: string) => {
    setPosterSearchingId(itemId);
    try {
      const res = await fetch(`/api/tmdb/search?query=${encodeURIComponent(title)}`);
      if (!res.ok) return;
      const data = await res.json() as { results: TmdbCandidate[] };
      const withPosters = (data.results ?? []).filter(r => r.posterPath);
      if (withPosters.length > 0) {
        setPosterCandidates(withPosters);
        setPosterPickerItemId(itemId);
      }
    } catch {
      // ignore — poster search is a nicety, never block or error the add flow
    } finally {
      setPosterSearchingId(null);
    }
  };

  const selectPoster = async (itemId: number, candidate: TmdbCandidate) => {
    setSettingPoster(true);
    try {
      await fetch(`/api/marathons/${id}/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posterPath: candidate.posterPath, tmdbId: candidate.tmdbId }),
      });
      setPosterPickerItemId(null);
      setPosterCandidates([]);
      load();
    } catch {
      setError('Failed to set poster');
    } finally {
      setSettingPoster(false);
    }
  };

  const skipPoster = () => {
    setPosterPickerItemId(null);
    setPosterCandidates([]);
  };

  // Backfills a poster (and, only if the title was never actually renamed
  // away from its raw-filename default, a real title) for every
  // library-linked item that doesn't have one yet — runs once per item as
  // soon as items load, no button required. Silent/auto-applied rather
  // than picker-confirmed like manual adds: these are movies already in
  // the library, not an ambiguous filename match, so there's no
  // misattribution risk the way there is with autolink's review data.
  const enrichedItemIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const item of items) {
      if (!item.libraryFilename || item.posterPath || enrichedItemIdsRef.current.has(item.id)) continue;
      enrichedItemIdsRef.current.add(item.id);
      void enrichLibraryItem(item);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const enrichLibraryItem = async (item: Item) => {
    const cleanedTitle = cleanLibraryDisplayName(item.libraryFilename!);
    try {
      const res = await fetch(`/api/tmdb/search?query=${encodeURIComponent(cleanedTitle)}`);
      if (!res.ok) return;
      const data = await res.json() as { results: TmdbCandidate[] };
      const top = (data.results ?? []).find(r => r.posterPath);
      if (!top) return;
      const rawDefaultTitle = item.libraryFilename!.replace(/\.[^./]+$/, '');
      const titleNeverRenamed = item.title === rawDefaultTitle || item.title === cleanedTitle;
      await fetch(`/api/marathons/${id}/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          posterPath: top.posterPath,
          tmdbId: top.tmdbId,
          ...(titleNeverRenamed ? { title: top.title } : {}),
        }),
      });
      load();
    } catch {
      // Silent — this is a cosmetic nicety, never block or error the page over it.
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

  const deleteItem = async (itemId: number) => {
    if (!window.confirm('Remove this item from the list?')) return;
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

  const saveReview = async (itemId: number, score: number, note: string) => {
    if (!viewer) return;
    setError('');
    try {
      const res = await fetch(`/api/marathons/${id}/items/${itemId}/review`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer, score, note: note.trim() || null }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to save review');
      setEditingItemId(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save review');
    }
  };

  // Close the item overflow menu on any click outside it — a native <select>
  // or dropdown would get this for free; our custom `.dropdown-menu` needs
  // it wired up explicitly or it's stuck open until another menu is opened.
  useEffect(() => {
    if (openMenuItemId === null) return;
    const handleClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('.item-menu-wrap')) {
        setOpenMenuItemId(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [openMenuItemId]);

  const toggleReviews = (itemId: number) => {
    setExpandedItemIds(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  };

  const switchProfile = () => {
    clearViewer();
    navigate('/whos-watching');
  };

  // ── Drag-and-drop reorder — native HTML5, no library. draggable lives
  // only on the grip handle so it doesn't intercept pointer-drag on the
  // score slider. On drop, PATCH the server with the target's index and let
  // the reloaded list be the source of truth (no local reorder + trust). ──
  const handleDragStart = (e: DragEvent, itemId: number) => {
    // Firefox won't initiate an HTML5 drag at all unless dataTransfer.setData
    // is called from dragstart — Chrome/Safari are more lenient about this,
    // which is how the omission went unnoticed.
    e.dataTransfer.setData('text/plain', String(itemId));
    setDraggedItemId(itemId);
  };
  const handleDragEnd = () => { setDraggedItemId(null); setDragOverItemId(null); };
  const handleDragOver = (e: DragEvent, itemId: number) => {
    e.preventDefault();
    if (itemId !== draggedItemId) setDragOverItemId(itemId);
  };
  const handleDragLeave = (itemId: number) => {
    setDragOverItemId(prev => (prev === itemId ? null : prev));
  };
  const handleDrop = async (e: DragEvent, targetItemId: number) => {
    e.preventDefault();
    setDragOverItemId(null);
    const dragged = draggedItemId;
    setDraggedItemId(null);
    if (dragged == null || dragged === targetItemId) return;
    const targetIndex = items.findIndex(i => i.id === targetItemId);
    if (targetIndex === -1) return;
    await fetch(`/api/marathons/${id}/items/${dragged}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: targetIndex }),
    });
    load();
  };

  // Fallback reorder path for touch and keyboard users — HTML5 drag-and-drop
  // (above) doesn't work on iOS Safari / Android Chrome, and the grip handle
  // has no keyboard handler either. Calls the server's existing {move}
  // PATCH branch and moveMarathonItem in db.ts, both already in place and
  // tested from before this branch's drag-and-drop rework, just unused
  // until now.
  const moveItem = async (itemId: number, direction: 'up' | 'down') => {
    await fetch(`/api/marathons/${id}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ move: direction }),
    });
    load();
  };

  if (authed === false) {
    return (
      <div className="home-root">
        <header className="home-topbar">
          <Link to="/marathons" className="settings-link" title="Back to lists"><ArrowLeft /></Link>
        </header>
        <div className="marathons-signed-out">Please sign in to view this list.</div>
      </div>
    );
  }
  if (notFound) {
    return (
      <div className="home-root">
        <header className="home-topbar">
          <Link to="/marathons" className="settings-link" title="Back to lists"><ArrowLeft /></Link>
        </header>
        <div className="marathons-signed-out">This list doesn't exist or was deleted. <Link to="/marathons">Back to lists</Link></div>
      </div>
    );
  }
  if (authed === null || !viewer) return null;

  const filteredLibrary = librarySearch.trim()
    ? libraryFiles.filter(f => f.filename.toLowerCase().includes(librarySearch.trim().toLowerCase()))
    : libraryFiles;

  return (
    <div className="home-root">
      <header className="home-topbar">
        <Link to="/marathons" className="settings-link" title="Back to lists"><ArrowLeft /></Link>
        <EditableText
          value={name}
          onSave={renameMarathon}
          className="marathons-heading editable"
          icon={<Pencil className="pencil" size={16} />}
        />
        <button className="settings-link" title="Switch profile" onClick={switchProfile}><Users /></button>
        <button className="settings-link" title="Delete list" onClick={deleteMarathon}><Trash2 /></button>
      </header>

      <div className="marathons-page-body">
        {error && <div className="form-error">{error}</div>}

        {items.length > 0 && (
          <div className="view-mode-toggle" role="group" aria-label="Item view">
            <button
              type="button"
              className={viewMode === 'cards' ? 'active' : ''}
              title="Card view"
              onClick={() => setViewMode('cards')}
            >
              <LayoutGrid size={15} /> Cards
            </button>
            <button
              type="button"
              className={viewMode === 'list' ? 'active' : ''}
              title="List view — easier to drag and reorder"
              onClick={() => setViewMode('list')}
            >
              <Rows3 size={15} /> List
            </button>
          </div>
        )}

        <div className={viewMode === 'list' ? 'items items-compact' : 'items'}>
          {items.map((item, index) => {
            const libraryFile = libraryFileFor(item.libraryFilename);
            const playable = !!item.libraryFilename && isLinkedFileAvailable(item.libraryFilename);
            // Prefer the TMDB poster — it's the app's primary image
            // everywhere else now (library grid, Continue Watching, the
            // library-tile picker); the frame-grab is only a stand-in
            // until a poster's been found.
            const posterSrc = item.posterPath ? `https://image.tmdb.org/t/p/w342${item.posterPath}` : null;
            const thumbSrc = !posterSrc && libraryFile?.thumbReady && !thumbErrorIds.has(item.id)
              ? `${libraryFile.thumbUrl}?v=${libraryFile.lastPlayedAt}`
              : null;
            const expanded = expandedItemIds.has(item.id);
            const mine = item.reviews.find(r => r.viewer === viewer);
            const isDragging = draggedItemId === item.id;
            const isDragOver = dragOverItemId === item.id && draggedItemId !== item.id;

            if (viewMode === 'list') {
              return (
                <div
                  key={item.id}
                  className={'item-row-compact' + (isDragging ? ' dragging' : '') + (isDragOver ? ' drag-over' : '')}
                  onDragOver={e => handleDragOver(e, item.id)}
                  onDragLeave={() => handleDragLeave(item.id)}
                  onDrop={e => handleDrop(e, item.id)}
                >
                  <button
                    className="drag-handle"
                    draggable
                    title="Drag to reorder"
                    aria-label="Drag to reorder"
                    onDragStart={e => handleDragStart(e, item.id)}
                    onDragEnd={handleDragEnd}
                  >
                    <GripVertical />
                  </button>
                  <div className="item-row-compact-thumb">
                    {thumbSrc ? (
                      <img src={thumbSrc} alt="" onError={() => setThumbErrorIds(s => new Set([...s, item.id]))} />
                    ) : posterSrc ? (
                      <img src={posterSrc} alt="" />
                    ) : (
                      <Film size={16} />
                    )}
                  </div>
                  <EditableText
                    value={item.title}
                    onSave={next => renameItem(item.id, next)}
                    className="item-title item-row-compact-title"
                  />
                  {item.status === 'pending' ? (
                    <button className="btn-done compact" onClick={() => setStatus(item.id, 'done')}>
                      <Check size={14} /> Watch
                    </button>
                  ) : (
                    <button
                      className={'status-badge compact' + (item.status === 'done' ? ' done' : ' skipped')}
                      onClick={() => setStatus(item.id, 'pending')}
                      title="Mark as not done"
                    >
                      {item.status === 'done' ? <><Check size={14} /> Done</> : 'Skipped'}
                    </button>
                  )}
                  <div className="item-menu-wrap">
                    <button
                      className="settings-link"
                      title="More"
                      onClick={() => setOpenMenuItemId(id => (id === item.id ? null : item.id))}
                    >
                      <MoreVertical />
                    </button>
                    {openMenuItemId === item.id && (
                      <div className="dropdown-menu open">
                        <button
                          className="dropdown-item"
                          disabled={index === 0}
                          onClick={() => { setOpenMenuItemId(null); void moveItem(item.id, 'up'); }}
                        >
                          <ArrowUp /> Move up
                        </button>
                        <button
                          className="dropdown-item"
                          disabled={index === items.length - 1}
                          onClick={() => { setOpenMenuItemId(null); void moveItem(item.id, 'down'); }}
                        >
                          <ArrowDown /> Move down
                        </button>
                        {item.status !== 'skipped' && (
                          <button className="dropdown-item" onClick={() => { setOpenMenuItemId(null); setStatus(item.id, 'skipped'); }}>
                            <Archive /> Skip
                          </button>
                        )}
                        <button className="dropdown-item danger" onClick={() => { setOpenMenuItemId(null); deleteItem(item.id); }}>
                          <Trash2 /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            return (
              <div
                key={item.id}
                className={'item-card' + (isDragging ? ' dragging' : '') + (isDragOver ? ' drag-over' : '')}
                onDragOver={e => handleDragOver(e, item.id)}
                onDragLeave={() => handleDragLeave(item.id)}
                onDrop={e => handleDrop(e, item.id)}
              >
                <div
                  className={'item-thumb' + (!playable && !posterSrc ? ' no-file' : '')}
                  onClick={playable ? () => playLinkedFile(item.libraryFilename!) : undefined}
                  onKeyDown={playable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playLinkedFile(item.libraryFilename!); } } : undefined}
                  role={playable ? 'button' : undefined}
                  tabIndex={playable ? 0 : undefined}
                  aria-label={playable ? `Play ${item.title}` : undefined}
                  style={playable ? { cursor: 'pointer' } : undefined}
                >
                  {thumbSrc ? (
                    <img src={thumbSrc} alt="" onError={() => setThumbErrorIds(s => new Set([...s, item.id]))} />
                  ) : posterSrc ? (
                    <img src={posterSrc} alt="" />
                  ) : playable ? (
                    <>
                      <div className="placeholder-texture" />
                      <div className="placeholder-watermark"><Film /></div>
                    </>
                  ) : (
                    <Film />
                  )}
                  {playable && <div className="play-badge"><Play fill="currentColor" /></div>}
                </div>

                <div className="item-body">
                  <div className="item-row">
                    <button
                      className="drag-handle"
                      draggable
                      title="Drag to reorder"
                      aria-label="Drag to reorder"
                      onDragStart={e => handleDragStart(e, item.id)}
                      onDragEnd={handleDragEnd}
                    >
                      <GripVertical />
                    </button>
                    <div className="item-main">
                      <EditableText
                        value={item.title}
                        onSave={next => renameItem(item.id, next)}
                        className="item-title"
                      />
                      {!item.libraryFilename && <div className="item-hint">{STATUS_HINT_UNLINKED}</div>}
                      {item.libraryFilename && !playable && <div className="item-hint">{STATUS_HINT_MISSING}</div>}
                      {!item.posterPath && posterPickerItemId === item.id && (
                        <div className="poster-picker">
                          <div className="poster-picker-title">Choose a poster</div>
                          <div className="poster-picker-strip">
                            {posterCandidates.map(c => (
                              <button
                                key={c.tmdbId}
                                type="button"
                                className="poster-candidate"
                                title={c.year ? `${c.title} (${c.year})` : c.title}
                                disabled={settingPoster}
                                onClick={() => selectPoster(item.id, c)}
                              >
                                <img src={`https://image.tmdb.org/t/p/w185${c.posterPath}`} alt="" />
                              </button>
                            ))}
                          </div>
                          <button type="button" className="link-btn poster-picker-skip" onClick={skipPoster}>Skip</button>
                        </div>
                      )}
                      {!item.posterPath && posterPickerItemId !== item.id && (
                        <button
                          className="add-poster-btn"
                          title="Search TMDB for a poster"
                          disabled={posterSearchingId === item.id}
                          onClick={() => searchAndOfferPoster(item.id, item.libraryFilename ? cleanLibraryDisplayName(item.libraryFilename) : item.title)}
                        >
                          <ImagePlus /> {posterSearchingId === item.id ? 'Searching…' : 'Add poster'}
                        </button>
                      )}
                    </div>
                    <div className="status-group">
                      {item.status === 'done' && (
                        <>
                          <span className="status-badge done"><Check size={16} /> Done</span>
                          <button className="settings-link" title="Mark as not done" onClick={() => setStatus(item.id, 'pending')}><RotateCcw /></button>
                        </>
                      )}
                      {item.status === 'skipped' && (
                        <>
                          <span className="status-badge skipped">Skipped</span>
                          <button className="settings-link" title="Mark as not done" onClick={() => setStatus(item.id, 'pending')}><RotateCcw /></button>
                        </>
                      )}
                      {item.status === 'pending' && (
                        <button className="btn-done" onClick={() => setStatus(item.id, 'done')}><Check size={16} /> Done</button>
                      )}
                      <div className="item-menu-wrap">
                        <button
                          className="settings-link"
                          title="More"
                          onClick={() => setOpenMenuItemId(id => (id === item.id ? null : item.id))}
                        >
                          <MoreVertical />
                        </button>
                        {openMenuItemId === item.id && (
                          <div className="dropdown-menu open">
                            <button
                              className="dropdown-item"
                              disabled={index === 0}
                              onClick={() => { setOpenMenuItemId(null); void moveItem(item.id, 'up'); }}
                            >
                              <ArrowUp /> Move up
                            </button>
                            <button
                              className="dropdown-item"
                              disabled={index === items.length - 1}
                              onClick={() => { setOpenMenuItemId(null); void moveItem(item.id, 'down'); }}
                            >
                              <ArrowDown /> Move down
                            </button>
                            {item.status !== 'skipped' && (
                              <button className="dropdown-item" onClick={() => { setOpenMenuItemId(null); setStatus(item.id, 'skipped'); }}>
                                <Archive /> Skip
                              </button>
                            )}
                            <button className="dropdown-item danger" onClick={() => { setOpenMenuItemId(null); deleteItem(item.id); }}>
                              <Trash2 /> Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {item.reviews.length > 0 && (
                    <>
                      <button
                        className="reviews-toggle"
                        aria-expanded={expanded}
                        onClick={() => toggleReviews(item.id)}
                      >
                        <span>Reviews ({item.reviews.length})</span>
                        <span className="reviews-toggle-right">
                          <span className="ring-avatars">
                            {item.reviews.map(r => (
                              <span
                                key={r.viewer}
                                className="ring-avatar"
                                style={{ '--ring': r.score != null ? scoreColorMix(r.score) : 'var(--border)' } as CSSProperties}
                              >
                                {names[r.viewer].charAt(0).toUpperCase()}
                              </span>
                            ))}
                          </span>
                          <ChevronDown />
                        </span>
                      </button>
                      <div className={'reviews-panel' + (expanded ? ' open' : '')}>
                        <div className="reviews-thread">
                          {item.reviews.map(r => (
                            <div key={r.viewer} className={'review-msg' + (r.viewer === 'partner' ? ' from-partner' : '')}>
                              <span className="review-avatar">{names[r.viewer].charAt(0).toUpperCase()}</span>
                              <div
                                className="review-bubble"
                                style={{ '--rule-color': r.score != null ? scoreColorMix(r.score) : 'var(--text-subtle)' } as CSSProperties}
                              >
                                {r.score != null && (
                                  <div className="review-meta">
                                    <span className="review-score-num" style={{ color: scoreColorMix(r.score) }}>{r.score}</span>
                                  </div>
                                )}
                                <blockquote className={'review-note-text' + (r.note ? '' : ' empty')}>
                                  {r.note || 'No note'}
                                </blockquote>
                              </div>
                            </div>
                          ))}
                        </div>
                        {editingItemId !== item.id && (
                          <div className="add-review-prompt">
                            <button className="link-btn" onClick={() => setEditingItemId(item.id)}>
                              {mine ? 'Edit your review' : '+ Add your review'}
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {(item.reviews.length === 0 || editingItemId === item.id) && (
                    <ReviewEditor
                      key={item.id}
                      initialScore={mine?.score != null ? mine.score : 5.5}
                      initialNote={mine?.note ?? ''}
                      onSave={(score, note) => saveReview(item.id, score, note)}
                      onCancel={() => setEditingItemId(null)}
                      showCancel={item.reviews.length > 0}
                    />
                  )}
                </div>
              </div>
            );
          })}
          {items.length === 0 && <div className="marathons-empty">No items yet — add one below.</div>}
        </div>

        <div className="add-section">
          <div className="add-section-title">Add from your library</div>
          <div className="library-search">
            <Search />
            <input
              placeholder="Search your library…"
              value={librarySearch}
              onChange={e => setLibrarySearch(e.target.value)}
            />
          </div>
          <div className="library-strip">
            {filteredLibrary.map(f => {
              const alreadyAdded = items.some(i => i.libraryFilename === f.filename);
              const displayName = cleanLibraryDisplayName(f.filename);
              return (
                <button
                  key={f.filename}
                  type="button"
                  className={'library-tile' + (alreadyAdded ? ' already-added' : '')}
                  onClick={alreadyAdded ? undefined : () => addFromLibrary(f.filename)}
                  disabled={alreadyAdded}
                >
                  <div className="library-tile-thumb">
                    {f.posterPath || f.thumbReady ? (
                      <img src={f.posterPath ? `https://image.tmdb.org/t/p/w185${f.posterPath}` : `${f.thumbUrl}?v=${f.lastPlayedAt}`} alt="" />
                    ) : (
                      <Film />
                    )}
                    {!alreadyAdded && <div className="add-badge"><Plus /></div>}
                  </div>
                  {alreadyAdded && <span className="already-added-badge">In list</span>}
                  <div className="library-tile-name"><MarqueeText text={displayName} /></div>
                </button>
              );
            })}
            {filteredLibrary.length === 0 && <div className="item-hint">No matches in your library.</div>}
          </div>

          <div className="add-manual-toggle">
            <button className="link-btn" onClick={() => setShowManualAdd(s => !s)}>
              + Track a movie you don't have — watched elsewhere, or coming soon
            </button>
          </div>
          {showManualAdd && (
            <form className="add-item-row" onSubmit={addManualItem}>
              <input
                className="setup-input"
                placeholder="Movie title — e.g. 'The Incredible Hulk'"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
              />
              <button type="submit" className="primary-btn" disabled={!newTitle.trim()}>
                <Plus size={16} /> Add
              </button>
            </form>
          )}
        </div>
        <div className="caption">
          Tap a movie from your library to add it — its thumbnail and playback carry over automatically.
          Titles you don't have get tracked without a file link. Either way: deleting the file later never
          deletes the list entry or your reviews — those stay saved here for good.
        </div>
      </div>
    </div>
  );
}

interface ReviewEditorProps {
  initialScore: number;
  initialNote: string;
  onSave: (score: number, note: string) => void;
  onCancel: () => void;
  showCancel: boolean;
}

// Owns its own score/note draft state (initialized from the item's existing
// review, if any) rather than being controlled by the parent — each item's
// editor (there can be several mounted at once, one per not-yet-reviewed
// item) needs its own independent draft, not one shared across the page.
function ReviewEditor({ initialScore, initialNote, onSave, onCancel, showCancel }: ReviewEditorProps) {
  const [score, setScore] = useState(initialScore);
  const [note, setNote] = useState(initialNote);
  const displayed = useSpringValue(score);
  const settled = Math.abs(score - displayed) < SPRING_THRESHOLD;
  const shown = settled ? score : displayed;
  const shownText = settled && shown % 1 === 0 ? String(shown) : shown.toFixed(1);
  const shownColor = scoreColorMix(shown);
  const trackPct = (((score - 1) / 9) * 100).toFixed(1);
  const trackMix = scoreColorMix(score);

  return (
    <div className="review-editor">
      <div className="score-slider-wrap">
        <div className="score-field-label">Your score</div>
        <div className="score-slider-value" style={{ color: shownColor }}>{shownText}</div>
        <input
          type="range"
          className="score-slider"
          min={1}
          max={10}
          step={0.5}
          value={score}
          onChange={e => setScore(Number(e.target.value))}
          style={{ background: `linear-gradient(to right, ${trackMix} 0%, ${trackMix} ${trackPct}%, var(--surface3) ${trackPct}%, var(--surface3) 100%)` }}
        />
        <div className="score-slider-ticks"><span>1</span><span>10</span></div>
      </div>
      <div className="review-editor-row">
        <input
          className="note-input"
          placeholder="Note (optional)"
          value={note}
          onChange={e => setNote(e.target.value)}
        />
        <button className="btn-save" onClick={() => onSave(score, note)}>Save</button>
        {showCancel && <button className="btn-cancel" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
