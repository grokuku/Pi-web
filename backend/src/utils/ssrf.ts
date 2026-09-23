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

/**
 * Parse une IPv6 en tableau de 8 groupes 16 bits.
 * Gère la compression `::`, le suffixe de zone (`fe80::1%eth0`) et la queue
 * IPv4 pointée (`::ffff:127.0.0.1` → les 2 derniers groupes).
 * Retourne null si ce n'est pas une IPv6 valide.
 */
function parseIpv6Groups(ip: string): number[] | null {
  let addr = ip.split("%")[0].toLowerCase(); // retrait de la zone d'interface

  // Queue IPv4 pointée (ex. ::ffff:1.2.3.4) → 2 groupes hexadécimaux.
  const v4Tail = addr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail) {
    const parts = v4Tail[1].split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const g1 = ((parts[0] << 8) | parts[1]).toString(16);
    const g2 = ((parts[2] << 8) | parts[3]).toString(16);
    addr = addr.slice(0, addr.length - v4Tail[1].length) + g1 + ":" + g2;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null; // au plus un seul `::`
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groupRe = /^[0-9a-f]{1,4}$/;
  if (!head.every((g) => groupRe.test(g)) || !tail.every((g) => groupRe.test(g))) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [
    ...head.map((g) => parseInt(g, 16)),
    ...Array(missing).fill(0),
    ...tail.map((g) => parseInt(g, 16)),
  ];
}

/** Convertit une IP (y compris IPv4-mapped IPv6) en octets IPv4, sinon null. */
function toIpv4(ip: string): number[] | null {
  // 1) Forme textuelle `::ffff:a.b.c.d` (reconnue par isIP). SEC-04 : la forme
  //    hexadécimale normalisée par Node (`::ffff:a9fe:a9fe` pour
  //    http://[::ffff:169.254.169.254]) est gérée par le parseur ci-dessous.
  const lower = ip.toLowerCase();
  const v4 = lower.startsWith("::ffff:") ? lower.slice(7) : lower;
  if (isIP(v4) === 4) {
    const parts = v4.split(".").map(Number);
    if (parts.length === 4 && parts.every((n) => !Number.isNaN(n) && n >= 0 && n <= 255)) {
      return parts;
    }
  }
  // 2) Formes hexadécimales : IPv4-mapped (::ffff:0:0/96) — 32 derniers bits
  //    = IPv4 embarquée. NB : la forme dépréciée IPv4-compatible (::w.x.y.z)
  //    n'est PAS traitée ici afin de préserver la sémantique de ::1 (loopback)
  //    et des options allow* (comportement inchangé sur l'usage).
  const groups = parseIpv6Groups(ip);
  if (!groups) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [(groups[6] >> 8) & 0xff, groups[6] & 0xff, (groups[7] >> 8) & 0xff, groups[7] & 0xff];
  }
  return null;
}

/**
 * Extrait l'IPv4 embarquée des plages de transition IPv6 (SEC-04) :
 *  - 6to4 (2002::/16) : IPv4 dans les groupes 1-2 ;
 *  - Teredo (2001:0::/32) : IPv4 client obfusquée (XOR 0xFFFF) dans les groupes 6-7 ;
 *  - NAT64 well-known (64:ff9b::/96) et local-use (64:ff9b:1::/96) : groupes 6-7.
 * Sinon null (pas une plage de transition).
 */
function extractTransitionIpv4(ip: string): number[] | null {
  const g = parseIpv6Groups(ip);
  if (!g) return null;
  const byte = (h: number, l: number): number[] => [(h >> 8) & 0xff, h & 0xff, (l >> 8) & 0xff, l & 0xff];
  if (g[0] === 0x2002) {
    return byte(g[1], g[2]); // 6to4
  }
  if (g[0] === 0x2001 && g[1] === 0) {
    return byte(g[6] ^ 0xffff, g[7] ^ 0xffff); // Teredo (obfuscation XOR 0xFFFF, RFC 4380)
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return byte(g[6], g[7]); // NAT64 well-known
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return byte(g[6], g[7]); // NAT64 local-use (RFC 8215)
  }
  return null;
}

/**
 * IPv4 effective d'une adresse : extraction directe (mapped) puis plages de
 * transition. Utilisée par les vérifications de sensibilité ci-dessous.
 */
function effectiveIpv4(ip: string): number[] | null {
  return toIpv4(ip) ?? extractTransitionIpv4(ip);
}

function isLoopbackIp(ip: string): boolean {
  const v4 = effectiveIpv4(ip);
  if (v4) return v4[0] === 127;
  return ip.toLowerCase() === "::1";
}

function isLinkLocalIp(ip: string): boolean {
  const v4 = effectiveIpv4(ip);
  if (v4) return v4[0] === 169 && v4[1] === 254;
  // fe80::/10 → fe80-febf
  return /^fe[89ab]/i.test(ip);
}

function isPrivateIp(ip: string): boolean {
  const v4 = effectiveIpv4(ip);
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
