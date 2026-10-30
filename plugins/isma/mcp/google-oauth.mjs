import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

import { BetaError } from "./core.mjs";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/presentations",
];

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

export function readGoogleOAuthClient(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new BetaError("GOOGLE_OAUTH_CLIENT_MISSING", "The approved company Google OAuth client is not installed in the private beta configuration.");
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const client = raw.installed || raw.web || raw;
  if (!client.client_id || !client.client_secret) {
    throw new BetaError("GOOGLE_OAUTH_CLIENT_INVALID", "The private Google OAuth client configuration is incomplete.");
  }
  return { client_id: client.client_id, client_secret: client.client_secret };
}

export function createAuthorizationUrl({ clientId, redirectUri, state, verifier, scopes = GOOGLE_SCOPES }) {
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new BetaError("GOOGLE_AUTH_FAILED", "Google authorization failed.", { status: response.status, error: body.error || null });
  }
  return body;
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export async function authorizeGoogleDesktop({ clientPath, tokenPath, openBrowser = true, timeoutMs = 300000, scopes = GOOGLE_SCOPES }) {
  const client = readGoogleOAuthClient(clientPath);
  const verifier = base64url(crypto.randomBytes(48));
  const state = base64url(crypto.randomBytes(24));
  let settle;
  const callback = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== "/oauth2callback") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<p>Google sign-in is complete. Return to Codex.</p>");
    if (url.searchParams.get("state") !== state) settle.reject(new BetaError("GOOGLE_AUTH_STATE_MISMATCH", "Google sign-in could not be verified."));
    else if (!url.searchParams.get("code")) settle.reject(new BetaError("GOOGLE_AUTH_FAILED", "Google did not return an authorization code."));
    else settle.resolve(url.searchParams.get("code"));
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const authorizationUrl = createAuthorizationUrl({ clientId: client.client_id, redirectUri, state, verifier, scopes });
  if (openBrowser) spawn("open", [authorizationUrl], { detached: true, stdio: "ignore" }).unref();
  const timer = setTimeout(() => settle.reject(new BetaError("GOOGLE_AUTH_TIMEOUT", "Google sign-in timed out.")), timeoutMs);
  try {
    const code = await callback;
    const tokens = await jsonFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
    if (!tokens.refresh_token) throw new BetaError("GOOGLE_REFRESH_TOKEN_MISSING", "Google did not issue a refresh token. Revoke the previous grant and retry.");
    const identity = await jsonFetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!identity.sub || !identity.email_verified) throw new BetaError("GOOGLE_IDENTITY_UNVERIFIED", "The signed-in Google identity could not be verified.");
    writePrivateJson(tokenPath, {
      schema_version: "1.0",
      refresh_token: tokens.refresh_token,
      scopes,
      subject_ref: crypto.createHash("sha256").update(identity.sub).digest("hex"),
      created_at: new Date().toISOString(),
    });
    return { state: "connected", private_draft_scope_verified: true, subject_ref: crypto.createHash("sha256").update(identity.sub).digest("hex") };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

export async function googleAccessToken({ clientPath, tokenPath }) {
  const client = readGoogleOAuthClient(clientPath);
  if (!fs.existsSync(tokenPath)) throw new BetaError("GOOGLE_SIGN_IN_REQUIRED", "Google sign-in is required.");
  const stored = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  const tokens = await jsonFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: stored.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  return tokens.access_token;
}
