import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../api/client.js';

export default function EntityDraftPanel({ label, name, draftJob, onDraftJobChange, onComplete }) {
  const [extra, setExtra] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [applyError, setApplyError] = useState('');
  const [draft, setDraft] = useState('');
  const preloadFired = useRef(false);
  const [, setTick] = useState(0);

  // Reuse the model warm-up so the first draft doesn't pay Ollama's load
  // latency (hits the same shared Ollama as the dissect panel).
  useEffect(() => {
    if (preloadFired.current || draftJob) return;
    preloadFired.current = true;
    api.post('/api/dissect/warm')
      .then(r => console.info('[preload] model ready in', (r.ms ?? 0) + 'ms'))
      .catch(e => console.info('[preload] model not warmed yet:', e?.message ?? e));
  }, [draftJob]);

  // Force re-render each second while running so the elapsed time stays current.
  useEffect(() => {
    if (!['processing', 'waiting_continue'].includes(draftJob?.status)) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [draftJob?.status]);

  // Seed the editable draft with the job's content each time a preview lands.
  useEffect(() => {
    if (draftJob?.status === 'preview') setDraft(draftJob.content ?? '');
  }, [draftJob?.jobId, draftJob?.status]);

  function reset() {
    onDraftJobChange(null);
    setExtra('');
    setSubmitError('');
    setApplyError('');
  }

  async function handleDraft() {
    setSubmitError('');
    setSubmitting(true);
    try {
      const d = await api.post(`/api/entity-types/${encodeURIComponent(label?.symbol ?? '')}/draft`, { name, extra });
      onDraftJobChange({
        jobId: d.jobId, status: 'processing', content: '', error: '',
        startedAt: Date.now(), label, name, extra,
      });
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApply() {
    if (!draftJob?.jobId) return;
    setApplying(true);
    setApplyError('');
    try {
      await api.post(`/api/entity-types/draft/${draftJob.jobId}/apply`, { content: draft });
      onDraftJobChange(j => ({ ...j, status: 'complete' }));
    } catch (err) {
      setApplyError(err.message);
    } finally {
      setApplying(false);
    }
  }

  // ── Form (no job running yet) ────────────────────────────────────────────
  if (!draftJob) {
    return (
      <div style={{ padding: 24, height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h2 style={{ fontSize: 16 }}>AI Assist</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          Draft detail for the <strong style={{ color: 'var(--accent)' }}>{label?.label ?? 'entity'}</strong> &ldquo;{name}&rdquo; from its template.
        </p>
        <textarea
          rows={5}
          placeholder="Optional direction for the AI (tone, plot angle, what to emphasize)…"
          value={extra}
          onChange={e => setExtra(e.target.value)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 13, resize: 'vertical' }}
        />
        {submitError && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{submitError}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleDraft} disabled={submitting}>{submitting ? 'Starting…' : 'Draft'}</button>
          <button className="secondary" onClick={onComplete}>Close</button>
        </div>
      </div>
    );
  }

  const { status } = draftJob;

  if (status === 'complete') {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ marginBottom: 16 }}>Draft written to the note.</p>
        <button onClick={() => { reset(); onComplete(); }}>Done</button>
      </div>
    );
  }

  if (status === 'processing') {
    const elapsed = draftJob.startedAt ? Math.floor((Date.now() - draftJob.startedAt) / 1000) : 0;
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ fontSize: 16 }}>AI Assist</h2>
        <p style={{ color: 'var(--text-muted)' }}>
          Drafting&hellip; the model is filling in this {label?.label ?? 'entity'}.{' '}
          <span style={{ fontSize: 12 }}>({elapsed}s)</span>
        </p>
        <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          If it goes over {Math.round((draftJob.timeoutMs ?? 1_800_000) / 1000)}s it will ask whether to continue or cancel.
        </p>
        <button
          className="secondary"
          style={{ width: 'fit-content' }}
          onClick={() => { api.post(`/api/entity-types/draft/${draftJob.jobId}/cancel`).catch(() => {}); reset(); }}
        >
          Cancel
        </button>
      </div>
    );
  }

  if (status === 'failed' || status === 'cancelled') {
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ fontSize: 16 }}>AI Assist</h2>
        <p style={{ color: 'var(--danger)' }}>
          {status === 'failed' ? 'Failed' : 'Cancelled'}: {draftJob.error ?? (status === 'failed' ? 'Unknown error' : '')}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={reset}>Try again</button>
          <button className="secondary" onClick={() => { reset(); onComplete(); }}>Close</button>
        </div>
      </div>
    );
  }

  if (status === 'waiting_continue') {
    const elapsed = draftJob.startedAt ? Math.floor((Date.now() - draftJob.startedAt) / 1000) : 0;
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ fontSize: 16 }}>AI Assist</h2>
        <p style={{ color: 'var(--text-muted)' }}>The model has been working for {elapsed}s without finishing.</p>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Continue and let it keep going, or cancel.</p>
        {applyError && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{applyError}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            disabled={applying}
            onClick={async () => {
              setApplying(true); setApplyError('');
              try {
                await api.post(`/api/entity-types/draft/${draftJob.jobId}/continue`);
                onDraftJobChange(j => ({ ...j, status: 'processing' }));
              } catch (err) { setApplyError(err.message); } finally { setApplying(false); }
            }}
          >
            {applying ? 'Resuming…' : 'Continue'}
          </button>
          <button
            className="danger"
            style={{ width: 'fit-content' }}
            onClick={() => { api.post(`/api/entity-types/draft/${draftJob.jobId}/cancel`).catch(() => {}); reset(); }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Preview — review / edit the single markdown draft, then apply or discard.
  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{ fontSize: 16 }}>AI Assist</h2>
      <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Review the draft for &ldquo;{name}&rdquo;. Edit it if you like, then apply it to the note.
      </p>
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        rows={20}
        onFocus={() => { if (!draft) setDraft(draftJob.content ?? ''); }}
        style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical', minHeight: 320 }}
      />
      {applyError && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{applyError}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={handleApply} disabled={applying}>{applying ? 'Applying…' : 'Apply to note'}</button>
        <button className="secondary" onClick={() => { reset(); onComplete(); }}>Discard</button>
      </div>
    </div>
  );
}
