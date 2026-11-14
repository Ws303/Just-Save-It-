/**
 * Supabase Auth Browser Client Wrapper for Sharely.
 * Connects to live Supabase Auth (https://pnqjamwhgzqzvpiytcln.supabase.co)
 * using @supabase/supabase-js ESM (with direct GoTrue HTTP fallback),
 * verifies/reads claims via supabase.auth.getClaims(), and synchronizes
 * authenticated sessions & tokens with the Sharely store.
 */
import { decodeJwtHeader, decodeJwtPayload } from "./routeGuard.js";

export const DEFAULT_SUPABASE_URL = "https://pnqjamwhgzqzvpiytcln.supabase.co";
export const DEFAULT_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBucWphbXdoZ3pxenZwaXl0Y2xuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2NjAzMjIsImV4cCI6MjExMDIzNjMyMn0.4RfZtHD9-23dSQw2P6tWRz45mty5BumKWAKKBifbebw";
const SUPABASE_ESM_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

let _cachedClient = null;
let _cachedConfigKey = "";
let _authSubscription = null;

function normalizeUrl(url) {
  return String(url || DEFAULT_SUPABASE_URL).trim().replace(/\/+$/, "");
}

function buildConfigKey(url, key) {
  return `${normalizeUrl(url)}::${String(key || "").trim()}`;
}

export async function getSupabaseBrowserClient({ supabaseUrl, supabaseAnonKey } = {}) {
  const url = normalizeUrl(supabaseUrl);
  const anonKey = String(supabaseAnonKey || DEFAULT_SUPABASE_KEY).trim();
  const key = buildConfigKey(url, anonKey);
  if (_cachedClient && _cachedConfigKey === key) {
    return _cachedClient;
  }

  try {
    const mod = await import(SUPABASE_ESM_URL);
    if (typeof mod?.createClient === "function") {
      _cachedClient = mod.createClient(url, anonKey, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
        },
      });
      _cachedConfigKey = key;
      return _cachedClient;
    }
  } catch {
    // Offline / CSP environment: callers cleanly fall back to direct GoTrue REST calls.
  }
  return null;
}

export function extractClaimsSummary(accessToken, fallbackClaims = null) {
  const header = decodeJwtHeader(accessToken);
  const payload = fallbackClaims || decodeJwtPayload(accessToken);
  if (!payload) return null;
  return {
    alg: header?.alg || null,
    kid: header?.kid || null,
    sub: payload.sub || null,
    email: payload.email || null,
    role: payload.role || "authenticated",
    iss: payload.iss || null,
    aud: payload.aud || null,
    exp: payload.exp || null,
    expIso: typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null,
  };
}

function extractUserSummary(user, claims = null) {
  if (!user && !claims) return null;
  const meta = user?.user_metadata || {};
  const email = user?.email || claims?.email || "";
  const displayName =
    meta.display_name || meta.full_name || meta.name || (email ? email.split("@")[0] : "ผู้ใช้ Sharely");
  return {
    id: user?.id || claims?.sub || "",
    email,
    display_name: displayName,
    tier: "free",
  };
}

async function fetchGoTrueJson({ supabaseUrl, supabaseAnonKey, path, method = "POST", body = null, accessToken = "" }) {
  const url = `${normalizeUrl(supabaseUrl)}/auth/v1${path}`;
  const anonKey = String(supabaseAnonKey || DEFAULT_SUPABASE_KEY).trim();
  const headers = {
    apikey: anonKey,
    "Content-Type": "application/json",
  };
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: body !== null && method !== "GET" ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { msg: text };
  }
  if (!resp.ok) {
    const errMsg = parsed.error_description || parsed.msg || parsed.message || `HTTP ${resp.status}`;
    return { ok: false, status: resp.status, error: errMsg, data: parsed };
  }
  return { ok: true, status: resp.status, data: parsed };
}

