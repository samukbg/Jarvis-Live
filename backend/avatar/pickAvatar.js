// Which avatar to render: the one asked for if this server's renderer has it, else the
// default, else any it has. Servers don't all have the same portraits (a new server may start with
// only one custom avatar) and an unknown avatar_id made the renderer 404 every frame — a black stream.
export const DEFAULT_AVATAR = 'maria';

export function pickAvatar(requested, available, preferred = DEFAULT_AVATAR) {
  const want = String(requested || '').toLowerCase().trim();
  if (!Array.isArray(available) || available.length === 0) return want || preferred; // unknown: don't guess
  const has = (id) => available.some((a) => String(a).toLowerCase() === id);
  if (want && has(want)) return want;
  if (has(preferred)) return preferred;
  return String(available[0]).toLowerCase();
}
