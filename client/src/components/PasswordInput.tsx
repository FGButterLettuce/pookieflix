import { useState, type ChangeEvent, type KeyboardEvent } from 'react';

interface PasswordInputProps {
  className?: string;
  placeholder?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
}

export function PasswordInput({ className, placeholder, value, onChange, onKeyDown, autoFocus }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-field">
      <input
        className={className}
        type={visible ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        className="password-toggle-btn"
        onClick={() => setVisible(v => !v)}
        tabIndex={-1}
        aria-label={visible ? 'Hide password' : 'Show password'}
      >
        {visible ? '🙈' : '👁️'}
      </button>
    </div>
  );
}
