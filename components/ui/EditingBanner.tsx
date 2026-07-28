'use client';

// Strip above the composer while an earlier message is being edited. Renders
// nothing when no edit is active, so callers can drop it in unconditionally.
export function EditingBanner({
  editing,
  onCancel,
}: {
  editing: boolean;
  onCancel: () => void;
}) {
  if (!editing) return null;
  return (
    <div className="border-t border-blue-500/20 bg-blue-500/5 px-6 py-2.5 flex items-center justify-between animate-in fade-in duration-200">
      <div className="flex items-center gap-2">
        <div className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
        <span className="text-xs font-medium text-blue-300/80">Editing • Press ESC to cancel</span>
      </div>
      <button
        onClick={onCancel}
        className="text-xs px-2.5 py-1 rounded text-blue-300/60 hover:text-blue-300 hover:bg-blue-500/10 transition"
      >
        Cancel
      </button>
    </div>
  );
}
