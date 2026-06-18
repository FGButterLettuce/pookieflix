import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Home } from './pages/Home';
import { Room } from './pages/Room';
import { Setup } from './pages/Setup';
import { Settings } from './pages/Settings';

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
    return <Setup onComplete={() => setSetupComplete(true)} />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/room/:token" element={<Room />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
