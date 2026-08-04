// Same idea as the server's autolink junk-token cleanup, but for display:
// keeps real casing/spacing instead of normalizing to a lowercase match key.
// Cuts the filename at the first release-quality/codec/year token instead of
// stripping tokens throughout, since library filenames put junk after the
// title, never inside it.
const RELEASE_JUNK_RE =
  /^(19|20)\d{2}$|^\d{3,4}p$|^(2160p|4k|bluray|blu-ray|webrip|web-?dl|hdrip|dvdrip|dvdscr|x264|x265|h264|h265|hevc|10bit|8bit|ddp?5?1?|dts|aac\d?|ac3|atmos|remux|proper|repack|extended|remastered|uncut|unrated|yify|yts|directors?cut)$/i;

export function cleanLibraryDisplayName(filename: string): string {
  const withoutExt = filename.replace(/\.[a-z0-9]+$/i, '');
  const segments = withoutExt.split('.').filter(Boolean);
  const titleSegments: string[] = [];
  for (const seg of segments) {
    if (RELEASE_JUNK_RE.test(seg)) break;
    titleSegments.push(seg);
  }
  const words = (titleSegments.length ? titleSegments : segments).join(' ').split(/[\s_-]+/).filter(Boolean);
  return words.map(w => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}
