import { useTheme } from '../theme/ThemeContext';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-toggle-wrap">
      <div className="theme-toggle-pill">
        <button
          className={`theme-toggle-btn${theme === 'light' ? ' active' : ''}`}
          onClick={() => setTheme('light')}
          aria-label="Light theme"
          aria-pressed={theme === 'light'}
        >
          ☀️
        </button>
        <button
          className={`theme-toggle-btn${theme === 'dark' ? ' active' : ''}`}
          onClick={() => setTheme('dark')}
          aria-label="Dark theme"
          aria-pressed={theme === 'dark'}
        >
          🌙
        </button>
      </div>
    </div>
  );
}
