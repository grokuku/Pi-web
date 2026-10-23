/**
 * http-types.ts — type `Request` d'Express 5 en « params plats ».
 *
 * POURQUOI CE MODULE :
 * En Express 5, `@types/express-serve-static-core` élargit `ParamsDictionary` à
 * `string | string[]` — parce qu'un motif joker (`*splat`) produit un TABLEAU de
 * segments dans `req.params`. Pi-Web n'utilise AUCUN motif joker : toutes ses
 * routes déclarent des paramètres nommés (`/:id`, `/:projectId/sessions/:sid`),
 * qui valent TOUJOURS une chaîne à l'exécution (`req.params.id: string`).
 *
 * Sans cet alias, chaque `req.params.id` remonte en `string | string[]` et il
 * faudrait des assertions de type à chaque usage (bruit sans gain de sûreté).
 *
 * PORTÉE : strictement typographique — rien n'est modifié au runtime. Seul le
 * type du paramètre d'URL est resserré ; `ResBody`, `ReqBody`, `ReqQuery`
 * (= `ParsedQs`) et `Locals` gardent les défauts d'Express.
 *
 * ⚠️ Si une route venait à utiliser un motif joker (`/*splat`), elle NE doit PAS
 * utiliser ce type : `req.params.splat` y serait un tableau.
 */
import type { Request as ExpressRequest } from "express";

/** Paramètres d'URL d'une route à paramètres nommés (toujours des chaînes). */
export type FlatParams = Record<string, string>;

/** `Request` Express 5 dont `req.params` est un dictionnaire plat de chaînes. */
export type Request<
  P = FlatParams,
  ResBody = any,
  ReqBody = any,
> = ExpressRequest<P, ResBody, ReqBody>;
