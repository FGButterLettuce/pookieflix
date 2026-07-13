export type Theme = 'light' | 'dark';

export function resolveInitialTheme(storedValue: string | null, systemPrefersDark: boolean): Theme {
  if (storedValue === 'light' || storedValue === 'dark') return storedValue;
  return systemPrefersDark ? 'dark' : 'light';
}
