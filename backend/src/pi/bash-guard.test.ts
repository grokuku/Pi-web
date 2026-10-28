/**
 * bash-guard.test.ts — garde-fou git des appels de l'outil `bash`.
 *
 * Contexte : un sous-agent a exécuté `git reset --mixed HEAD~1` « pour annuler un
 * commit qu'il croyait extérieur » (c'était le commit de l'utilisateur). Ces
 * tests verrouillent trois propriétés :
 *  - les écritures git sont BLOQUÉES, y compris déguisées (préfixes, chaînages,
 *    substitutions, `bash -c`) ;
 *  - les faux positifs sont INTERDITS (texte, `--grep`, chemins) — Pi-Web est en
 *    production, le garde-fou ne doit jamais bloquer une commande légitime ;
 *  - le handler `tool_call` ne s'applique qu'à `bash` et ne plante jamais.
 *
 * Aucun réseau, aucun SDK instancié : module PUR.
 */
import { describe, expect, it, vi } from "vitest";
import { assertGitSafe, GIT_SAFETY_RULES, guardBashToolCall } from "./bash-guard.js";

/** Commandes qui doivent passer. */
const ALLOWED: string[] = [
  // lectures git autorisées
  "git status",
  "git status --short",
  "git diff",
  "git diff HEAD~1 -- src/pi",
  "git log --oneline -20",
  "git log --grep=reset",
  "git show HEAD",
  "git branch",
  "git branch -vv",
  "git branch -a --no-color",
  "git reflog",
  "git reflog show",
  "git stash list",
  "git stash show",
  "git rev-parse HEAD",
  "git ls-files",
  "git blame backend/src/index.ts",
  "git remote -v",
  "git remote show origin",
  "git show-ref",
  "git describe --tags",
  "git cat-file -p HEAD",
  "git shortlog -sn",
  "git grep reset",
  "git version",
  // options globales de git (lues)
  "git -C /projects/Pi-Web log --oneline",
  "git --no-pager diff",
  "git -c core.pager=cat log",
  // préfixes traversés
  "sudo git log --oneline",
  "env FOO=1 git status",
  "timeout 5 git status",
  // chaînages sans git mutateur
  "cd /projects/Pi-Web && git status",
  "git diff | head -50",
  "npx tsc --noEmit && git log -1",
  // texte, commentaires, chemins contenant « reset » / « git »
  'echo "git reset"',
  "echo 'git commit -m x'",
  "printf 'git reset --hard\\n'",
  "grep -rn 'git reset' docs/",
  "rg 'git commit' README.md",
  "cat /tmp/reset.log",
  "ls -la /var/log/reset",
  "cd /tmp/reset && ls -la",
  "touch /tmp/git-reset-notes.md",
  "git diff --word-diff",
  "git log -p -- .github/workflows/reset.yml",
  // commandes banales (non-régression)
  "ls -la",
  "npm run typecheck:extensions",
  "npx vitest run",
  "npx tsc -b",
  "npm install --force",
  "docker compose exec app git status",
  'git log --format="$(date)"',
  "git rev-parse --show-toplevel",
  "cd $(git rev-parse --show-toplevel) && ls",
  "cat package.json",
  "grep -rn TODO backend/src",
  "# git reset --hard (commentaire)",
  "git status # git reset --hard (commentaire)",
];

