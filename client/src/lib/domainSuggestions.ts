export interface DomainSuggestion {
  domain: string;
  featured?: boolean;
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function generateDomainSuggestions(userName: string, partnerName: string): DomainSuggestion[] {
  const you = slug(userName) || 'you';
  const pookie = slug(partnerName) || 'pookie';
  const blend = `${you}${pookie}`;

  const candidates: DomainSuggestion[] = [
    { domain: `${blend}.com` },
    { domain: `our.movienight.app`, featured: true },
    { domain: `${blend}watch.xyz` },
    { domain: `watch.with${pookie}.com` },
    { domain: `${blend}.app` },
    { domain: `${you}and${pookie}.com` },
    { domain: `our.together.app` },
    { domain: `${pookie}and${you}watch.xyz` },
  ];

  const seen = new Set<string>();
  return candidates.filter(s => {
    if (seen.has(s.domain)) return false;
    seen.add(s.domain);
    return true;
  });
}
