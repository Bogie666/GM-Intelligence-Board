export function getSafeRedirectPath(candidate: string | null | undefined, fallback = "/"): string {
  if (!candidate || !candidate.startsWith("/") || candidate.includes("\\")) return fallback;
  try {
    const base = new URL("https://application.invalid");
    const destination = new URL(candidate, base);
    if (destination.origin !== base.origin) return fallback;
    if (destination.pathname === "/login" || destination.pathname.startsWith("/auth/")) return fallback;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return fallback;
  }
}
