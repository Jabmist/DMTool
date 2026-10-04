import React, { useState, useEffect, useRef } from 'react';
import { api, uploadFile } from '../../api/client.js';

const MAX_CHARS = 4000;

export default function DissectPanel({ dissectJob, onDissectJobChange, onComplete }) {
  const [mode, setMode] = useState('text');
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [approveError, setApproveError] = useState('');
  const [, setTick] = useState(0);
  const fileInputRef = useRef(null);
  const preloadFired = useRef(false);

  // Preload the model: firing a trivial "hi" turn at Ollama (via the server)
  // is the cheapest way to get the host loading the model's weights NOW, so
  // the first real dissection doesn't pay the load latency. Fire once per
  // panel visit while the user is reading the form — the server coalesces
  // in-flight calls and this resolves/rejects without blocking anything.
  useEffect(() => {
    if (preloadFired.current || dissectJob) return;
    preloadFired.current = true;
    api.post('/api/dissect/warm')
      .then(r => console.info('[preload] model ready in', (r.ms ?? 0) + 'ms'))
      .catch(e => console.info('[preload] model not warmed yet:', e?.message ?? e));
  }, [dissectJob]);

  // Force re-render every second while running so elapsed time stays current
  useEffect(() => {
    if (!['processing', 'waiting_continue'].includes(dissectJob?.status)) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [dissectJob?.status]);

  function handleTextChange(e) {
    setText(e.target.value.slice(0, MAX_CHARS));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitError('');
    setSubmitting(true);
    try {
      let jobId;
      if (mode === 'file') {
        const fd = new FormData();
        fd.append('file', file);
        const data = await uploadFile('/api/dissect/upload', fd);
        jobId = data.jobId;
      } else {
        const data = await api.post('/api/dissect', { text });
        jobId = data.jobId;
      }
      onDissectJobChange({ jobId, status: 'processing', notes: [], error: '', startedAt: Date.now() });
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApprove() {
    setApproving(true);
    setApproveError('');
    try {
      await api.post(`/api/dissect/${dissectJob.jobId}/approve`, { notes: dissectJob.notes });
      onDissectJobChange(j => ({ ...j, status: 'complete' }));
    } catch (err) {
      setApproveError(err.message);
    } finally {
      setApproving(false);
    }
  }

  function updateNote(i, field, value) {
    onDissectJobChange(j => ({ ...j, notes: j.notes.map((n, idx) => idx === i ? { ...n, [field]: value } : n) }));
  }

  function removeNote(i) {
    onDissectJobChange(j => ({ ...j, notes: j.notes.filter((_, idx) => idx !== i) }));
  }

  function reset() {
    onDissectJobChange(null);
    setText('');
    setFile(null);
    setSubmitError('');
    setApproveError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // No active job — show submission form
  if (!dissectJob) {
    return (
      <div style={{ padding: 24, height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h2 style={{ fontSize: 16 }}>AI Note Dissection</h2>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
            {['text', 'file'].map(m => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setSubmitError(''); }}
                style={{
                  background: 'none', border: 'none',
                  borderBottom: mode === m ? '2px solid var(--accent)' : '2px solid transparent',
                  padding: '4px 14px', fontSize: 13, cursor: 'pointer',
                  color: mode === m ? 'var(--text)' : 'var(--text-muted)', marginBottom: -1,
                }}
              >
                {m === 'text' ? 'Paste text' : 'Upload file'}
              </button>
            ))}
          </div>

          {mode === 'text' ? (
            <>
              <textarea
                rows={12}
                placeholder="Paste raw text to dissect into atomic notes…"
                value={text}
                onChange={handleTextChange}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 13, resize: 'vertical' }}
              />
              <div
                style={{
                  fontSize: 11,
                  textAlign: 'right',
                  color: text.length >= MAX_CHARS ? 'var(--danger)' : 'var(--text-muted)',
                }}
              >
                {text.length} / {MAX_CHARS} chars
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.txt,.pdf,.docx"
                onChange={e => setFile(e.target.files[0] ?? null)}
              />
              {file && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {file.name} ({(file.size / 1024).toFixed(1)} KB)
                </p>
              )}
            </div>
          )}

          {submitError && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{submitError}</p>}
          <button type="submit" disabled={submitting || (mode === 'text' ? !text.trim() : !file)}>
            {submitting ? 'Submitting…' : 'Dissect'}
          </button>
        </form>
      </div>
    );
  }

  if (dissectJob.status === 'complete') {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ marginBottom: 16 }}>Notes written to vault.</p>
        <button onClick={() => { reset(); onComplete(); }}>Done</button>
      </div>
    );
  }

  if (dissectJob.status === 'processing') {
    const elapsed = dissectJob.startedAt
      ? Math.floor((Date.now() - dissectJob.startedAt) / 1000)
      : 0;
    const timeoutSec = Math.round((dissectJob.timeoutMs ?? 1_800_000) / 1000);
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ fontSize: 16 }}>AI Note Dissection</h2>
        <p style={{ color: 'var(--text-muted)' }}>
          Processing… the model is dissecting your note.{' '}
          <span style={{ fontSize: 12 }}>({elapsed}s)</span>
        </p>
        <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          If it goes over {timeoutSec}s without finishing, you&apos;ll be asked whether to continue or cancel.
        </p>
        <button
          className="secondary"
          style={{ width: 'fit-content' }}
          onClick={() => {
            api.post(`/api/dissect/${dissectJob.jobId}/cancel`).catch(() => {});
            reset();
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  if (dissectJob.status === 'failed' || dissectJob.status === 'cancelled') {
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ fontSize: 16 }}>AI Note Dissection</h2>
        <p style={{ color: 'var(--danger)' }}>{dissectJob.status === 'failed' ? 'Failed' : 'Cancelled'}: {dissectJob.error ?? (dissectJob.status === 'failed' ? 'Unknown error' : '')}</p>
        <button onClick={reset}>Try again</button>
      </div>
    );
  }

  if (dissectJob.status === 'waiting_continue') {
    const elapsed = dissectJob.startedAt
      ? Math.floor((Date.now() - dissectJob.startedAt) / 1000)
      : 0;
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ fontSize: 16 }}>AI Note Dissection</h2>
        <p style={{ color: 'var(--text-muted)' }}>
          The model has been working for {elapsed}s without finishing.
        </p>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Continue and let it keep going, or cancel and give up on this batch.</p>
        {approveError && <p className="danger" style={{ color: 'var(--danger)', fontSize: 12 }}>{approveError}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            disabled={approving}
            onClick={async () => {
              setApproving(true); setApproveError('');
              try {
                await api.post(`/api/dissect/${dissectJob.jobId}/continue`);
                onDissectJobChange(j => ({ ...j, status: 'processing' }));
              } catch (err) {
                setApproveError(err.message);
              } finally {
                setApproving(false);
              }
            }}
          >
            {approving ? 'Resuming…' : 'Continue'}
          </button>
          <button
            className="danger"
            style={{ width: 'fit-content' }}
            onClick={() => {
              api.post(`/api/dissect/${dissectJob.jobId}/cancel`).catch(() => {});
              reset();
            }}
          >
            Cancel
          </button>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Cancelling now also stops any request still running on the server.
        </p>
      </div>
    );
  }

  // Preview state
  const notes = dissectJob.notes ?? [];
  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{ fontSize: 16 }}>AI Note Dissection</h2>
      <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Review and edit notes before writing to vault. {notes.length} note{notes.length !== 1 ? 's' : ''} proposed.
      </p>
      {notes.map((note, i) => (
        <div key={i} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
          {note.collision && (
            <p style={{ color: '#e0a05c', fontSize: 11, marginBottom: 6 }}>
              A note with this title already exists — new content will be appended.
            </p>
          )}
          <input
            value={note.title}
            onChange={e => updateNote(i, 'title', e.target.value)}
            style={{ marginBottom: 8, fontWeight: 600 }}
          />
          <textarea
            value={note.content}
            onChange={e => updateNote(i, 'content', e.target.value)}
            rows={6}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
          />
          <button className="danger" onClick={() => removeNote(i)} style={{ marginTop: 8, fontSize: 11, padding: '3px 10px' }}>
            Discard
          </button>
        </div>
      ))}
      {approveError && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{approveError}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={handleApprove} disabled={approving || notes.length === 0}>
          {approving ? 'Writing…' : `Approve ${notes.length} note${notes.length !== 1 ? 's' : ''}`}
        </button>
        <button className="secondary" onClick={reset}>Cancel</button>
      </div>
    </div>
  );
}
