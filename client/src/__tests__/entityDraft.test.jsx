import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// Stub the API client (functions hoisted so the vi.mock factory can reference them).
const { api } = vi.hoisted(() => ({ api: { post: vi.fn(), get: vi.fn() } }));
vi.mock('../api/client.js', () => ({ api }));

import EntityDraftPanel from '../components/editor/EntityDraftPanel.jsx';
import EditorToolbar from '../components/editor/EditorToolbar.jsx';

const noop = () => {};
async function waitText(el, text) { await waitFor(() => { expect(el.value).toContain(text); }); }

beforeEach(() => {
  api.post.mockReset();
  api.post.mockResolvedValue({ warmed: true, ms: 1 });
});

describe('EntityDraftPanel (form state)', () => {
  it('shows the entity name/type and a Draft button when no job is running', () => {
    render(<EntityDraftPanel label={{ symbol: '&', label: 'NPC' }} name="Borg the Black" draftJob={null} onDraftJobChange={noop} onComplete={noop} />);
    expect(screen.getByText(/AI Assist/i)).toBeInTheDocument();
    expect(screen.getByText(/Borg the Black/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /draft/i })).toBeInTheDocument();
  });

  it('posts the extra direction and starts the draft job', async () => {
    api.post.mockReset();
    api.post.mockResolvedValue({ jobId: 'j1' }); // covers the warm-up + the draft call
    const onChange = vi.fn();
    render(<EntityDraftPanel label={{ symbol: '&', label: 'NPC' }} name="Borg" draftJob={null} onDraftJobChange={onChange} onComplete={noop} />);

    fireEvent.change(screen.getByPlaceholderText(/Optional direction/i), { target: { value: 'make it tense' } });
    fireEvent.click(screen.getByRole('button', { name: /draft/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/api/entity-types/%26/draft', { name: 'Borg', extra: 'make it tense' });
    const arg = onChange.mock.calls.at(-1)[0];
    expect(arg.jobId).toBe('j1');
    expect(arg.status).toBe('processing');
  });
});

describe('EntityDraftPanel (preview state)', () => {
  it('renders the draft for review and applies it to the note', async () => {
    api.post.mockReset();
    api.post.mockResolvedValue({ jobId: 'j2' }); // warm-up (2nd) → the apply call
    const job = { jobId: 'j2', status: 'preview', content: '## Description\n\ndraft body' };
    const onChange = vi.fn();
    render(<EntityDraftPanel label={{ symbol: '&', label: 'NPC' }} name="Borg" draftJob={job} onDraftJobChange={onChange} onComplete={noop} />);

    const box = screen.getByRole('textbox');
    await waitText(box, 'draft body');

    fireEvent.change(box, { target: { value: '## Description\n\nmy edits' } });
    fireEvent.click(screen.getByRole('button', { name: /apply to note/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/entity-types/draft/j2/apply', { content: '## Description\n\nmy edits' }));
    const lastCall = onChange.mock.calls.at(-1);
    expect(typeof lastCall[0]).toBe('function');
    expect(lastCall[0]({ status: 'preview' }).status).toBe('complete');
  });

  it('shows a Cancel button while processing', () => {
    const job = { jobId: 'j3', status: 'processing', content: '', startedAt: Date.now() };
    render(<EntityDraftPanel label={{ symbol: '&', label: 'NPC' }} name="Borg" draftJob={job} onDraftJobChange={noop} onComplete={noop} />);
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('shows an error state when the job failed', () => {
    const job = { jobId: 'j4', status: 'failed', error: 'Ollama went away', startedAt: Date.now() };
    render(<EntityDraftPanel label={{ symbol: '&', label: 'NPC' }} name="Borg" draftJob={job} onDraftJobChange={noop} onComplete={noop} />);
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/Ollama went away/i)).toBeInTheDocument();
  });
});

describe('EditorToolbar AI button', () => {
  it('shows AI Assist when an ai config is provided', () => {
    render(<EditorToolbar viewRef={{ current: null }} ai={{ label: { label: 'NPC' }, name: 'Borg', onAssist: vi.fn() }} />);
    expect(screen.getByRole('button', { name: /AI Assist/i })).toBeInTheDocument();
  });

  it('hides AI Assist when no ai config is provided (plain note)', () => {
    render(<EditorToolbar viewRef={{ current: null }} />);
    expect(screen.queryByRole('button', { name: /AI Assist/i })).not.toBeInTheDocument();
  });
});
