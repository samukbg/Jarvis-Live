import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Plus, Trash2 } from 'lucide-react';
import { API_KEY } from '../store';
import { alpha, palette, spring } from '../ui';

// The AVTR-1 avatars every server has; others were made on the computer (they can be deleted).
export const BUILTIN_AVATARS = [
  'arnold', 'ben', 'camila', 'caroline', 'clara', 'elena', 'gordon', 'jack', 'john',
  'kate', 'marcus', 'maria', 'may', 'ming', 'mozart', 'oliver', 'olivia', 'trevor',
];

/** The portrait PNG on the server (public/avatars); the initial is shown when there is none. */
export function avatarImageUrl(id: string, serverUrl: string): string | null {
  const clean = id.toLowerCase();
  if (!serverUrl) return null;
  return `${serverUrl.replace(/\/+$/, '')}/avatars/${encodeURIComponent(clean)}.png${API_KEY ? `?api_key=${encodeURIComponent(API_KEY)}` : ''}`;
}

const TINTS = ['#22D3EE', '#38BDF8', '#34D399', '#F59E0B', '#94A3B8', '#F472B6'];
const tintFor = (name: string) => TINTS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length];
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Portrait thumbnail; the initial on a tint when there's no image (or it fails to load). */
function Portrait({ id, serverUrl, tint, selected }: { id: string; serverUrl: string; tint: string; selected: boolean }) {
  const src = avatarImageUrl(id, serverUrl);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <div
      className="relative aspect-square w-full overflow-hidden rounded-[16px] border-2 transition-colors"
      style={{ background: alpha(tint, 38), borderColor: selected ? tint : palette.stroke }}
    >
      {src && !failed ? (
        <img src={src} alt="" draggable={false} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]" />
      ) : (
        <span className="absolute inset-0 grid place-items-center t-title2" style={{ color: tint }}>{id.charAt(0).toUpperCase()}</span>
      )}
      <AnimatePresence>
        {selected && (
          <motion.span
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={spring.snappy}
            className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full"
            style={{ background: tint, color: palette.textInverse }}
          >
            <Check size={12} strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

type TrainingJob = { status?: string; progress?: number };

/** Settings → Live avatar: a grid of portrait cards (built-ins and the avatars made on this computer). */
export function AvatarPicker({
  avatars,
  selected,
  serverUrl,
  trainingJobs,
  onSelect,
  onCreate,
  onDelete,
}: {
  avatars: string[];
  selected: string;
  serverUrl: string;
  trainingJobs?: Record<string, TrainingJob | undefined>;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Live avatar" className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }}>
      <motion.button
        type="button"
        onClick={onCreate}
        whileTap={{ scale: 0.96 }}
        className="group flex flex-col items-center gap-1.5 rounded-[20px] border border-dashed p-2 text-center transition-colors hover:bg-[rgba(34,211,238,0.06)]"
        style={{ borderColor: alpha(palette.accent, 110) }}
        aria-label="Create a new avatar"
      >
        <span className="grid aspect-square w-full place-items-center rounded-[16px]" style={{ background: alpha(palette.accent, 22), color: palette.accent }}>
          <Plus size={26} />
        </span>
        <span className="t-footnote" style={{ color: palette.accent }}>Create</span>
      </motion.button>

      {avatars.map((av, i) => {
        const isBuiltin = BUILTIN_AVATARS.includes(av.toLowerCase());
        const job = trainingJobs?.[av];
        const training = job?.status === 'training';
        const isSelected = selected === av;
        const tint = tintFor(av);
        return (
          <motion.div
            key={av}
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring.gentle, delay: Math.min(i, 12) * 0.02 }}
            className="relative"
          >
            <motion.button
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={`${titleCase(av)}${training ? `, training ${job?.progress ?? 0}%` : ''}`}
              disabled={training}
              onClick={() => onSelect(av)}
              whileTap={{ scale: 0.96 }}
              className={`group flex w-full flex-col items-center gap-1.5 rounded-[20px] border p-2 text-center transition-colors ${training ? 'opacity-60' : 'hover:bg-[rgba(255,255,255,0.03)]'}`}
              style={isSelected ? { borderColor: alpha(tint, 170), background: alpha(tint, 20) } : { borderColor: 'transparent' }}
            >
              <Portrait id={av} serverUrl={serverUrl} tint={tint} selected={isSelected} />
              <span className="w-full truncate t-footnote" style={{ color: isSelected ? palette.text : palette.textSecondary }}>{titleCase(av)}</span>
              {training ? (
                <span className="t-caption" style={{ color: palette.warning }}>Training {job?.progress ?? 0}%</span>
              ) : !isBuiltin ? (
                <span className="t-caption" style={{ color: palette.textTertiary }}>Custom</span>
              ) : null}
            </motion.button>
            {!isBuiltin && !training && (
              <button
                type="button"
                title={`Delete custom avatar "${titleCase(av)}"`}
                aria-label={`Delete ${titleCase(av)}`}
                onClick={() => onDelete(av)}
                className="absolute left-3.5 top-3.5 grid h-6 w-6 place-items-center rounded-full opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 [div:hover>&]:opacity-100"
                style={{ background: 'rgba(7,11,18,0.72)', color: '#F87171' }}
              >
                <Trash2 size={13} />
              </button>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}
