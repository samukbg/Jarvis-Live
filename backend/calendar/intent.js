// Non-Live mode (the phone's speech recognizer, typed text): "What's on my calendar tomorrow?"
// is answered here, from the synced events, in a second — no agent run. Anything else about the
// calendar (add / move / delete, free-form questions) goes to the agent with the agenda and a
// local tool endpoint (service.agentBrief).

// \b is ASCII-only ("amanhã" never ends a word for it): a Unicode word boundary instead.
const UB = '(?:(?<![\\p{L}\\p{N}])(?=[\\p{L}\\p{N}])|(?<=[\\p{L}\\p{N}])(?![\\p{L}\\p{N}]))';
const u = (re) => new RegExp(re.source.replace(/\\b/g, UB), 'iu');

const CAL_WORDS = u(/\b(calendars?|agenda|schedule|meetings?|appointments?|events?|calendário|calendario|compromissos?|reuni(?:ão|ões|on|ones)|eventos?|citas?|calendrier|rendez-vous|réunions?|évènements?|événements?|termin(?:e)?|kalender)\b/i);
const QUESTION = u(/\b(what|what's|whats|anything|do i have|have i got|am i|show|list|tell me|read|o que|que|qu'est|tenho|tengo|ai-je|j'ai|quels?|quelles?|mostra|muestra|montre|qual|cuál|cual|como está|how does|how's|hows|what does|was habe)\b|\?\s*$/i);
const CHANGE = u(/\b(add|create|put|book|schedule (?:a|an|my)|set up|move|reschedule|change|rename|delete|remove|cancel|adiciona|adicionar|marca|marcar|cria|criar|agenda (?:uma|um)|muda|mudar|apaga|apagar|cancela|cancelar|añade|añadir|agrega|crea|mueve|borra|elimina|ajoute|ajouter|crée|créer|déplace|supprime|annule|programa)\b/i);

