// Web counterparts of the mobile UI kit (mobile-app/src/ui): same shapes, same motion.
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion';
import { useEffect, useId, type ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';
import { alpha, palette, spring } from './theme';

export * from './theme';

/** A button that springs down when pressed (mobile `PressableScale`). */
export function Pressable({ pressedScale = 0.96, className = '', children, ...rest }: HTMLMotionProps<'button'> & { pressedScale?: number }) {
  return (
    <motion.button type="button" whileTap={{ scale: pressedScale }} transition={spring.snappy} className={className} {...rest}>
      {children}
    </motion.button>
  );
}

export function Surface({ className = '', tint, children, ...rest }: HTMLMotionProps<'div'> & { tint?: string }) {
  return (
    <motion.div
      className={`surface relative overflow-hidden ${className}`}
      style={tint ? { background: `linear-gradient(160deg, ${alpha(tint, 22)} 0%, ${palette.surface} 55%)`, borderColor: alpha(tint, 40) } : undefined}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

export function StatusDot({ color, pulse = false, size = 8 }: { color: string; pulse?: boolean; size?: number }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 rounded-full ${pulse ? 'dot-pulse' : ''}`}
      style={{ width: size, height: size, background: color, ['--dot' as string]: alpha(color, 140) }}
    />
  );
}

export function IconButton({
  icon: Icon, label, size = 40, active = false, activeColor = palette.accent, color, background, onClick, className = '', disabled,
}: {
  icon: LucideIcon; label: string; size?: number; active?: boolean; activeColor?: string; color?: string; background?: string;
  onClick?: () => void; className?: string; disabled?: boolean;
}) {
  const fg = color ?? (active ? activeColor : palette.textSecondary);
  return (
    <Pressable
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      pressedScale={0.9}
      whileHover={{ scale: 1.05 }}
      className={`grid place-items-center rounded-full border transition-colors disabled:opacity-40 ${className}`}
      style={{
        width: size, height: size, color: fg,
        background: background ?? (active ? alpha(activeColor, 34) : palette.surfaceRaised),
        borderColor: active ? alpha(activeColor, 110) : palette.stroke,
      }}
    >
      <Icon size={Math.round(size * 0.45)} strokeWidth={2} />
    </Pressable>
  );
}

/** Equal segments with a spring-sliding selection pill (shared layoutId). */
export function SegmentedControl<K extends string>({
  segments, value, onChange, accent = palette.accent, compact = false, className = '', label,
}: {
  segments: { key: K; label: string; icon?: LucideIcon }[]; value: K; onChange: (k: K) => void;
  accent?: string; compact?: boolean; className?: string; label: string;
}) {
  const id = useId();
  return (
    <div role="tablist" aria-label={label} className={`flex rounded-full border p-[3px] ${className}`} style={{ background: palette.surface, borderColor: palette.stroke, height: compact ? 36 : 42 }}>
      {segments.map((s) => {
        const active = s.key === value;
        const Icon = s.icon;
        return (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(s.key)}
            className="relative flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 t-subhead transition-colors"
            style={{ color: active ? accent : palette.textSecondary }}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                transition={spring.snappy}
                className="absolute inset-0 rounded-full border"
                style={{ background: alpha(accent, 38), borderColor: alpha(accent, 102) }}
              />
            )}
            {Icon && <Icon size={15} className="relative" />}
            <span className="relative whitespace-nowrap">{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Switch({ value, color = palette.accent }: { value: boolean; color?: string }) {
  return (
    <span aria-hidden className="relative inline-flex h-[26px] w-[44px] shrink-0 rounded-full border transition-colors"
      style={{ background: value ? alpha(color, 70) : palette.surfaceHigh, borderColor: value ? alpha(color, 140) : palette.stroke }}>
      <motion.span
        className="absolute top-[2px] h-[20px] w-[20px] rounded-full shadow"
        animate={{ x: value ? 20 : 2, background: value ? color : '#9fb1c4' }}
        transition={spring.snappy}
      />
    </span>
  );
}

export function Meter({ value, color = palette.accent }: { value: number; color?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'rgba(148,210,255,0.10)' }}>
      <motion.div className="h-full rounded-full" initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} transition={spring.gentle} />
    </div>
  );
}

export function SectionHeader({ title, icon: Icon, meta, action }: { title: string; icon?: LucideIcon; meta?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        {Icon && <Icon size={16} style={{ color: palette.accent }} />}
        <h2 className="t-headline">{title}</h2>
        {meta && <span className="t-footnote" style={{ color: palette.textTertiary }}>{meta}</span>}
      </div>
      {action}
    </div>
  );
}

export function Eyebrow({ children, color = palette.textTertiary }: { children: ReactNode; color?: string }) {
  return <span className="t-eyebrow" style={{ color }}>{children}</span>;
}

/**
 * A modal sheet (mobile `Sheet`): slides up from the bottom on narrow screens, scales in at
 * the centre on wide ones. Esc / backdrop close; focus moves into it.
 */
export function Sheet({
  open, onClose, title, subtitle, icon: Icon, accent = palette.accent, width = 760, children, footer,
}: {
  open: boolean; onClose: () => void; title: string; subtitle?: ReactNode; icon?: LucideIcon; accent?: string;
  width?: number; children: ReactNode; footer?: ReactNode;
}) {
  const reduced = useReducedMotion();
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[1000] flex items-end justify-center md:items-center md:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-[rgba(1,4,9,0.72)] backdrop-blur-md" onClick={onClose} />
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="glass shadow-float relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-[28px] md:max-h-[86vh] md:rounded-[28px]"
            style={{ maxWidth: width }}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 48, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 32, scale: 0.98 }}
            transition={spring.gentle}
          >
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40" style={{ background: `radial-gradient(80% 100% at 50% 0%, ${alpha(accent, 30)}, transparent)` }} />
            <div className="mx-auto mt-2 h-1 w-10 rounded-full md:hidden" style={{ background: palette.strokeStrong }} />
            <header className="relative flex items-center gap-3 px-6 pt-4 pb-3 md:pt-5">
              {Icon && (
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[14px]" style={{ background: alpha(accent, 36), color: accent }}>
                  <Icon size={19} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="t-title2 truncate">{title}</h2>
                {subtitle && <div className="t-footnote truncate" style={{ color: palette.textTertiary }}>{subtitle}</div>}
              </div>
              <IconButton icon={X} label="Close" size={36} onClick={onClose} />
            </header>
            <div className="relative min-h-0 flex-1 overflow-y-auto px-6 pb-6 scrollbar-thin">{children}</div>
            {footer && <footer className="relative border-t px-6 py-3" style={{ borderColor: palette.stroke }}>{footer}</footer>}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
