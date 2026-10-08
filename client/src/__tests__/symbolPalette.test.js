import { describe, it, expect } from 'vitest';
import {
  ENTITY_TYPES,
  ENTITY_PAIRS,
  parseTrigger,
  symbolTypeFromPair,
  entityNoteUrl,
  filterEntityNotes,
} from '../components/editor/symbolPalette.js';

describe('symbolPalette', () => {
  it('has exactly six fixed entity types', () => {
    expect(ENTITY_TYPES).toHaveLength(6);
    expect(ENTITY_PAIRS).toEqual(['!!', '@@', '&&', '$$', '^^', '++']);
  });

  it('parseTrigger identifies each of the six symbol pairs', () => {
    const all = [
      ['!!', '!'], ['@@', '@'], ['&&', '&'],
      ['$$', '$'], ['^^', '^'], ['++', '+'],
    ];
    for (const [pair, sym] of all) {
      const r = parseTrigger(pair);
      expect(r).not.toBeNull();
      expect(r.type.symbol).toBe(sym);
      expect(r.query).toBe('');
      expect(r.pairIndex).toBe(0);
    }
  });

  it('parseTrigger extracts the typed name as query', () => {
    expect(parseTrigger('&&Borg').query).toBe('Borg');
    expect(parseTrigger('Meet @@Loc').type.symbol).toBe('@');
    expect(parseTrigger('Meet @@Loc').query).toBe('Loc');
    expect(parseTrigger('Meet @@Loc').pairIndex).toBe(5);
  });

  it('does not trigger on mid-word symbols (c++ guard)', () => {
    expect(parseTrigger('c++ is fun')).toBeNull();
    expect(parseTrigger('foo&&bar')).toBeNull();
    expect(parseTrigger('abc')).toBeNull();
    expect(parseTrigger('')).toBeNull();
  });

  it('symbolTypeFromPair returns null for non-trigger text', () => {
    expect(symbolTypeFromPair('hello')).toBeNull();
    expect(symbolTypeFromPair('&&')).not.toBeNull();
  });

  it('entityNoteUrl encodes the symbol', () => {
    expect(entityNoteUrl('&')).toBe('/api/entity-types/%26/notes');
    expect(entityNoteUrl('$')).toBe('/api/entity-types/%24/notes');
  });

  describe('filterEntityNotes', () => {
    const notes = ['Borg the Black', 'Ragnar', 'Aria'];
    it('returns all when query is empty', () => {
      expect(filterEntityNotes(notes, '')).toEqual(notes);
    });
    it('filters case-insensitively', () => {
      expect(filterEntityNotes(notes, 'borg')).toEqual(['Borg the Black']);
      expect(filterEntityNotes(notes, 'BOR')).toEqual(['Borg the Black']);
    });
    it('returns empty when no match', () => {
      expect(filterEntityNotes(notes, 'zzz')).toEqual([]);
    });
  });
});
