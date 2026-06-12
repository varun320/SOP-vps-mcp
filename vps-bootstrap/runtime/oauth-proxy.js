// oauth-proxy.js — MCP 2025-06 OAuth 2.1 authorization server + protected resource gateway
// Sits in front of supergateway (loopback :8788), terminates auth, proxies authorized requests.
// Accepts EITHER a static bearer (legacy/CLI) OR an OAuth-issued access token.

const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const url = require("url");

// --- config ---
const STATIC_TOKEN = process.env.MCP_BEARER_TOKEN;
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || "8788", 10);
const BIND_PORT = parseInt(process.env.MCP_PORT || "8787", 10);
const BIND_ADDR = process.env.MCP_BIND_ADDR || "127.0.0.1";
const ISSUER = process.env.OAUTH_ISSUER || "https://cc-prod.tail7411c5.ts.net";
const LOGIN_PASSWORD = process.env.OAUTH_LOGIN_PASSWORD;
const STATE_PATH = process.env.OAUTH_STATE_PATH || "/home/claude/.config/claude/oauth-state.json";
const ACCESS_TTL = parseInt(process.env.OAUTH_ACCESS_TTL || "3600", 10);
const CODE_TTL = parseInt(process.env.OAUTH_CODE_TTL || "600", 10);

if (!STATIC_TOKEN) { console.error("MCP_BEARER_TOKEN not set"); process.exit(1); }
if (!LOGIN_PASSWORD) { console.error("OAUTH_LOGIN_PASSWORD not set"); process.exit(1); }

// --- state (persisted JSON) ---
let store = { clients: {}, codes: {}, pending: {}, tokens: {}, refresh: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  store = { ...store, ...loaded };
} catch (_) { /* fresh */ }

function saveStore() {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(store), { mode: 0o600 }); }
  catch (e) { console.error("[state] save failed", e.message); }
}

function now() { return Math.floor(Date.now() / 1000); }
function genId(n = 32) { return crypto.randomBytes(n).toString("hex"); }
function b64url(buf) { return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }
function sha256(s) { return crypto.createHash("sha256").update(s).digest(); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function gc() {
  const t = now();
  for (const k of Object.keys(store.codes)) if (store.codes[k].expires_at < t) delete store.codes[k];
  for (const k of Object.keys(store.pending)) if (store.pending[k].expires_at < t) delete store.pending[k];
  for (const k of Object.keys(store.tokens)) if (store.tokens[k].expires_at < t) delete store.tokens[k];
}
setInterval(gc, 60_000);

// --- helpers ---
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => buf += c);
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}
function parseForm(s) { return Object.fromEntries(new URLSearchParams(s)); }
function json(res, code, body, extraHeaders) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", ...(extraHeaders || {}) });
  res.end(JSON.stringify(body));
}
function htmlOut(res, code, body) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}
function oauthErr(res, error, description, status = 400) { json(res, status, { error, error_description: description }); }

// --- handlers ---
async function handleRegister(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return oauthErr(res, "invalid_client_metadata", "invalid JSON"); }
  const client_id = genId(16);
  const client_secret = genId(32);
  const meta = {
    client_id,
    client_secret,
    client_name: body.client_name || "unknown",
    redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
    grant_types: body.grant_types || ["authorization_code", "refresh_token"],
    response_types: body.response_types || ["code"],
    token_endpoint_auth_method: body.token_endpoint_auth_method || "client_secret_post",
    scope: body.scope || "mcp",
    issued_at: now(),
  };
  store.clients[client_id] = meta;
  saveStore();
  json(res, 201, meta);
}

