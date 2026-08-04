// PookieFlix logo — the heart mark, matching public/favicon.svg exactly.
// Previously an elaborate play-bar-to-heart scrubber illustration plus a
// wordmark; simplified to just the heart everywhere, smaller and easier on
// the eyes than the full mark+wordmark treatment.

interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = { sm: 24, md: 32, lg: 48 };

export function Logo({ size = 'md' }: LogoProps) {
  const px = SIZES[size];
  return (
    <svg width={px} height={px} viewBox="25 20 72 80" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="PookieFlix">
      <path
        d="M58.7236 27.9914C70.0663 33.904 85.4923 49.7216 93.7095 58.6664C94.1275 59.1307 94.3589 59.7339 94.3589 60.3593C94.3589 60.9848 94.1275 61.588 93.7095 62.0523C85.4923 71.0476 70.0663 86.8652 58.7236 92.7778C33.7696 105.765 17.1336 73.0185 42.0876 60.3846C17.1336 47.7507 33.7696 15.0038 58.7236 27.9914Z"
        fill="#E04580"
      />
    </svg>
  );
}
