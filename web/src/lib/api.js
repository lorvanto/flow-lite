export async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/'))
      window.dispatchEvent(new Event('flow:unauthorized'));
    const error = new Error(
      data.message ||
        (typeof data.error === 'string' ? data.error : data.error?.message) ||
        `请求失败（${response.status}）`,
    );
    error.status = response.status;
    throw error;
  }
  return data;
}
