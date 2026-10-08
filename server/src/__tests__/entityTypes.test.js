import { describe, it, expect } from 'vitest';
import {
  ENTITY_TYPES,
  ENTITY_SYMBOLS,
  bySymbol,
  byName,
  linkRegex,
  seedNotebookName,
  SEED_NOTEBOOK_NAMES,
  entityPath,
  safeEntityName,
  defaultTemplate,
} from '../entityTypes.js';

describe('registry shape', () => {
  it('has exactly six fixed types with lock-ordened symbols', () => {
    expect(ENTITY_TYPES).toHaveLength(6);
    expect(ENTITY_TYPES.map(t => t.symbol)).toEqual(['!', '@', '&', '$', '^', '+']);
    // # and * must never appear (tag / bold collisions).
    expect(ENTITY_SYMBOLS.has('#')).toBe(false);
    expect(ENTITY_SYMBOLS.has('*')).toBe(false);
  });

  it('each entry has a name, label, and a plural label', () => {
    for (const t of ENTITY_TYPES) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.label).toBe('string');
      expect(typeof t.labelPlural).toBe('string');
      expect(t.labelPlural.length).toBeGreaterThan(0);
    }
  });
});

describe('bySymbol', () => {
  it('resolves a known symbol to its entry', () => {
    const npc = bySymbol('&');
    expect(npc.name).toBe('npc');
    expect(npc.label).toBe('NPC');
    expect(npc.labelPlural).toBe('NPCs');
  });

  it('returns undefined for an unknown symbol', () => {
    expect(bySymbol('#')).toBeUndefined();
    expect(bySymbol('z')).toBeUndefined();
    expect(bySymbol(undefined)).toBeUndefined();
  });
});

describe('byName', () => {
  it('resolves a known name', () => {
    expect(byName('npc').symbol).toBe('&');
    expect(byName('event').symbol).toBe('!');
  });
  it('returns undefined for an unknown name', () => {
    expect(byName('monster')).toBeUndefined();
  });
});

describe('linkRegex', () => {
  it('matches the doubled-symbol link and captures the display name', () => {
    const re = linkRegex('&');
    const m = re.exec('met &&Borg the Black&& near the gate');
    expect(m[1]).toBe('Borg the Black');
  });

  it('works for the + symbol (escapes + correctly)', () => {
    const re = linkRegex('+');
    const m = re.exec('+Aria+ is plain but ++Aria++ is a link');
    expect(m[1]).toBe('Aria');
  });

  it('stops at the same-symbol char (no bleed into a next link)', () => {
    const re = linkRegex('&');
    const m = re.exec('&&First&& then &&Second&&');
    expect(m[1]).toBe('First');
  });

  it('throws for an unknown symbol', () => {
    expect(() => linkRegex('#')).toThrow();
  });
});

describe('seedNotebookName / SEED_NOTEBOOK_NAMES', () => {
  it('returns label + s', () => {
    expect(seedNotebookName('NPC')).toBe('NPCs');
    expect(seedNotebookName('Event')).toBe('Events');
  });

  it('exposes the full six-name protected set', () => {
    expect([...SEED_NOTEBOOK_NAMES].sort()).toEqual(
      ['Events', 'Locations', 'NPCs', 'Items', 'Traps', 'Players'].sort(),
    );
  });
});

describe('entityPath', () => {
  it('builds entities/<name>/<safeName>.md from a registry entry', () => {
    expect(entityPath(byName('npc'), 'Borg the Black')).toBe('entities/npc/Borg the Black.md');
    expect(entityPath(byName('event'), 'Council Summit')).toBe('entities/event/Council Summit.md');
  });

  it('builds the path from a name string', () => {
    expect(entityPath('trap', 'Dart Trap')).toBe('entities/trap/Dart Trap.md');
  });
});

describe('safeEntityName', () => {
  it('keeps safe display names verbatim (case + spaces untouched)', () => {
    expect(safeEntityName('Borg the Black')).toBe('Borg the Black');
    expect(safeEntityName('  Trim Me  ')).toBe('Trim Me');
  });

  it('rejects names with forbidden filename chars (returns empty)', () => {
    expect(['a/b', 'a\\b', 'a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b'].every(bad => safeEntityName(bad) === '')).toBe(true);
    expect(safeEntityName('bad\0name')).toBe('');
  });

  it('rejects non-strings and empties', () => {
    expect(safeEntityName('')).toBe('');
    expect(safeEntityName(null)).toBe('');
    expect(safeEntityName(42)).toBe('');
  });

  it('caps length at 200', () => {
    const long = 'a'.repeat(500);
    expect(safeEntityName(long)).toHaveLength(200);
  });
});

describe('defaultTemplate', () => {
  it('returns the lock-ordened starter template body per type', () => {
    const npc = defaultTemplate('npc');
    expect(npc).toContain('## Description');
    expect(npc).toContain('## Events');
    expect(npc).toContain('!!Event!!');
  });

  it('resolves by symbol too', () => {
    expect(defaultTemplate(null, '!')).toContain('## Prerequisites');
    expect(defaultTemplate(null, '@')).toContain('## Parent location');
    expect(defaultTemplate(null, '+')).toContain('## Backstory');
  });

  it('returns null for an unknown type', () => {
    expect(defaultTemplate('monster')).toBeNull();
    expect(defaultTemplate(null, '#')).toBeNull();
  });
});
