import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateDomainSuggestions } from './domainSuggestions';

describe('generateDomainSuggestions', () => {
  it('produces a non-empty list of unique domains from two names', () => {
    const result = generateDomainSuggestions('Niranjan', 'Anu');
    assert.ok(result.length >= 6);
    const domains = result.map(s => s.domain);
    assert.equal(new Set(domains).size, domains.length, 'domains must be unique');
  });

  it('lowercases and strips non-alphanumeric characters from names', () => {
    const result = generateDomainSuggestions("Niran-jan!", "Anu 2");
    const domains = result.map(s => s.domain);
    assert.ok(domains.some(d => d.startsWith('niranjananu')), `expected a blend domain, got: ${domains.join(', ')}`);
  });

  it('falls back to generic placeholders when names are blank', () => {
    const result = generateDomainSuggestions('', '');
    assert.ok(result.length >= 6);
    for (const s of result) {
      assert.ok(!s.domain.includes('undefined'));
    }
  });

  it('marks exactly one suggestion as featured', () => {
    const result = generateDomainSuggestions('Niranjan', 'Anu');
    assert.equal(result.filter(s => s.featured).length, 1);
  });

  it('every domain ends in a recognized TLD', () => {
    const result = generateDomainSuggestions('Niranjan', 'Anu');
    for (const s of result) {
      assert.match(s.domain, /\.(com|app|xyz)$/);
    }
  });
});
