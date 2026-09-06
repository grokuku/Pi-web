import { Keyboard, Send, Wrench } from "lucide-react";

// ── Shortcuts Tab ────────────────────────────────────────────
function ShortcutsTab() {
  // Each shortcut: label, keys (display strings), description, scope, icon
  type Shortcut = { keys: string[]; desc: string; scope: "global" | "chat" | "modal" };
  type Category = { name: string; icon: React.ReactNode; shortcuts: Shortcut[] };

  const CATEGORIES: Category[] = [
    {
      name: "Application",
      icon: <Keyboard size={12} />,
      shortcuts: [
        { keys: ["Ctrl", "L"], desc: "Ouvrir Settings", scope: "global" },
        { keys: ["Ctrl", "Shift", "D"], desc: "Toggle debug overlay", scope: "global" },
        { keys: ["Esc"], desc: "Fermer modale / viewer / abort", scope: "global" },
      ],
    },
    {
      name: "Chat",
      icon: <Send size={12} />,
      shortcuts: [
        { keys: ["Ctrl", "T"], desc: "Expand/Collapse toutes les réflexions", scope: "chat" },
        { keys: ["Shift", "Tab"], desc: "Cycle niveau de réflexion (off→high)", scope: "chat" },
        { keys: ["Enter"], desc: "Envoyer le message", scope: "chat" },
        { keys: ["Shift", "Enter"], desc: "Nouvelle ligne dans le message", scope: "chat" },
      ],
    },
    {
      name: "Modales",
      icon: <Wrench size={12} />,
      shortcuts: [
        { keys: ["Enter"], desc: "Confirmer / sauvegarder", scope: "modal" },
        { keys: ["Esc"], desc: "Fermer la modale", scope: "modal" },
      ],
    },
  ];

  const renderKey = (k: string) => (
    <kbd
      key={k}
      className="inline-block px-1.5 py-0.5 text-[10px] font-mono bg-hacker-bg border border-hacker-border-bright rounded text-hacker-text-bright shadow-[inset_0_-1px_0_rgba(0,0,0,0.3)]"
    >
      {k}
    </kbd>
  );

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <div className="text-[11px] text-hacker-text-dim">
        Liste des raccourcis clavier disponibles dans Pi-Web. Certains raccourcis peuvent
        entrer en conflit avec le navigateur (voir <span className="text-hacker-warn">⚠</span>).
      </div>

      {CATEGORIES.map((cat) => (
        <div key={cat.name} className="border border-hacker-border bg-hacker-surface/50">
          <div className="px-3 py-2 border-b border-hacker-border bg-hacker-bg/50 flex items-center gap-2">
            <span className="text-hacker-accent">{cat.icon}</span>
            <span className="text-xs font-bold text-hacker-accent tracking-wider">{cat.name.toUpperCase()}</span>
          </div>
          <div className="p-2">
            <table className="w-full text-[11px] border-collapse">
              <tbody>
                {cat.shortcuts.map((s, i) => {
                  const conflict = s.keys.includes("Ctrl") && s.keys.length === 2 && (s.keys[1] === "L" || s.keys[1] === "T" || s.keys[1] === "O");
                  return (
                    <tr key={i} className="border-b border-hacker-border/20 last:border-0 hover:bg-hacker-bg/30">
                      <td className="py-1.5 pr-3 w-[180px]">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {s.keys.map((k, j) => (
                            <span key={j} className="flex items-center gap-1">
                              {renderKey(k)}
                              {j < s.keys.length - 1 && <span className="text-hacker-text-dim/50 text-[10px]">+</span>}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-1.5 text-hacker-text-dim">
                        {s.desc}
                        {conflict && <span className="ml-2 text-hacker-warn" title="Conflit avec raccourci navigateur">⚠</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div className="text-[10px] text-hacker-text-dim/70 italic border-t border-hacker-border/30 pt-3">
        💡 Les raccourcis sont codés en dur. Une future version permettra de les personnaliser
        (cf. ROADMAP.md → "Onglet Raccourcis clavier dans Settings").
      </div>
    </div>
  );
}

export default ShortcutsTab;