async function handleAuthorizeGet(req, res, q) {
  const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, scope, state: cliState, resource } = q;
  const client = client_id ? store.clients[client_id] : null;
  if (!client) return htmlOut(res, 400, "<p>unknown client_id</p>");
  if (response_type !== "code") return htmlOut(res, 400, "<p>response_type must be code</p>");
  if (!code_challenge || code_challenge_method !== "S256") return htmlOut(res, 400, "<p>PKCE S256 required</p>");
  if (client.redirect_uris.length && !client.redirect_uris.includes(redirect_uri)) {
    return htmlOut(res, 400, "<p>redirect_uri not registered for this client</p>");
  }
  const reqId = genId(16);
  store.pending[reqId] = { client_id, redirect_uri, code_challenge, code_challenge_method, scope: scope || "mcp", resource: resource || null, cliState: cliState || null, expires_at: now() + CODE_TTL };
  saveStore();
  htmlOut(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>Authorize ${escapeHtml(client.client_name)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#1a1a1a;background:#fafafa}
h2{font-weight:600;margin-bottom:8px}
.card{background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.06);border:1px solid #eee}
.client{font-family:ui-monospace,monospace;background:#f3f3f3;padding:2px 6px;border-radius:4px;font-size:14px}
.label{font-size:13px;color:#666;margin-top:18px;margin-bottom:6px;font-weight:500}
input{font-size:16px;padding:11px 12px;width:100%;box-sizing:border-box;border:1px solid #ddd;border-radius:8px;outline:none}
input:focus{border-color:#000}
button{font-size:15px;font-weight:500;padding:12px;width:100%;box-sizing:border-box;background:#000;color:#fff;border:0;border-radius:8px;cursor:pointer;margin-top:18px}
button:hover{background:#222}
.foot{font-size:12px;color:#888;margin-top:20px;text-align:center}
</style></head><body><div class="card">
<h2>Authorize access</h2>
<p><span class="client">${escapeHtml(client.client_name)}</span> wants to connect to your Claude Code MCP server.</p>
<form method="POST" action="/oauth/authorize">
<input type="hidden" name="req_id" value="${reqId}">
<div class="label">Login password</div>
<input type="password" name="password" autofocus required autocomplete="current-password">
<button type="submit">Approve</button>
</form>
<div class="foot">cc-prod · ${escapeHtml(new Date().toISOString().slice(0,10))}</div>
</div></body></html>`);
}

async function handleAuthorizePost(req, res) {
  const form = parseForm(await readBody(req));
  const pending = store.pending[form.req_id];
  if (!pending) return htmlOut(res, 400, "<p>request expired — restart from your client</p>");
  delete store.pending[form.req_id];
  if (form.password !== LOGIN_PASSWORD) {
    saveStore();
    return htmlOut(res, 401, '<p>Wrong password. <a href="javascript:history.back()">Back</a></p>');
  }
  const code = genId(24);
  store.codes[code] = {
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    code_challenge: pending.code_challenge,
    code_challenge_method: pending.code_challenge_method,
    scope: pending.scope,
    resource: pending.resource,
    expires_at: now() + CODE_TTL,
  };
  saveStore();
  const redirect = new URL(pending.redirect_uri);
  redirect.searchParams.set("code", code);
  if (pending.cliState) redirect.searchParams.set("state", pending.cliState);
  res.writeHead(302, { Location: redirect.toString() });
  res.end();
}

async function handleToken(req, res) {
  const params = parseForm(await readBody(req));
  let client_id = params.client_id;
  let client_secret = params.client_secret;
  const ah = req.headers["authorization"];
  if (ah && ah.startsWith("Basic ")) {
    try {
      const [u, p] = Buffer.from(ah.slice(6), "base64").toString("utf8").split(":");
      if (!client_id) client_id = decodeURIComponent(u);
      if (!client_secret) client_secret = decodeURIComponent(p || "");
    } catch (_) { /* ignore */ }
  }
  const client = client_id ? store.clients[client_id] : null;
  if (!client) return oauthErr(res, "invalid_client", "unknown client", 401);

  // Public clients with PKCE may omit client_secret (OAuth 2.1 §4.1.3).
  // If a secret is supplied, it must match.
  if (client_secret && client_secret !== client.client_secret) {
    return oauthErr(res, "invalid_client", "bad client_secret", 401);
  }

  if (params.grant_type === "authorization_code") {
    const code = store.codes[params.code];
    if (!code) return oauthErr(res, "invalid_grant", "unknown or expired code");
    if (code.client_id !== client_id) return oauthErr(res, "invalid_grant", "client mismatch");
    if (code.redirect_uri !== params.redirect_uri) return oauthErr(res, "invalid_grant", "redirect_uri mismatch");
    if (!params.code_verifier) return oauthErr(res, "invalid_grant", "missing code_verifier");
    const challenge = b64url(sha256(params.code_verifier));
    if (challenge !== code.code_challenge) return oauthErr(res, "invalid_grant", "PKCE verification failed");
    delete store.codes[params.code];
    const access_token = genId(32);
    const refresh_token = genId(32);
    store.tokens[access_token] = { client_id, scope: code.scope, resource: code.resource, expires_at: now() + ACCESS_TTL };
    store.refresh[refresh_token] = { client_id, scope: code.scope, resource: code.resource };
    saveStore();
    return json(res, 200, { access_token, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token, scope: code.scope });
  }

  if (params.grant_type === "refresh_token") {
    const rt = store.refresh[params.refresh_token];
    if (!rt || rt.client_id !== client_id) return oauthErr(res, "invalid_grant", "unknown refresh_token");
    const access_token = genId(32);
    store.tokens[access_token] = { client_id, scope: rt.scope, resource: rt.resource, expires_at: now() + ACCESS_TTL };
    saveStore();
    return json(res, 200, { access_token, token_type: "Bearer", expires_in: ACCESS_TTL, scope: rt.scope });
  }

  return oauthErr(res, "unsupported_grant_type", String(params.grant_type));
}

function validateBearer(req) {
  const ah = req.headers["authorization"] || "";
  if (!ah.startsWith("Bearer ")) return null;
  const t = ah.slice(7).trim();
  if (t === STATIC_TOKEN) return { sub: "static-cli" };
  const tok = store.tokens[t];
  if (tok && tok.expires_at > now()) return tok;
  return null;
}

function proxyToUpstream(req, res) {
  const opts = { hostname: "127.0.0.1", port: UPSTREAM_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${UPSTREAM_PORT}` } };
  const up = http.request(opts, upRes => {
    res.writeHead(upRes.statusCode, { ...upRes.headers, "access-control-allow-origin": "*" });
    upRes.pipe(res);
  });
  up.on("error", e => { if (!res.headersSent) json(res, 502, { error: "upstream", message: e.message }); });
  req.pipe(up);
}

const CORS_BASE = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,mcp-protocol-version,mcp-session-id,accept",
  "access-control-max-age": "86400",
};

const server = http.createServer(async (req, res) => {
  try {
    const u = url.parse(req.url, true);
    const path = u.pathname;

    if (req.method === "OPTIONS") { res.writeHead(204, CORS_BASE); return res.end(); }

    if (path === "/health" || path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok\n");
    }

    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, {
        resource: `${ISSUER}/mcp`,
        authorization_servers: [ISSUER],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp"],
        resource_documentation: `${ISSUER}/health`,
      });
    }
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        registration_endpoint: `${ISSUER}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
        scopes_supported: ["mcp"],
      });
    }

    if (path === "/oauth/register" && req.method === "POST") return handleRegister(req, res);
    if (path === "/oauth/authorize" && req.method === "GET") return handleAuthorizeGet(req, res, u.query);
    if (path === "/oauth/authorize" && req.method === "POST") return handleAuthorizePost(req, res);
    if (path === "/oauth/token" && req.method === "POST") return handleToken(req, res);

    if (path === "/mcp" || path.startsWith("/mcp/")) {
      const tok = validateBearer(req);
      if (!tok) {
        res.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": `Bearer realm="mcp", resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
          "access-control-allow-origin": "*",
        });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      return proxyToUpstream(req, res);
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not_found"}');
  } catch (e) {
    console.error("[handler]", e);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  }
});

server.listen(BIND_PORT, BIND_ADDR, () => console.log(`oauth-proxy listening ${BIND_ADDR}:${BIND_PORT} -> 127.0.0.1:${UPSTREAM_PORT} (issuer=${ISSUER})`));
