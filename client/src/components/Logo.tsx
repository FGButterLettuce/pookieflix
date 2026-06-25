// PookieFlix logo — play-to-heart scrubber mark + wordmark
// Reversed (cream on plum) variant used throughout the dark UI.

interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = {
  sm: { mark: [80, 19] as [number, number], wordmark: 22 },
  md: { mark: [110, 26] as [number, number], wordmark: 30 },
  lg: { mark: [160, 38] as [number, number], wordmark: 44 },
};

export function Logo({ size = 'md' }: LogoProps) {
  const { mark, wordmark } = SIZES[size];
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
        <path d="M14 18 L52 40 L14 62 Z" fill="#fff5ef" />
        {/* played bar */}
        <rect x="70" y="31" width="100" height="18" rx="9" fill="#fff5ef" />
        {/* heart playhead */}
        <g transform="translate(157,5.9) scale(0.62) rotate(-90 50 55)">
          <path d="M50 86 C 12 58, 17 24, 38 24 C 47 24, 50 31, 50 31 C 50 31, 53 24, 62 24 C 83 24, 88 58, 50 86 Z" fill="url(#pf-heart-g)" />
        </g>
        {/* buffered */}
        <rect x="200" y="36" width="52" height="8" rx="4" fill="rgba(255,245,239,0.38)" />
        {/* remaining */}
        <rect x="252" y="36" width="76" height="8" rx="4" fill="rgba(255,245,239,0.16)" />
      </svg>
      <span style={{ fontFamily: "'Figtree', sans-serif", fontWeight: 900, fontSize: wordmark, letterSpacing: '-0.035em', lineHeight: 1 }}>
        <span style={{ color: '#ff7fab' }}>Pookie</span>
        <span style={{ color: '#fff5ef' }}>Flix</span>
      </span>
    </div>
  );
}
