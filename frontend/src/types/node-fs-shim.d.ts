// Shim TypeScript minimal pour `node:fs`, employé UNIQUEMENT par les tests de
// thème (le projet frontend n'installe pas @types/node). Volontairement limité
// à l'API réellement utilisée pour ne pas masquer d'autres erreurs.
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}
