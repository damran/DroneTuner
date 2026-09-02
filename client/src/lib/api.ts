export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const apiGet = <T,>(path: string): Promise<T> => api<T>(path);
export const apiPost = <T,>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPatch = <T,>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPut = <T,>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiDelete = <T,>(path: string): Promise<T> => api<T>(path, { method: "DELETE" });

export function photoUrl(path: string): string {
  return `/api/files/photos/${path}`;
}

export function logFileUrl(path: string): string {
  return `/api/files/logs/${path}`;
}
