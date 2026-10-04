import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import HelpPage from '../pages/HelpPage.jsx';
import { SECTIONS } from '../pages/helpContent.js';

const body = id => screen.queryByTestId(`help-body-${id}`);
const toggle = id => screen.queryByTestId(`help-toggle-${id}`);

// jsdom has no layout engine, so scrollIntoView is a no-op unless stubbed.
let scrollSpy;

const renderPage = () => render(<MemoryRouter><HelpPage /></MemoryRouter>);
const nav = () => screen.getByRole('navigation', { name: 'Help topics' });

beforeEach(() => {
  scrollSpy = vi.fn();
  window.Element.prototype.scrollIntoView = scrollSpy;
});
afterEach(() => { scrollSpy.mockReset(); });

describe('HelpPage collapsible sections', () => {
  it('renders every topic collapsed, with the intro heading above', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    for (const s of SECTIONS) {
      expect(toggle(s.id), `toggle for ${s.id}`).toBeInTheDocument();
      expect(toggle(s.id)).toHaveAttribute('aria-expanded', 'false');
      expect(body(s.id), `body for ${s.id}`).not.toBeInTheDocument();
    }
  });

  it('clicking a section title expands it, clicking again collapses it', () => {
    renderPage();
    fireEvent.click(toggle('keyboard'));
    expect(body('keyboard')).toBeInTheDocument();
    expect(toggle('keyboard')).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle('keyboard'));
    expect(body('keyboard')).not.toBeInTheDocument();
    expect(toggle('keyboard')).toHaveAttribute('aria-expanded', 'false');
  });

  it('opening one section leaves the others collapsed', () => {
    renderPage();
    fireEvent.click(toggle('keyboard'));
    expect(body('keyboard')).toBeInTheDocument();
    expect(body('graph')).not.toBeInTheDocument();
    expect(body('notes')).not.toBeInTheDocument();
  });
});

describe('HelpPage nav pane', () => {
  it('lists every topic', () => {
    renderPage();
    for (const s of SECTIONS) {
      expect(within(nav()).getByText(s.title), `nav link for ${s.title}`).toBeInTheDocument();
    }
  });

  it('clicking a nav link expands the section and scrolls it into view', () => {
    renderPage();
    fireEvent.click(within(nav()).getByText('Keyboard'));
    expect(body('keyboard')).toBeInTheDocument();
    expect(toggle('keyboard')).toHaveAttribute('aria-expanded', 'true');
    expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
  });

  it('re-clicking a nav link keeps an already-open section open', () => {
    renderPage();
    fireEvent.click(toggle('keyboard'));
    fireEvent.click(within(nav()).getByText('Keyboard'));
    expect(body('keyboard')).toBeInTheDocument();
    expect(toggle('keyboard')).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('HelpPage search', () => {
  const searchBox = () => screen.getByPlaceholderText('Search the help…');

  it('hides non-matching topics and expands the match', () => {
    renderPage();
    fireEvent.change(searchBox(), { target: { value: 'shortcuts' } });
    expect(body('keyboard')).toBeInTheDocument();
    expect(screen.queryByTestId('help-body-layout')).not.toBeInTheDocument();
    expect(toggle('keyboard')).toHaveAttribute('aria-expanded', 'true');
    // The match is listed in the nav AND its body actually renders
    // (collapsed sections render no body div at all).
    expect(within(nav()).getByText('Keyboard')).toBeInTheDocument();
    expect(screen.getByTestId('help-body-keyboard').textContent).not.toMatch(/^\s*$/);
  });

  it('hides the intro while searching', () => {
    renderPage();
    fireEvent.change(searchBox(), { target: { value: 'shortcuts' } });
    expect(body('keyboard')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('search is case-insensitive', () => {
    renderPage();
    fireEvent.change(searchBox(), { target: { value: 'SHORTCUTS' } });
    expect(body('keyboard')).toBeInTheDocument();
  });

  it('clearing the search restores the full doc with the intro back', () => {
    renderPage();
    fireEvent.change(searchBox(), { target: { value: 'shortcuts' } });
    expect(body('keyboard')).toBeInTheDocument();

    fireEvent.change(searchBox(), { target: { value: '' } });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(toggle('keyboard')).toBeInTheDocument();
  });

  it('shows a no-match message when nothing matches', () => {
    renderPage();
    fireEvent.change(searchBox(), { target: { value: 'zzz-nothing-here' } });
    expect(screen.getByText(/No help topics match/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Keyboard' })).not.toBeInTheDocument();
  });
});
