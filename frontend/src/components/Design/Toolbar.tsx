import { Undo2, Redo2, Save, Eye, FileDown } from "lucide-react";

interface ToolbarProps {
  onSave?: () => void;
  onExport?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onPreview?: () => void;
  isDirty?: boolean;
  /** Called to navigate back to the design selector */
  onBack?: () => void;
}

export function Toolbar({
  onSave,
  onExport,
  onUndo,
  onRedo,
  onPreview,
  isDirty = false,
  onBack,
}: ToolbarProps) {
  return (
    <div className="flex items-center gap-1 px-2 h-10 border-b border-hacker-accent/20 bg-hacker-surface shrink-0">
      {/* Back button */}
      {onBack && (
        <button
          onClick={onBack}
          className="btn-hacker text-xs px-2 py-1 mr-1"
          title="Back to design list"
        >
          ← Back
        </button>
      )}

      {/* Undo / Redo */}
      <button
        onClick={onUndo}
        className="p-1.5 text-hacker-text-dim hover:text-hacker-accent transition-colors disabled:opacity-30"
        title="Undo"
        disabled={!onUndo}
      >
        <Undo2 size={16} />
      </button>
      <button
        onClick={onRedo}
        className="p-1.5 text-hacker-text-dim hover:text-hacker-accent transition-colors disabled:opacity-30"
        title="Redo"
        disabled={!onRedo}
      >
        <Redo2 size={16} />
      </button>

      <div className="w-px h-5 bg-hacker-border/40 mx-1" />

      {/* Save */}
      <button
        onClick={onSave}
        className={`btn-hacker text-xs px-2 py-1 flex items-center gap-1 ${
          isDirty ? "text-hacker-accent" : "text-hacker-text-dim"
        }`}
        title="Save"
        disabled={!onSave || !isDirty}
      >
        <Save size={14} />
        {isDirty && <span className="text-[10px]">●</span>}
      </button>

      {/* Preview */}
      {onPreview && (
        <button
          onClick={onPreview}
          className="btn-hacker text-xs px-2 py-1 flex items-center gap-1 text-hacker-text-dim hover:text-hacker-accent"
          title="Preview"
        >
          <Eye size={14} />
        </button>
      )}

      <div className="flex-1" />

      {/* Export */}
      <button
        onClick={onExport}
        className="btn-hacker text-xs px-2 py-1 flex items-center gap-1 text-hacker-text-dim hover:text-hacker-accent"
        title="Export HTML/CSS"
      >
        <FileDown size={14} />
        <span>Export</span>
      </button>
    </div>
  );
}
