// PookieFlix logo — play-to-heart scrubber mark + wordmark
// `variant="dark"` (default) is cream-on-dark for the dark theme;
// `variant="light"` is plum/grey-on-light for the light theme.

interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  mark?: boolean;
  variant?: 'dark' | 'light';
}

const SIZES = {
  sm: { mark: [80, 19] as [number, number], wordmark: 22 },
  md: { mark: [110, 26] as [number, number], wordmark: 30 },
  lg: { mark: [160, 38] as [number, number], wordmark: 44 },
};

export function Logo({ size = 'md', mark: showMark = true, variant = 'dark' }: LogoProps) {
  const { mark, wordmark } = SIZES[size];

  const triangle = variant === 'dark' ? '#fff5ef' : '#34203f';
  const playedBar = variant === 'dark' ? '#fff5ef' : '#34203f';
  const buffered = variant === 'dark' ? 'rgba(255,245,239,0.38)' : '#aeaeae';
  const remaining = variant === 'dark' ? 'rgba(255,245,239,0.16)' : '#d9d9d9';
  const pookieColor = variant === 'dark' ? '#ff7fab' : '#e0457f';
  const flixColor = variant === 'dark' ? '#fff5ef' : '#34203f';

  const wordmarkEl = (
    <span style={{ fontFamily: "'Figtree', sans-serif", fontWeight: 900, fontSize: wordmark, letterSpacing: '-0.035em', lineHeight: 1 }}>
      <span style={{ color: pookieColor }}>Pookie</span>
      <span style={{ color: flixColor }}>Flix</span>
    </span>
  );

  if (!showMark) return wordmarkEl;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: size === 'lg' ? 18 : 12 }}>
      <svg width={mark[0]} height={mark[1]} viewBox="0 0 340 80" aria-hidden="true">
        <defs>
          <linearGradient id="pf-heart-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff5d97" />
            <stop offset="1" stopColor="#8a5cff" />
          </linearGradient>
        </defs>
        {/* play triangle */}
        <path d="M14 18 L52 40 L14 62 Z" fill={triangle} />
        {/* played bar */}
        <rect x="70" y="31" width="100" height="18" rx="9" fill={playedBar} />
        {/* heart playhead */}
        <g transform="translate(157,5.9) scale(0.62) rotate(-90 50 55)">
          <path d="M50 86 C 12 58, 17 24, 38 24 C 47 24, 50 31, 50 31 C 50 31, 53 24, 62 24 C 83 24, 88 58, 50 86 Z" fill="url(#pf-heart-g)" />
        </g>
        {/* buffered */}
        <rect x="200" y="36" width="52" height="8" rx="4" fill={buffered} />
        {/* remaining */}
        <rect x="252" y="36" width="76" height="8" rx="4" fill={remaining} />
      </svg>
      {wordmarkEl}
    </div>
  );
}
