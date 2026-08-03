export type Viewer = 'user' | 'partner';

const STORAGE_KEY = 'pf_viewer';

export function getViewer(): Viewer | null {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === 'user' || value === 'partner' ? value : null;
}

export function setViewer(viewer: Viewer): void {
  localStorage.setItem(STORAGE_KEY, viewer);
}

export function clearViewer(): void {
  localStorage.removeItem(STORAGE_KEY);
}
