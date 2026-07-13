import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Home } from './pages/Home';
import { Room } from './pages/Room';
import { Setup } from './pages/Setup';
import { Settings } from './pages/Settings';
import { ThemeToggle } from './components/ThemeToggle';

// Hidden on /room/:token — the video player's native controls can span the
// full bottom edge, so no fixed corner is safe there, and a theme toggle
// isn't useful mid-playback anyway.
function ThemeToggleGate() {
  const location = useLocation();
  if (location.pathname.startsWith('/room/')) return null;
  return <ThemeToggle />;
}

export function App() {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then((d: { setupComplete?: boolean }) => setSetupComplete(!!d.setupComplete))
      .catch(() => setSetupComplete(true)); // fail open — don't block on network error
  }, []);

  if (setupComplete === null) return null; // loading

  if (!setupComplete) {
    return (
      <>
        <ThemeToggle />
        <Setup onComplete={() => setSetupComplete(true)} />
      </>
    );
  }

  return (
    <BrowserRouter>
      <ThemeToggleGate />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/room/:token" element={<Room />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