/** Commandes qui doivent être bloquées. */
const BLOCKED: string[] = [
  // le cœur de l'incident
  "git reset",
  "git reset --hard",
  "git reset --mixed HEAD~1",
  "git reset --soft HEAD^",
  // écritures directes
  "git commit -m 'fix'",
  "git commit",
  "git push",
  "git push origin main",
  "git push --force",
  "git push -f",
  "git checkout -- .",
  "git checkout main",
  "git switch main",
  "git restore .",
  "git restore --staged backend/src",
  "git stash",
  "git stash pop",
  "git rebase -i HEAD~3",
  "git clean -fd",
  "git clean -fdx",
  "git revert HEAD",
  "git cherry-pick abc123",
  "git merge feature",
  "git am patch.mbox",
  "git apply fix.patch",
  "git filter-branch --tree-filter rm",
  "git update-ref refs/heads/main HEAD~1",
  "git gc --aggressive",
  "git prune",
  "git reflog expire --expire=now --all",
  "git reflog delete HEAD@{1}",
  "git branch -D main",
  "git branch -d feature",
  "git branch -m old new",
  "git branch -M main",
  "git add .",
  "git pull",
  "git fetch origin",
  "git tag v1.0.0",
  // déguisements : préfixes, chemins, options globales
  "cd /projects/Yuki && git reset --hard HEAD~1",
  "cd x && git reset",
  "cd x && git reset --mixed HEAD~1",
  "cd /tmp && FOO=1 git reset",
  "git -C /projects/Yuki reset --hard",
  "sudo git push",
  "sudo -u root git reset --hard",
  "env GIT_DIR=/tmp/x git checkout .",
  "env -i git reset --hard",
  "git -c user.name=x commit -m y",
  "xargs git reset",
  "xargs -0 git checkout -- .",
  "timeout 10 git reset --hard",
  "nohup git commit -am x",
  // chaînages
  "git status; git reset --hard",
  "git status && git reset --hard",
  "git status || git reset --hard",
  "git log | xargs git reset",
  // substitutions et scripts
  "echo $(git reset --hard)",
  "echo `git reset --hard`",
  "echo \"$(git reset --hard HEAD~1)\"",
  "bash -c \"git reset --hard\"",
  "sh -c 'git commit -m x'",
  "bash -lc \"git push\"",
  "sudo bash -c 'git reset --hard'",
  "if git reset --hard; then echo ok; fi",
  "for f in a; do git checkout -- .; done",
  // option de forçage sur une lecture
  "git log --force-if-includes",
  "git branch -f main HEAD~1",
];

describe("assertGitSafe — commandes autorisées (aucun faux positif)", () => {
  it.each(ALLOWED)("laisse passer : %s", (command) => {
    const verdict = assertGitSafe(command);
    expect(verdict.block, `${command} → ${verdict.reason ?? ""}`).toBe(false);
    expect(verdict.reason).toBeUndefined();
  });
});

describe("assertGitSafe — commandes bloquées", () => {
  it.each(BLOCKED)("bloque : %s", (command) => {
    const verdict = assertGitSafe(command);
    expect(verdict.block, `${command} aurait dû être bloquée`).toBe(true);
    expect(verdict.reason).toBeTruthy();
  });
});

describe("assertGitSafe — message de refus actionnable", () => {
  it("explique que l'utilisateur gère son historique et qu'un commit inconnu est le sien", () => {
    const verdict = assertGitSafe("git reset --hard HEAD~1");
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain("garde-fou Pi-Web");
    expect(verdict.reason).toContain("L'utilisateur gère seul son historique");
    expect(verdict.reason).toContain("TOUJOURS un travail de l'utilisateur");
    expect(verdict.reason).toContain("git status, diff, log");
  });

  it("cite l'élément déclencheur (reset / force / branche)", () => {
    expect(assertGitSafe("git reset --hard").reason).toContain("reset");
    expect(assertGitSafe("git push --force").reason).toContain("force");
    expect(assertGitSafe("git branch -D main").reason).toContain("branche");
  });
});

describe("assertGitSafe — robustesse", () => {
  it("ne bloque jamais une entrée vide / non-string", () => {
    expect(assertGitSafe("").block).toBe(false);
    expect(assertGitSafe("   ").block).toBe(false);
    expect(assertGitSafe(undefined as unknown as string).block).toBe(false);
    expect(assertGitSafe(null as unknown as string).block).toBe(false);
  });

  it("ne part pas en récursion infinie sur une substitution imbriquée", () => {
    const verdict = assertGitSafe("echo $(echo $(echo $(echo $(echo $(echo hi)))))");
    expect(verdict.block).toBe(false);
  });

  it("est déterministe (fonction pure)", () => {
    const a = assertGitSafe("cd x && git reset --hard");
    const b = assertGitSafe("cd x && git reset --hard");
    expect(a).toEqual(b);
  });
});

