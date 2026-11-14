/**
 * Frontend Protected Route Guard & JWT Expiry Inspector for Sharely.
 * Enforces explicit allow-lists for public routes vs authenticated routes across
 * Mobile screens and Web/Extension viewports.
 */

export const PUBLIC_SCREENS = Object.freeze([
  "login",
  "emailLogin",
  "checkEmail",
  "inviteLanding",
]);

export const GUEST_ONLY_SCREENS = Object.freeze([
  "login",
  "emailLogin",
  "checkEmail",
]);

export const PROTECTED_SCREENS = Object.freeze([
  "home",
  "folders",
  "folderDetail",
  "linkDetail",
  "savedPreview",
  "ai",
  "profile",
  "display",
  "security",
  "help",
]);

export const PROTECTED_VIEWPORTS = Object.freeze(["web", "extension"]);

export function isPublicScreen(screen) {
  return PUBLIC_SCREENS.includes(screen);
}

export function isProtectedScreen(screen) {
  return PROTECTED_SCREENS.includes(screen) || !isPublicScreen(screen);
}

export function isProtectedViewport(viewportMode) {
  return PROTECTED_VIEWPORTS.includes(viewportMode);
}

export function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json =
      typeof atob === "function"
        ? decodeURIComponent(
            Array.prototype.map
              .call(atob(padded), (ch) => "%" + ("00" + ch.charCodeAt(0).toString(16)).slice(-2))
              .join("")
          )
        : Buffer.from(padded, "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export function decodeJwtHeader(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf8");
    const header = JSON.parse(json);
    return header && typeof header === "object" ? header : null;
  } catch {
    return null;
  }
}

export function isJwtExpired(token, nowMs = Date.now()) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return false;
  return payload.exp * 1000 <= nowMs;
}

export function getAuthMode(state) {
  const api = state?.api || {};
  if (api.authProvider === "supabase") return "supabase";
  if (api.mode === "live" || api.authProvider === "backend") return "backend";
  return "mock";
}

export function hasValidSession(state, nowMs = Date.now()) {
  const isAuth = Boolean(state?.data?.user?.isAuthenticated);
  if (!isAuth) return false;

  const authMode = getAuthMode(state);
  if (authMode === "mock") {
    return true;
  }

  const token = String(state?.api?.bearerToken || "").trim();
  if (token) {
    if (isJwtExpired(token, nowMs)) return false;
    return true;
  }

  if (authMode === "backend" && state?.api?.useDevBypass && String(state?.api?.userId || "").trim()) {
    return true;
  }
  return false;
}

export function guardNavigation({
  targetScreen,
  targetViewport = "mobile",
  state,
  allowGuestSwitch = false,
  nowMs = Date.now(),
}) {
  const guardEnabled = state?.ui?.authGuardEnabled !== false;
  const nextScreen = targetScreen || state?.ui?.screen || "login";
  const nextViewport = targetViewport || state?.ui?.viewportMode || "mobile";

  if (!guardEnabled) {
    return {
      allowed: true,
      screen: nextScreen,
      viewportMode: nextViewport,
      reason: "guard_disabled",
    };
  }

  const authenticated = hasValidSession(state, nowMs);
  const needsAuth = isProtectedScreen(nextScreen) || isProtectedViewport(nextViewport);

  if (needsAuth && !authenticated) {
    return {
      allowed: false,
      reason: "authentication_required",
      redirectScreen: "login",
      redirectViewport: "mobile",
      intendedRoute: {
        screen: isProtectedScreen(nextScreen) ? nextScreen : "home",
        viewportMode: nextViewport,
      },
    };
  }

  if (authenticated && !allowGuestSwitch && GUEST_ONLY_SCREENS.includes(nextScreen) && nextViewport === "mobile") {
    return {
      allowed: false,
      reason: "already_authenticated",
      redirectScreen: "home",
      redirectViewport: "mobile",
      intendedRoute: null,
    };
  }

  return {
    allowed: true,
    screen: nextScreen,
    viewportMode: nextViewport,
    reason: "allowed",
  };
}