export const supabaseAuth = {
  async init(config, onSessionUpdate) {
    const client = await getSupabaseBrowserClient(config);
    if (!client) return { sdkLoaded: false, session: null };

    if (_authSubscription && typeof _authSubscription.unsubscribe === "function") {
      _authSubscription.unsubscribe();
      _authSubscription = null;
    }

    const { data: listenerData } = client.auth.onAuthStateChange(async (event, session) => {
      if (typeof onSessionUpdate !== "function") return;
      let claims = null;
      if (session?.access_token && typeof client.auth.getClaims === "function") {
        try {
          const claimsRes = await client.auth.getClaims();
          claims = claimsRes?.data?.claims || null;
        } catch {
          claims = null;
        }
      }
      onSessionUpdate({
        event,
        session,
        claims: session?.access_token ? extractClaimsSummary(session.access_token, claims) : null,
        user: session ? extractUserSummary(session.user, claims) : null,
      });
    });
    _authSubscription = listenerData?.subscription || null;

    const { data, error } = await client.auth.getSession();
    const session = !error ? data?.session : null;
    let claims = null;
    if (session?.access_token && typeof client.auth.getClaims === "function") {
      try {
        const claimsRes = await client.auth.getClaims();
        claims = claimsRes?.data?.claims || null;
      } catch {
        claims = null;
      }
    }
    return {
      sdkLoaded: true,
      session,
      claims: session?.access_token ? extractClaimsSummary(session.access_token, claims) : null,
      user: session ? extractUserSummary(session.user, claims) : null,
    };
  },

  async signUpWithPassword(config, { email, password, displayName }) {
    const cleanEmail = String(email || "").trim();
    const cleanName = String(displayName || "").trim() || cleanEmail.split("@")[0];
    const client = await getSupabaseBrowserClient(config);

    if (client) {
      const redirectTo = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : undefined;
      const { data, error } = await client.auth.signUp({
        email: cleanEmail,
        password,
        options: {
          emailRedirectTo: redirectTo,
          data: {
            display_name: cleanName,
            full_name: cleanName,
          },
        },
      });
      if (error) {
        return { ok: false, status: error.status || 400, error: error.message, data: null };
      }
      const session = data?.session || null;
      return {
        ok: true,
        status: session ? 201 : 200,
        data: {
          access_token: session?.access_token || "",
          refresh_token: session?.refresh_token || "",
          token_type: "bearer",
          needs_email_confirmation: !session,
          user: extractUserSummary(data?.user),
          claims: session?.access_token ? extractClaimsSummary(session.access_token) : null,
        },
      };
    }

    const res = await fetchGoTrueJson({
      ...config,
      path: "/signup",
      method: "POST",
      body: {
        email: cleanEmail,
        password,
        data: { display_name: cleanName, full_name: cleanName },
      },
    });
    if (!res.ok) return res;
    const accessToken = res.data?.access_token || "";
    return {
      ok: true,
      status: accessToken ? 201 : 200,
      data: {
        access_token: accessToken,
        refresh_token: res.data?.refresh_token || "",
        token_type: "bearer",
        needs_email_confirmation: !accessToken,
        user: extractUserSummary(res.data?.user || res.data),
        claims: accessToken ? extractClaimsSummary(accessToken) : null,
      },
    };
  },

  async signInWithPassword(config, { email, password }) {
    const cleanEmail = String(email || "").trim();
    const client = await getSupabaseBrowserClient(config);

    if (client) {
      const { data, error } = await client.auth.signInWithPassword({ email: cleanEmail, password });
      if (error) {
        return { ok: false, status: error.status || 401, error: error.message, data: null };
      }
      const session = data?.session;
      return {
        ok: true,
        status: 200,
        data: {
          access_token: session?.access_token || "",
          refresh_token: session?.refresh_token || "",
          token_type: "bearer",
          user: extractUserSummary(data?.user),
          claims: session?.access_token ? extractClaimsSummary(session.access_token) : null,
        },
      };
    }

    const res = await fetchGoTrueJson({
      ...config,
      path: "/token?grant_type=password",
      method: "POST",
      body: { email: cleanEmail, password },
    });
    if (!res.ok) return res;
    const accessToken = res.data?.access_token || "";
    return {
      ok: true,
      status: 200,
      data: {
        access_token: accessToken,
        refresh_token: res.data?.refresh_token || "",
        token_type: "bearer",
        user: extractUserSummary(res.data?.user),
        claims: accessToken ? extractClaimsSummary(accessToken) : null,
      },
    };
  },

  async signInWithMagicLink(config, { email }) {
    const cleanEmail = String(email || "").trim();
    const redirectTo = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : undefined;
    const client = await getSupabaseBrowserClient(config);

    if (client) {
      const { error } = await client.auth.signInWithOtp({
        email: cleanEmail,
        options: { emailRedirectTo: redirectTo },
      });
      if (error) {
        return { ok: false, status: error.status || 400, error: error.message, data: null };
      }
      return { ok: true, status: 200, data: { sent: true, email: cleanEmail, needs_email_confirmation: true } };
    }

    const res = await fetchGoTrueJson({
      ...config,
      path: "/otp",
      method: "POST",
      body: { email: cleanEmail, create_user: true },
    });
    if (!res.ok) return res;
    return { ok: true, status: 200, data: { sent: true, email: cleanEmail, needs_email_confirmation: true } };
  },

  async signInWithGoogle(config) {
    const redirectTo = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : "http://localhost:5173";
    const client = await getSupabaseBrowserClient(config);

    if (client) {
      const { data, error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (error) {
        return { ok: false, status: error.status || 400, error: error.message, data: null };
      }
      return { ok: true, status: 200, data: { provider: "google", url: data?.url || null } };
    }

    const url = `${normalizeUrl(config?.supabaseUrl)}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
    return { ok: true, status: 200, data: { provider: "google", url } };
  },

  async refreshSession(config, refreshToken = "") {
    const client = await getSupabaseBrowserClient(config);
    if (client) {
      const { data, error } = refreshToken
        ? await client.auth.refreshSession({ refresh_token: refreshToken })
        : await client.auth.refreshSession();
      if (error || !data?.session?.access_token) {
        return { ok: false, status: error?.status || 401, error: error?.message || "Session refresh failed" };
      }
      const s = data.session;
      return {
        ok: true,
        status: 200,
        data: {
          access_token: s.access_token,
          refresh_token: s.refresh_token,
          user: extractUserSummary(data.user || s.user),
          claims: extractClaimsSummary(s.access_token),
        },
      };
    }

    if (!refreshToken) return { ok: false, status: 401, error: "Missing refresh token" };
    const res = await fetchGoTrueJson({
      ...config,
      path: "/token?grant_type=refresh_token",
      method: "POST",
      body: { refresh_token: refreshToken },
    });
    if (!res.ok) return res;
    const accessToken = res.data?.access_token || "";
    return {
      ok: true,
      status: 200,
      data: {
        access_token: accessToken,
        refresh_token: res.data?.refresh_token || refreshToken,
        user: extractUserSummary(res.data?.user),
        claims: accessToken ? extractClaimsSummary(accessToken) : null,
      },
    };
  },

  async getClaimsOrSession(config) {
    const client = await getSupabaseBrowserClient(config);
    if (!client) return { ok: false, error: "Supabase JS SDK unavailable offline" };

    const { data: sessionData, error: sessionErr } = await client.auth.getSession();
    if (sessionErr || !sessionData?.session?.access_token) {
      return { ok: false, error: sessionErr?.message || "No active Supabase session" };
    }
    let claims = null;
    if (typeof client.auth.getClaims === "function") {
      try {
        const claimsRes = await client.auth.getClaims();
        claims = claimsRes?.data?.claims || null;
      } catch {
        claims = null;
      }
    }
    return {
      ok: true,
      data: {
        access_token: sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token,
        user: extractUserSummary(sessionData.session.user, claims),
        claims: extractClaimsSummary(sessionData.session.access_token, claims),
      },
    };
  },

  async updateEmail(config, email) {
    const client = await getSupabaseBrowserClient(config);
    if (!client) return { ok: false, status: 503, error: "Supabase SDK unavailable" };
    const { data, error } = await client.auth.updateUser({ email: String(email || "").trim() });
    if (error) return { ok: false, status: error.status || 400, error: error.message };
    return { ok: true, status: 200, data: { user: extractUserSummary(data?.user) } };
  },

  async resetPasswordForEmail(config, email) {
    const redirectTo = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : undefined;
    const client = await getSupabaseBrowserClient(config);
    if (client) {
      const { error } = await client.auth.resetPasswordForEmail(String(email || "").trim(), { redirectTo });
      if (error) return { ok: false, status: error.status || 400, error: error.message };
      return { ok: true, status: 200, data: { sent: true, email } };
    }
    return fetchGoTrueJson({
      ...config,
      path: "/recover",
      method: "POST",
      body: { email: String(email || "").trim() },
    });
  },

  async signOut(config, accessToken = "") {
    const client = await getSupabaseBrowserClient(config);
    if (client) {
      await client.auth.signOut();
      return { ok: true, status: 200, data: { logged_out: true } };
    }
    if (accessToken) {
      await fetchGoTrueJson({
        ...config,
        path: "/logout",
        method: "POST",
        body: {},
        accessToken,
      }).catch(() => {});
    }
    return { ok: true, status: 200, data: { logged_out: true } };
  },
};
