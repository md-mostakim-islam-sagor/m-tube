/**
 * M-TUBE — Client API Helper
 * The API base URL is derived from the current origin at call time —
 * never hard-coded to a specific domain.
 */

export function apiBaseUrl() {
  if (typeof window === "undefined") return "/api";
  return `${window.location.origin}/api`;
}

export function currentDomain() {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

async function postJson(path, body) {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const err = new Error(data.error || "Request failed.");
    err.code = data.code || "UNKNOWN_ERROR";
    err.status = res.status;
    throw err;
  }
  return data;
}

export const MTubeAPI = {
  getInfo: (url) => postJson("/info", { url }),
  requestDownload: (url, format, quality) => postJson("/download", { url, format, quality }),
  getStatus: async (jobId) => {
    const res = await fetch(`${apiBaseUrl()}/status/${jobId}`);
    return res.json();
  }
};
