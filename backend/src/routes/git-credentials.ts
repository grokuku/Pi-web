import { Router, type Response } from "express";
import type { Request } from "../utils/http-types.js";
import { credentialStore } from "../projects/credential-store.js";

/**
 * Effacement des identifiants git PAR HÔTE.
 *
 * Pourquoi cette route existe (en plus de `DELETE /api/projects/:id/git/credentials`) :
 * le credentialStore est indexé par HOSTNAME (« github.com »), pas par dépôt.
 * Un seul jeton couvre donc TOUS les dépôts du même hôte. Or la route par
 * projet exige un projet enregistré et un origin lisible : impossible de
 * nettoyer l'hôte quand le dépôt est cassé/introuvable ou quand on veut
 * simplement repartir d'un jeton neuf (ex. token GitHub sans le scope
 * `workflow` : le push échoue et il faut changer le token).
 *
 * AUCUNE valeur de jeton n'est jamais renvoyée ni journalisée : seulement
 * l'hôte et le fait qu'il y avait (ou non) un jeton.
 */
const router = Router();

// Hostname : lettres/chiffres/tirets/points, pas de schéma, pas de chemin.
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

function normalizeHost(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

// GET /api/git-credentials/hosts → hôtes ayant un jeton enregistré.
router.get("/hosts", (_req: Request, res: Response) => {
  res.json({ hosts: credentialStore.listHosts() });
});

// DELETE /api/git-credentials/:host → efface le jeton de TOUS les dépôts de l'hôte.
router.delete("/:host", (req: Request, res: Response) => {
  const host = normalizeHost(req.params.host);
  if (!HOST_PATTERN.test(host)) {
    return res.status(400).json({ error: "Invalid host", code: "GIT_CREDENTIALS_INVALID_HOST" });
  }
  const removed = credentialStore.has(host);
  credentialStore.delete(host);
  // `removed: false` = il n'y avait rien à oublier (l'appelant peut le dire
  // honnêtement à l'utilisateur au lieu d'afficher un faux succès).
  res.json({ success: true, host, removed });
});

export default router;
