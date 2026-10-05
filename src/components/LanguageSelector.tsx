import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import languagesData from '../languages.json';

interface Language {
  name: string;
  code: string;
}

const LANGUAGES: Language[] = languagesData;

interface Props {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
}

export const LanguageSelector: React.FC<Props> = ({ value, onChange, disabled }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, right: 0 });

  const selectedLang = LANGUAGES.find(l => l.code === value) || LANGUAGES.find(l => l.code === 'eng');

  const filteredLangs = LANGUAGES.filter(l =>
    l.name.toLowerCase().includes(search.toLowerCase()) ||
    l.code.toLowerCase().includes(search.toLowerCase())
  );

  // Calculate position when opening
  const handleOpen = () => {
    if (disabled) return;
    if (!isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + window.scrollY + 4,
        right: window.innerWidth - rect.right,
      });
    }
    setIsOpen(prev => !prev);
  };

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        buttonRef.current && !buttonRef.current.contains(e.target as Node) &&
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const dropdown = (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={dropdownRef}
          role="listbox"
          initial={{ opacity: 0, y: -8, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.98 }}
          transition={{ type: 'spring', damping: 18, stiffness: 260, mass: 0.8 }}
          style={{ position: 'fixed', top: dropdownPos.top + 6, right: dropdownPos.right, zIndex: 2147483647, width: '17rem', transformOrigin: 'top right' }}
          className="popover shadow-float flex max-h-80 flex-col overflow-hidden rounded-[20px]"
        >
          <div className="border-b border-stroke p-2">
            <input
              type="text"
              placeholder="Search 600+ languages…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-full border border-stroke bg-surface px-3.5 py-2 t-subhead text-text outline-none placeholder:text-text-3 focus:border-accent/60"
              autoFocus
            />
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-1.5 scrollbar-thin">
            {filteredLangs.length === 0 ? (
              <div className="px-3 py-3 text-center t-footnote text-text-3">No matches</div>
            ) : (
              filteredLangs.map((l) => (
                <button
                  key={l.code}
                  role="option"
                  aria-selected={value === l.code}
                  onClick={() => {
                    onChange(l.code);
                    setIsOpen(false);
                    setSearch('');
                  }}
                  className={`flex w-full items-center gap-2 rounded-[12px] px-2.5 py-1.5 text-left t-subhead transition-colors hover:bg-[rgba(148,210,255,0.07)] ${value === l.code ? 'bg-accent/15 text-accent' : 'text-text-2'}`}
                >
                  <span className="w-9 shrink-0 t-caption uppercase text-text-3">{l.code}</span>
                  <span className="truncate">{l.name}</span>
                </button>
              ))
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={handleOpen}
        disabled={disabled}
        aria-label={`Language: ${selectedLang?.name || 'English'}`}
        title={selectedLang?.name}
        className={`flex h-11 items-center gap-1.5 rounded-full border px-3.5 t-subhead transition-colors ${disabled ? 'cursor-not-allowed border-stroke text-text-3' : 'border-stroke bg-surface text-text-2 hover:border-stroke-strong hover:text-text'}`}
      >
        <span className="max-w-[60px] truncate uppercase">{selectedLang?.code || 'eng'}</span>
        {disabled
          ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>}
      </button>

      {createPortal(dropdown, document.body)}
    </div>
  );
};
