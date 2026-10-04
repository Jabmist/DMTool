import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore } from '../store/authStore.js';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const login = useAuthStore(s => s.login);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={handleSubmit} style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>Sign in</h1>
        {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
        <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required />
        <button type="submit">Sign in</button>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          No account? <Link to="/register">Register</Link> · <Link to="/help">Help</Link>
        </p>
      </form>
    </div>
  );
}
