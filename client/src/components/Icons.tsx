// A small hand-drawn icon set, all sharing one geometry (24x24, round caps/joins,
// 1.75 stroke) so the library card's actions read as one system instead of the
// mismatched emoji glyphs (⏸⏹▶↻🗑) it used before. currentColor throughout —
// callers set colour via CSS `color`.

interface IconProps {
  size?: number;
}

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function PlayIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M7 4.5v15l13-7.5-13-7.5z" />
    </svg>
  );
}

export function PauseIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M8 5v14M16 5v14" />
    </svg>
  );
}

export function StopIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}

export function RestartIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M20 11a8 8 0 1 0-2.34 5.66" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

export function HistoryIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M4 11a8 8 0 1 1 2.34 5.66" />
      <path d="M4 17v-6h6" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}

export function SubtitlesIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M7 10.5h4M7 14h7M14 10.5h3" />
    </svg>
  );
}

export function TrashIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M5 7h14" />
      <path d="M9 7V5.2c0-.66.54-1.2 1.2-1.2h3.6c.66 0 1.2.54 1.2 1.2V7" />
      <path d="M7 7l.8 12.2c.05.99.87 1.8 1.86 1.8h4.68c.99 0 1.8-.8 1.86-1.8L17 7" />
      <path d="M10.2 11v6M13.8 11v6" />
    </svg>
  );
}

export function MoreIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SettingsIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13.5a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V19.5a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H4.5a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H10.5a1.65 1.65 0 0 0 1-1.51V4.5a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V10.5a1.65 1.65 0 0 0 1.51 1H19.5a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function UploadIcon({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 16.5v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

export function CheckIcon({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M4.5 12.5l5 5L19.5 7" />
    </svg>
  );
}

export function FilmIcon({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9h18M3 15h18M8 4v5M8 15v5M16 4v5M16 15v5" />
    </svg>
  );
}
