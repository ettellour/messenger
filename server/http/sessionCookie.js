const SESSION_COOKIE = "sid";

export function readSessionToken(req) {
  for (const pair of (req.headers.cookie ?? "").split(";")) {
    const [name, value] = pair.trim().split("=");
    if (name === SESSION_COOKIE) {
      return value;
    }
  }
  return null;
}

export function buildSessionCookie(token, maxAgeSeconds, { secure }) {
  const cookie = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
  return secure ? `${cookie}; Secure` : cookie;
}
