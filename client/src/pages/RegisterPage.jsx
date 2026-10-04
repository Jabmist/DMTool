import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore } from '../store/authStore.js';

export default function RegisterPage() {
  const [email, setEmail]     = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]     = useState('');
  const [pending, setPending] = useState(false);
  const register = useAuthStore(s => s.register);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      const data = await register(email, password);
      if (data.pending) {
        setPending(true);
        return;
      }
      navigate('/');
    } catch (err) {
      setError(err.message);
    }
  }

  if (pending) {
    return (
      <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 360, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>Registration received</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6 }}>
            Your account is awaiting admin approval.<br />
            You will be able to sign in once an admin approves your request.
          </p>
          <p style={{ marginTop: 20, fontSize: 12 }}>
            <Link to="/login">Back to sign in</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={handleSubmit} style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>Create account</h1>
        {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
        <input type="password" placeholder="Password (12+ characters)" value={password} onChange={e => setPassword(e.target.value)} required minLength={12} />
        <button type="submit">Register</button>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Have an account? <Link to="/login">Sign in</Link> · <Link to="/help">Help</Link>
        </p>
      </form>
    </div>
  );
}
