import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { setTokenGetter, setUnauthorizedHandler } from './api/client.js';
import { useAuthStore } from './store/authStore.js';
import './index.css';

setTokenGetter(() => useAuthStore.getState().accessToken);
setUnauthorizedHandler(() => {
  useAuthStore.getState().refresh().then(token => {
    if (!token) useAuthStore.getState().logout();
  });
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
