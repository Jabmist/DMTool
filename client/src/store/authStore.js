import { create } from 'zustand';
import { api } from '../api/client.js';

export const useAuthStore = create((set, get) => ({
  user: null,
  accessToken: null,

  login: async (email, password) => {
    const data = await api.post('/api/auth/login', { email, password });
    set({ user: data.user, accessToken: data.accessToken });
    return data;
  },

  register: async (email, password) => {
    const data = await api.post('/api/auth/register', { email, password });
    if (!data.pending) {
      set({ user: data.user, accessToken: data.accessToken });
    }
    return data;
  },

  refresh: async () => {
    try {
      const data = await api.post('/api/auth/refresh', {});
      set({ accessToken: data.accessToken });
      return data.accessToken;
    } catch {
      set({ user: null, accessToken: null });
      return null;
    }
  },

  logout: async () => {
    await api.post('/api/auth/logout', {}).catch(() => {});
    set({ user: null, accessToken: null });
  },

  getToken: () => get().accessToken,
}));