const DAYS = [
  ['day after tomorrow', u(/\b(day after tomorrow|depois de amanhã|pasado mañana|après-demain)\b/i)],
  ['tomorrow', u(/\b(tomorrow|amanhã|amanha|mañana|demain|morgen)\b/i)],
  ['yesterday', u(/\b(yesterday|ontem|ayer|hier|gestern)\b/i)],
  ['next weekend', u(/\b(next weekend|próximo fim de semana|proximo fim de semana|el próximo fin de semana|le week-end prochain)\b/i)],
  ['this weekend', u(/\b(weekend|fim de semana|fin de semana|week-end|wochenende)\b/i)],
  ['next week', u(/\b(next week|próxima semana|proxima semana|semana que vem|la semana que viene|la próxima semana|semaine prochaine|nächste woche)\b/i)],
  ['this week', u(/\b(this week|esta semana|cette semaine|diese woche)\b/i)],
  ['next month', u(/\b(next month|próximo mês|proximo mes|el mes que viene|el próximo mes|mois prochain)\b/i)],
  ['this month', u(/\b(this month|este mês|este mes|ce mois)\b/i)],
  ['today', u(/\b(today|hoje|hoy|aujourd'hui|heute|tonight|esta noite|esta noche|ce soir)\b/i)],
];
const WEEKDAYS = [
  ['monday', u(/\b(monday|segunda|lunes|lundi|montag)\b/i)],
  ['tuesday', u(/\b(tuesday|terça|terca|martes|mardi|dienstag)\b/i)],
  ['wednesday', u(/\b(wednesday|quarta|miércoles|miercoles|mercredi|mittwoch)\b/i)],
  ['thursday', u(/\b(thursday|quinta|jueves|jeudi|donnerstag)\b/i)],
  ['friday', u(/\b(friday|sexta|viernes|vendredi|freitag)\b/i)],
  ['saturday', u(/\b(saturday|sábado|sabado|samedi|samstag)\b/i)],
  ['sunday', u(/\b(sunday|domingo|dimanche|sonntag)\b/i)],
];
// "What do I have tomorrow?" names no calendar but means it (with a day).
const HAVE = u(/\b(what do i have|what have i got|what's on|whats on|anything on|am i free|am i busy|o que (?:é que )?tenho|tenho alguma coisa|estou livre|qué tengo|tengo algo|estoy libre|qu'est-ce que j'ai|ai-je quelque chose|suis-je libre)\b/i);
const NEXT = u(/\b(next|upcoming|coming up|próximos?|proximos?|próxima|siguientes?|prochains?)\b/i);

/** Does the text mention the user's calendar at all? */
export const mentionsCalendar = (text) => CAL_WORDS.test(String(text || ''));

// Questions about time and plans that never say "calendar": "When do I see Ana?", "Am I busy
// tonight?", "Do I have time for a haircut on Friday?", "What's my week like?".
const SCHEDULE = u(/\b(free|busy|available|availability|plans?|planned|booked|time for|when (?:do|am|is|are|will) (?:i|my|we)|when'?s my|see (?:\p{Lu}|her|him|them)|meet(?:ing)? (?:with )?|tonight|this (?:morning|afternoon|evening|week|weekend)|tomorrow|today|next (?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|my (?:day|week|morning|afternoon|evening)|livre|ocupad[oa]|disponível|planos|planes|sábado|domingo|segunda-feira|terça|quarta-feira|quinta-feira|sexta-feira|lunes|martes|miércoles|jueves|viernes|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|amanhã|hoje|semana|libre|ocupad[oa]|mañana|hoy|semana|occupé|disponible|demain|aujourd'hui|semaine)\b/i);

/** Is the text about the user's time, plans or meetings (so the agent should get the agenda)? */
export const aboutSchedule = (text) => mentionsCalendar(text) || SCHEDULE.test(String(text || ''));

/**
 * A plain agenda question → { day } (calendar_agenda's words), else null. Changes ("add…",
 * "move…") and anything unclear return null: the agent handles them.
 */
export function agendaQuery(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 160 || CHANGE.test(s)) return null;
  const named = CAL_WORDS.test(s);
  const dayWord = [...DAYS, ...WEEKDAYS].some(([, re]) => re.test(s));
  if (!named && !(HAVE.test(s) && dayWord)) return null;
  if (named && !QUESTION.test(s) && !/^(my )?(calendar|agenda|schedule)\b/i.test(s)) return null;
  for (const [day, re] of DAYS) if (re.test(s)) return { day };
  for (const [day, re] of WEEKDAYS) if (re.test(s)) return { day };
  if (NEXT.test(s)) return { day: 'next 7 days' };
  return { day: 'today' };
}

const LINES = {
  en: { none: (w) => `You have nothing on your calendar ${w}.`, some: (n, w) => `You have ${n} event${n === 1 ? '' : 's'} ${w}`, and: 'and', at: 'at', more: (n) => `and ${n} more` },
  pt: { none: (w) => `Não tens nada na agenda ${w}.`, some: (n, w) => `Tens ${n} evento${n === 1 ? '' : 's'} ${w}`, and: 'e', at: 'às', more: (n) => `e mais ${n}` },
  es: { none: (w) => `No tienes nada en el calendario ${w}.`, some: (n, w) => `Tienes ${n} evento${n === 1 ? '' : 's'} ${w}`, and: 'y', at: 'a las', more: (n) => `y ${n} más` },
  fr: { none: (w) => `Tu n'as rien dans ton agenda ${w}.`, some: (n, w) => `Tu as ${n} événement${n === 1 ? '' : 's'} ${w}`, and: 'et', at: 'à', more: (n) => `et ${n} de plus` },
};
const WHEN = {
  en: { today: 'today', tomorrow: 'tomorrow', yesterday: 'yesterday', 'this week': 'this week', 'next week': 'next week', 'this weekend': 'this weekend', 'next 7 days': 'in the next 7 days' },
  pt: { today: 'hoje', tomorrow: 'amanhã', yesterday: 'ontem', 'this week': 'esta semana', 'next week': 'na próxima semana', 'this weekend': 'este fim de semana', 'next 7 days': 'nos próximos 7 dias' },
  es: { today: 'hoy', tomorrow: 'mañana', yesterday: 'ayer', 'this week': 'esta semana', 'next week': 'la próxima semana', 'this weekend': 'este fin de semana', 'next 7 days': 'en los próximos 7 días' },
  fr: { today: "aujourd'hui", tomorrow: 'demain', yesterday: 'hier', 'this week': 'cette semaine', 'next week': 'la semaine prochaine', 'this weekend': 'ce week-end', 'next 7 days': 'dans les 7 prochains jours' },
};

/** A short spoken answer for an agenda (the card shows the details). `lang`: 'en' | 'pt' | 'es' | 'fr'… */
export function spokenShort(events, { day, title, lang = 'en' } = {}) {
  const l = LINES[lang] ? lang : 'en';
  const t = LINES[l];
  const when = WHEN[l][day] || (l === 'en' ? `for ${title}` : title);
  if (!events.length) return t.none(when);
  const multiDay = new Set(events.map((e) => e.start.slice(0, 10))).size > 1;
  const name = (e) => (e.allDay || multiDay ? e.title : `${e.title} ${t.at} ${e.start.slice(11, 16)}`);
  const first = events.slice(0, 3).map(name);
  const rest = events.length - first.length;
  const list = rest > 0 ? `${first.join(', ')} ${t.more(rest)}` : first.length > 1 ? `${first.slice(0, -1).join(', ')} ${t.and} ${first[first.length - 1]}` : first[0];
  return `${t.some(events.length, when)}: ${list}.`;
}
