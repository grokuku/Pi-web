/**
 * Validation SSRF minimale pour les fetch serveur vers des URL fournies par
 * l'utilisateur (Ollama, test de provider).
 *
 * Règles :
 *  - protocole http/https uniquement ;
 *  - les adresses lien-local (ex: 169.254.169.254 cloud metadata) sont toujours
 *    bloquées ;
 *  - les adresses loopback/privées sont bloquées par défaut, sauf quand l'appelant
 *    les autorise explicitement (ex: Ollama local/LAN, serveurs OpenAI-compatible
 *    auto-hébergés).
 *
 * Limite connue : la résolution DNS est faite au moment de la validation, puis
 * fetch utilise l'URL d'origine ; une protection complète contre le DNS rebinding
 * nécessiterait de forcer la résolution et de réécrire l'URL (non requis ici).
 */

import { lookup } from "dns/promises";
import { isIP } from "net";

export interface SsrfOptions {
  allowPrivate?: boolean;
  allowLoopback?: boolean;
  allowLinkLocal?: boolean;
}

/** Retire les crochets d'une IPv6 renvoyée par URL.hostname. */
function stripBrackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/** Convertit une IP (y compris IPv4-mapped IPv6) en octets IPv4, sinon null. */
function toIpv4(ip: string): number[] | null {
  let v4 = ip;
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    v4 = lower.slice(7);
  }
  if (isIP(v4) !== 4) return null;
  const parts = v4.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
}

function isLoopbackIp(ip: string): boolean {
  const v4 = toIpv4(ip);
  if (v4) return v4[0] === 127;
  return ip.toLowerCase() === "::1";
}

function isLinkLocalIp(ip: string): boolean {
  const v4 = toIpv4(ip);
  if (v4) return v4[0] === 169 && v4[1] === 254;
  // fe80::/10 → fe80-febf
  return /^fe[89ab]/i.test(ip);
}

function isPrivateIp(ip: string): boolean {
  const v4 = toIpv4(ip);
  if (v4) {
    const [a, b] = v4;
    // RFC1918 + 0.0.0.0/8 (non routable)
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
  }
  // fc00::/7 (adresses locales uniques IPv6)
  return /^f[cd]/i.test(ip);
}

/**
 * Valide une URL http/https et bloque les adresses sensibles.
 * Retourne l'URL normalisée.
 */
export async function validateHttpUrl(rawUrl: string, options: SsrfOptions = {}): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }

  const hostname = stripBrackets(url.hostname);
  if (!hostname) throw new Error("URL must include a hostname");

  let ips: string[];
  const direct = isIP(hostname);
  if (direct) {
    ips = [hostname];
  } else {
    try {
      const results = await lookup(hostname, { all: true });
      ips = results.map((r) => r.address);
    } catch (e: any) {
      throw new Error(`DNS resolution failed for hostname: ${hostname}`);
    }
  }

  for (const ip of ips) {
    if (isLinkLocalIp(ip) && !options.allowLinkLocal) {
      throw new Error(`Blocked link-local address: ${ip}`);
    }
    if (isLoopbackIp(ip) && !options.allowLoopback) {
      throw new Error(`Blocked loopback address: ${ip}`);
    }
    if (isPrivateIp(ip) && !options.allowPrivate) {
      throw new Error(`Blocked private address: ${ip}`);
    }
  }

  return url.toString();
}
