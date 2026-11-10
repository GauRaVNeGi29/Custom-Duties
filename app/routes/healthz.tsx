/**
 * GET /healthz – used by Render's health check and the keep-awake pinger.
 * Deliberately does not touch the database, so pings never wake Neon.
 */
export const loader = () =>
  new Response("ok", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
