// Seed per-user data for a user: the six seed entity notebooks (Q3) and the six
// per-user entity template rows (Q1). Idempotent — safe to call twice.
//
// Called from:
//  - auth.js register (1.8) — so a fresh user has the six notebooks + templates
//    as soon as they sign in.
//  - routes/entityTypes.js POST /:symbol (1.5) — on demand, so pre-existing
//    users (registered before Phase 1) get their seed data on first entity
//    create rather than a middleware hook (Q9).
//
// No middleware, no first-request hook, no runMigrations() loop (Q9).
import { getDb } from '../db/index.js';
import { ENTITY_TYPES, seedNotebookName, defaultTemplate, byName } from '../entityTypes.js';

// Six notebook names in registry order:
//   Events, Locations, NPCs, Items, Traps, Players
const SEED_NOTEBOOK_NAMES = ENTITY_TYPES.map(t => seedNotebookName(t.label));

export function ensureSeedData(userId) {
  const db = getDb();
  const tx = db.transaction((uid) => {
    // (a) Six seed notebooks — UNIQUE(user_id, name) gives us free idempotency.
    const insertN = db.prepare(
      'INSERT OR IGNORE INTO notebooks (user_id, name) VALUES (?, ?)'
    );
    for (const name of SEED_NOTEBOOK_NAMES) insertN.run(uid, name);

    // (b) Six template rows — schema-enforced by
    //     idx_templates_user_entity UNIQUE(user_id, entity_symbol) (Q9). The
    //     guarded existence check avoids the UNIQUE collision on a straight
    //     INSERT.
    const check = db.prepare('SELECT 1 FROM templates WHERE user_id = ? AND entity_symbol = ?');
    const ins = db.prepare(
      'INSERT INTO templates (user_id, name, content, entity_symbol) VALUES (?, ?, ?, ?)'
    );
    for (const entry of ENTITY_TYPES) {
      if (check.get(uid, entry.symbol) === undefined) {
        ins.run(uid, `${entry.label} Template`, defaultTemplate(entry.name), entry.symbol);
      }
    }
  });
  tx(userId);
}

// The six seed notebook names, exposed for testing and the notebooks.js
// rename lock (1.8b).
export function seedNotebookNames() {
  return [...SEED_NOTEBOOK_NAMES];
}
