import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { setViewer, type Viewer } from '../lib/viewer';

interface Names {
  USER_NAME: string;
  PARTNER_NAME: string;
}

export function WhosWatching() {
  const navigate = useNavigate();
  const [names, setNames] = useState<Names | null>(null);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((d: { USER_NAME?: string; PARTNER_NAME?: string }) => {
        setNames({
          USER_NAME: d.USER_NAME?.trim() || 'Person 1',
          PARTNER_NAME: d.PARTNER_NAME?.trim() || 'Person 2',
        });
      })
      .catch(() => setNames({ USER_NAME: 'Person 1', PARTNER_NAME: 'Person 2' }));
  }, []);

  const choose = (viewer: Viewer) => {
    setViewer(viewer);
    navigate('/');
  };

  if (!names) return null;

  return (
    <div className="whos-watching-root">
      <h1 className="whos-watching-title">Who's watching?</h1>
      <div className="whos-watching-tiles">
        <button className="profile-tile" onClick={() => choose('user')}>
          <span className="profile-avatar">{names.USER_NAME.charAt(0).toUpperCase()}</span>
          <span className="profile-name">{names.USER_NAME}</span>
        </button>
        <button className="profile-tile" onClick={() => choose('partner')}>
          <span className="profile-avatar">{names.PARTNER_NAME.charAt(0).toUpperCase()}</span>
          <span className="profile-name">{names.PARTNER_NAME}</span>
        </button>
      </div>
    </div>
  );
}
