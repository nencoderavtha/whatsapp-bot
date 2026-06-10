// Central API wrapper — all fetch calls go through here.
// Auth uses httpOnly cookie set by POST /api/auth/login, no header needed.

export async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    credentials: "include",
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("auth:unauthorized"));
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text);
  }
  return res.json();
}

export async function login(username, password) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error("denied");
  return res.json();
}

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
}

export async function checkSession() {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  if (!res.ok) throw new Error("no session");
  return res.json();
}
