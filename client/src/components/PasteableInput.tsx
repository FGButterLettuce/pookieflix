import { useState, type ChangeEvent, type KeyboardEvent } from 'react';

interface PasteableInputProps {
  className?: string;
  type?: string;
  inputMode?: 'text' | 'numeric' | 'none' | 'tel' | 'search' | 'email' | 'url' | 'decimal';
  placeholder?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
}

const canReadClipboard =
  typeof navigator !== 'undefined' &&
  !!navigator.clipboard &&
  typeof navigator.clipboard.readText === 'function' &&
  typeof window !== 'undefined' &&
  window.isSecureContext;

export function PasteableInput({
  className, type = 'text', inputMode, placeholder, value, onChange, onKeyDown, autoFocus,
}: PasteableInputProps) {
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle');

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) throw new Error('empty clipboard');
      onChange({ target: { value: text } } as ChangeEvent<HTMLInputElement>);
      setStatus('ok');
    } catch {
      setStatus('error');
    } finally {
      setTimeout(() => setStatus('idle'), 1500);
    }
  };

  return (
    <div className="pasteable-field">
      <input
        className={className}
        type={type}
        inputMode={inputMode}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
      />
      {canReadClipboard && (
        <button
          type="button"
          className={`paste-btn${status !== 'idle' ? ` paste-btn--${status}` : ''}`}
          onClick={() => void paste()}
          tabIndex={-1}
          aria-label="Paste from clipboard"
          title="Paste from clipboard"
        >
          {status === 'ok' ? '✓' : status === 'error' ? '✕' : '📋'}
        </button>
      )}
    </div>
  );
}
