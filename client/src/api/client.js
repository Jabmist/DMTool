// Thin fetch wrapper. Auth store injects the token via setTokenGetter after init.
let getToken = () => null;
let onUnauthorized = () => {};

export function setTokenGetter(fn) { getToken = fn; }
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const resolve = (url) => (url.startsWith('/') ? BASE + url : url);

async function request(method, url, body) {
  const token = getToken();
  const res = await fetch(resolve(url), {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 401) {
    onUnauthorized();
    throw new Error('Unauthorized');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  get:    (url)       => request('GET',    url),
  post:   (url, body) => request('POST',   url, body),
  put:    (url, body) => request('PUT',    url, body),
  patch:  (url, body) => request('PATCH',  url, body),
  delete: (url, body) => request('DELETE', url, body),
};

// Download an authenticated endpoint's body as a file and trigger a browser
// save. The generic request() always parses JSON, so binary payloads need
// their own path; we mirror its auth handling (Bearer header + credentials).
export async function downloadFile(url, filename) {
  const token = getToken();
  const res = await fetch(resolve(url), {
    method: 'GET',
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) { onUnauthorized(); throw new Error('Unauthorized'); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export async function uploadFile(url, formData) {
  const token = getToken();
  const res = await fetch(resolve(url), {
    method: 'POST',
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
