// ── docker-auth — Authentification Docker Hub pour les pulls exécutés dans le container ──
// Contexte : le CLI docker (et le socket) sont montés dans le container Pi-Web ;
// sans compte configuré, les `docker pull` / `compose pull` anonymes sont soumis
// au rate limit Docker Hub (« toomanyrequests: unauthenticated pull rate limit »).
//
// Sécurité (même esprit que le lot clés API) :
// - le token ne transite JAMAIS en argv ni en variable d'environnement :
//   `docker login --password-stdin` (token écrit sur STDIN) ;
// - fallback sans CLI : écriture directe de ~/.docker/config.json en FUSIONNANT
//   les auths existants (les autres registres ne sont pas écrasés), chmod 600 ;
// - le token n'est jamais renvoyé par l'API ni loggué (logs : user + succès/échec).

import { execFileSync, spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

// ── Emplacement de config.json ──
// Le CLI docker respecte la variable DOCKER_CONFIG (répertoire de config) ;
// on fait pareil pour que le fallback écrive là où le CLI lira.

function dockerConfigFile(): string {
  return path.join(process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker"), "config.json");
}

// Entrée d'authentification utilisée par le CLI pour Docker Hub (registry v1).
const DOCKER_HUB_AUTH_KEY = "https://index.docker.io/v1/";

// ── Login via le CLI docker (token passé par STDIN, jamais en argv/env) ──

function dockerCliAvailable(): boolean {
  try {
    execFileSync("which", ["docker"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

interface CliLoginResult {
  ok: boolean;
  /** true si le binaire docker lui-même est introuvable/inutilisable (ENOENT) */
  enoent?: boolean;
  error?: string;
}

function loginViaCli(username: string, token: string): CliLoginResult {
  try {
    // spawnSync + input : le token transite uniquement par STDIN.
    const res = spawnSync("docker", ["login", "-u", username, "--password-stdin"], {
      input: token + "\n",
      encoding: "utf-8",
    });
    if (res.status === 0) return { ok: true };
    // Dernières lignes de l'erreur docker (utiles : "unauthorized", "network"…).
    // Par prudence, toute occurrence du token est masquée avant retour/log.
    const raw = String(res.stderr || res.stdout || "").trim();
    const detail = raw.split("\n").slice(-3).join(" ").replaceAll(token, "••••");
    return { ok: false, error: detail || `docker login exited with code ${res.status}` };
  } catch (e: any) {
    const enoent = e?.code === "ENOENT";
    return { ok: false, enoent, error: String(e?.message || e).replaceAll(token, "••••") };
  }
}

// ── Fallback : écriture directe de config.json ──
// Fusion : on conserve les autres registres authentifiés ainsi que les champs
// additionnels de l'entrée docker.io (ex. identitytoken). Seul le champ `auth`
// de l'entrée Docker Hub est (ré)écrit.

function writeAuthToFallback(username: string, token: string): { ok: boolean; error?: string } {
  try {
    const file = dockerConfigFile();
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let config: any = {};
    if (existsSync(file)) {
      try {
        config = JSON.parse(readFileSync(file, "utf-8"));
      } catch {
        // Fichier corrompu/illisible → on repart d'un objet vide (l'entrée
        // Docker Hub sera réécrite, les autres auths étaient déjà illisibles).
        config = {};
      }
    }
    config.auths = config.auths && typeof config.auths === "object" ? config.auths : {};
    config.auths[DOCKER_HUB_AUTH_KEY] = {
      ...(typeof config.auths[DOCKER_HUB_AUTH_KEY] === "object" && config.auths[DOCKER_HUB_AUTH_KEY] !== null
        ? config.auths[DOCKER_HUB_AUTH_KEY]
        : {}),
      auth: Buffer.from(`${username}:${token}`, "utf-8").toString("base64"),
    };
    // mode 0o600 à la création + chmod explicite si le fichier pré-existait.
    writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* déjà 600 via le mode d'écriture */
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).replaceAll(token, "••••") };
  }
}

// ── API publique ──

export interface DockerHubLoginResult {
  ok: boolean;
  method: "cli" | "config" | null;
  error?: string;
}

export function ensureDockerHubLogin(username: string, token: string): DockerHubLoginResult {
  if (dockerCliAvailable()) {
    const cli = loginViaCli(username, token);
    if (cli.ok) {
      console.log(`[docker-auth] docker login OK (cli) user=${username}`);
      return { ok: true, method: "cli" };
    }
    // Identifiants refusés / réseau → échec final (on ne persiste pas des
    // identifiants invalides en silence). Binaire inutilisable (ENOENT) →
    // on tente quand même le fallback config.json.
    if (!cli.enoent) {
      console.warn(`[docker-auth] docker login (cli) FAILED user=${username}`);
      return { ok: false, method: "cli", error: cli.error };
    }
    console.warn(`[docker-auth] docker CLI unusable, falling back to config.json (user=${username})`);
  }
  const fallback = writeAuthToFallback(username, token);
  if (fallback.ok) {
    console.log(`[docker-auth] docker hub auth written to config.json user=${username}`);
    return { ok: true, method: "config" };
  }
  console.error(`[docker-auth] docker hub auth FAILED user=${username}: ${fallback.error}`);
  return { ok: false, method: null, error: fallback.error };
}

export interface DockerHubStatus {
  configured: boolean;
  /** username décodé du base64 user:token — le token n'est jamais exposé */
  username: string | null;
}

export function getDockerHubStatus(): DockerHubStatus {
  try {
    const file = dockerConfigFile();
    if (!existsSync(file)) return { configured: false, username: null };
    const config = JSON.parse(readFileSync(file, "utf-8"));
    const entry = config?.auths?.[DOCKER_HUB_AUTH_KEY];
    if (!entry?.auth || typeof entry.auth !== "string") return { configured: false, username: null };
    // auth = base64("user:token") → on ne décode QUE le username.
    const decoded = Buffer.from(entry.auth, "base64").toString("utf-8");
    const sep = decoded.indexOf(":");
    if (sep <= 0) return { configured: true, username: null };
    return { configured: true, username: decoded.slice(0, sep) };
  } catch {
    return { configured: false, username: null };
  }
}