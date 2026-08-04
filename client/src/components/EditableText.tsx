import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface EditableTextProps {
  value: string;
  onSave: (next: string) => void;
  className?: string;
  /** Optional trailing content shown only in display mode (e.g. a pencil affordance icon). */
  icon?: ReactNode;
}

/**
 * Click-to-rename control: click (or Enter, when focused) swaps the display
 * text for an auto-focused text input. Blur or Enter commits (calling
 * onSave only if the trimmed value actually changed); Escape cancels
 * without saving. Shared by the list title (topbar) and every item title.
 */
export function EditableText({ value, onSave, className, icon }: EditableTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      cancelledRef.current = false;
      // Focus after the input has mounted.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => {
    if (cancelledRef.current) { cancelledRef.current = false; return; }
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== value) onSave(trimmed);
  };

  const cancel = () => {
    cancelledRef.current = true;
    setDraft(value);
    setEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={className}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
      />
    );
  }

  return (
    <span
      className={className}
      tabIndex={0}
      role="button"
      onClick={() => setEditing(true)}
      onKeyDown={e => { if (e.key === 'Enter') setEditing(true); }}
    >
      <span className="editable-text-label">{value}</span>
      {icon}
    </span>
  );
}