describe("guardBashToolCall — handler tool_call", () => {
  it("bloque une écriture git passée à l'outil bash", () => {
    const decision = guardBashToolCall({ toolName: "bash", input: { command: "git reset --hard HEAD~1" } });
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("garde-fou Pi-Web");
  });

  it("laisse passer une commande bash légitime", () => {
    expect(guardBashToolCall({ toolName: "bash", input: { command: "npx vitest run" } })).toBeUndefined();
  });

  it("ne s'applique jamais aux outils hors bash", () => {
    for (const toolName of ["read", "edit", "write", "grep", "find", "ls", "cbm_search"]) {
      expect(
        guardBashToolCall({ toolName, input: { command: "git reset --hard", path: "src/index.ts" } }),
        toolName,
      ).toBeUndefined();
    }
  });

  it("ignore un input sans commande exploitable", () => {
    expect(guardBashToolCall({ toolName: "bash", input: {} })).toBeUndefined();
    expect(guardBashToolCall({ toolName: "bash", input: { command: 42 } })).toBeUndefined();
    expect(guardBashToolCall(undefined)).toBeUndefined();
    expect(guardBashToolCall({})).toBeUndefined();
  });

  it("trace le refus sans jamais faire échouer l'appelant", () => {
    const log = vi.fn();
    guardBashToolCall({ toolName: "bash", input: { command: "git commit -m x" } }, { log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("[bash-guard]");
  });

  it("ne bloque pas et TRACE si le garde-fou lève une erreur interne", () => {
    const log = vi.fn();
    // Commande volontairement pathologique : on vérifie le contrat « jamais planter »
    // en simulant un input dont le getter explose.
    const input = {
      get command(): string {
        throw new Error("boom");
      },
    } as unknown as Record<string, unknown>;
    expect(guardBashToolCall({ toolName: "bash", input }, { log })).toBeUndefined();
    expect(log.mock.calls.some(([msg]) => String(msg).includes("erreur interne"))).toBe(true);
  });

  it("tolère un logger qui explose lui-même", () => {
    const log = () => {
      throw new Error("logger cassé");
    };
    expect(() => guardBashToolCall({ toolName: "bash", input: { command: "git reset" } }, { log })).not.toThrow();
  });
});

describe("GIT_SAFETY_RULES — texte de consigne partagé", () => {
  it("interdit nommément les commandes de l'incident", () => {
    for (const word of ["commit", "push", "reset", "checkout", "restore", "stash", "rebase", "clean", "revert", "cherry-pick", "merge"]) {
      expect(GIT_SAFETY_RULES, word).toContain(`git ${word}`);
    }
    expect(GIT_SAFETY_RULES).toContain("`--force`");
  });

  it("énonce la règle « un commit non reconnu est celui de l'utilisateur »", () => {
    expect(GIT_SAFETY_RULES).toContain("TOUJOURS un travail de\nl'utilisateur");
    expect(GIT_SAFETY_RULES).toContain("ne le défais pas, signale-le");
    expect(GIT_SAFETY_RULES).toContain("L'utilisateur gère seul son historique");
  });

  it("liste les lectures autorisées", () => {
    for (const cmd of ["`git status`", "`diff`", "`log`", "`show`", "`branch -vv`", "`reflog`"]) {
      expect(GIT_SAFETY_RULES, cmd).toContain(cmd);
    }
  });

  it("garde le format des guides existants (bloc Markdown séparé)", () => {
    expect(GIT_SAFETY_RULES.startsWith("\n\n## ")).toBe(true);
  });
});
