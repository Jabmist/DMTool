import { autocompletion } from '@codemirror/autocomplete';
import { api } from '../../api/client.js';

// Cache note titles for 10s to avoid hammering the API on every keystroke
let cachedTitles = [];
let cacheExpiry = 0;

async function fetchTitles() {
  if (Date.now() < cacheExpiry) return cachedTitles;
  try {
    const d = await api.get('/api/notes');
    cachedTitles = d.paths.map(p => p.replace(/\.md$/, '').split('/').pop());
    cacheExpiry = Date.now() + 10_000;
  } catch { /* keep stale cache */ }
  return cachedTitles;
}

export function invalidateWikilinkCache() {
  cacheExpiry = 0;
}

async function wikilinkSource(context) {
  // Only trigger inside [[ ... ]] — match from [[ up to cursor with no closing ]]
  const before = context.matchBefore(/\[\[[^\]]*$/);
  if (!before && !context.explicit) return null;
  if (!before) return null;

  const query = before.text.slice(2).toLowerCase();
  const titles = await fetchTitles();
  const matches = titles.filter(t => t.toLowerCase().includes(query));
  if (!matches.length) return null;

  return {
    from: before.from + 2, // start replacing after [[
    options: matches.map(t => ({
      label: t,
      apply: (view, completion, from, to) => {
        view.dispatch({
          changes: { from, to, insert: `${t}]]` },
          selection: { anchor: from + t.length + 2 },
        });
      },
    })),
    validFor: /^[^\]]*$/,
  };
}

export const wikilinkCompletion = autocompletion({
  override: [wikilinkSource],
  closeOnBlur: true,
});
