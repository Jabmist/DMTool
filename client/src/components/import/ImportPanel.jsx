import React, { useState } from 'react';
import { api, uploadFile } from '../../api/client.js';
import { useMobile } from '../../hooks/useMobile.js';

const MODES = [
  { key: 'file',  label: 'Single .md file' },
  { key: 'vault', label: 'Vault (.zip)' },
  { key: 'text',  label: 'Paste text' },
  { key: 'url',   label: 'URL' },
];

export default function ImportPanel({ onComplete }) {
  const isMobile = useMobile();
  const [mode, setMode] = useState('file');
  const [conflict, setConflict] = useState('overwrite');
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('');
  const [url, setUrl] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function resetForm() {
    setResult(null);
    setError('');
    setText('');
    setFilename('');
    setUrl('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);

    try {
      let data;
      if (mode === 'text') {
        if (!text.trim()) { setError('Text is required'); setLoading(false); return; }
        if (!filename.trim()) { setError('Filename is required'); setLoading(false); return; }
        data = await api.post('/api/import/text', { text, filename, conflict });
      } else if (mode === 'url') {
        if (!url.trim()) { setError('URL is required'); setLoading(false); return; }
        data = await api.post('/api/import/url', { url, filename: filename.trim() || undefined, conflict });
      } else {
        const form = e.target;
        const fileInput = form.querySelector('input[type=file]');
        if (!fileInput.files[0]) { setError('No file selected'); setLoading(false); return; }
        const fd = new FormData();
        fd.append(mode === 'vault' ? 'vault' : 'file', fileInput.files[0]);
        fd.append('conflict', conflict);
        data = await uploadFile(`/api/import/${mode}`, fd);
      }
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{ fontSize: 16 }}>Import</h2>

      {isMobile ? (
        <select
          value={mode}
          onChange={e => { setMode(e.target.value); resetForm(); }}
          style={{ fontSize: 16 }}
        >
          {MODES.map(({ key, label }) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {MODES.map(({ key, label }) => (
            <button key={key} className={mode === key ? '' : 'secondary'} onClick={() => { setMode(key); resetForm(); }}>
              {label}
            </button>
          ))}
        </div>
      )}

      {!result ? (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mode === 'file' && (
            <input type="file" accept=".md" style={{ background: 'none', border: 'none', padding: 0 }} />
          )}
          {mode === 'vault' && (
            <input type="file" accept=".zip" style={{ background: 'none', border: 'none', padding: 0 }} />
          )}
          {mode === 'text' && (
            <>
              <textarea
                rows={10}
                placeholder="Paste text here…"
                value={text}
                onChange={e => setText(e.target.value)}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 13, resize: 'vertical' }}
              />
              <input
                placeholder="Note filename (without .md)"
                value={filename}
                onChange={e => setFilename(e.target.value)}
                style={{ fontSize: 13 }}
              />
            </>
          )}
          {mode === 'url' && (
            <>
              <input
                placeholder="https://example.com/article"
                value={url}
                onChange={e => setUrl(e.target.value)}
                style={{ fontSize: 13 }}
                type="url"
              />
              <input
                placeholder="Note filename (optional — defaults to page title)"
                value={filename}
                onChange={e => setFilename(e.target.value)}
                style={{ fontSize: 13 }}
              />
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                Fetches the page server-side and converts the article body to markdown.
              </p>
            </>
          )}

          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>On conflict:</label>
          <select
            value={conflict}
            onChange={e => setConflict(e.target.value)}
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', color: 'var(--text)', padding: '6px 10px', borderRadius: 4 }}
          >
            <option value="overwrite">Overwrite</option>
            <option value="append">Append</option>
            <option value="skip">Skip</option>
          </select>

          {error && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</p>}
          <button type="submit" disabled={loading}>{loading ? 'Importing…' : 'Import'}</button>
        </form>
      ) : (
        <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ color: '#6fcf97' }}>Imported {result.written?.length ?? 0} file(s)</p>
          {result.skipped?.length > 0 && <p style={{ color: 'var(--text-muted)' }}>Skipped: {result.skipped.length}</p>}
          {result.errors?.length > 0 && (
            <div>
              <p style={{ color: 'var(--danger)' }}>Errors ({result.errors.length}):</p>
              {result.errors.map((e, i) => <p key={i} style={{ fontSize: 11, color: 'var(--danger)' }}>{e.path}: {e.error}</p>)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={onComplete}>Done</button>
            <button className="secondary" onClick={resetForm}>Import more</button>
          </div>
        </div>
      )}
    </div>
  );
}
