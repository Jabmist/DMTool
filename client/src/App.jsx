import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/authStore.js';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import VaultPage from './pages/VaultPage.jsx';
import HelpPage from './pages/HelpPage.jsx';
import VersionPage from './pages/VersionPage.jsx';

function RequireAuth({ children }) {
  const user = useAuthStore(s => s.user);
  return user ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/help" element={<HelpPage />} />
      <Route path="/version" element={
        <RequireAuth>
          <VersionPage />
        </RequireAuth>
      } />
      <Route path="/*" element={
        <RequireAuth>
          <VaultPage />
        </RequireAuth>
      } />
    </Routes>
  );
}
