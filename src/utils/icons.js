const A = `xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
const s = (size, vb, paths) =>
  `<svg width="${size}" height="${size}" viewBox="${vb}" ${A}>${paths}</svg>`;

const sq = (n, paths) => s(n, "0 0 24 24", paths);

export const icon = {
  users: (n = 18) =>
    sq(n, `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`),

  checkCircle: (n = 18) =>
    sq(n, `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>`),

  clock3: (n = 18) =>
    sq(n, `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16.5 12"/>`),

  mapPin: (n = 18) =>
    sq(n, `<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>`),

  userX: (n = 18) =>
    sq(n, `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" x2="22" y1="8" y2="13"/><line x1="22" x2="17" y1="8" y2="13"/>`),

  userMinus: (n = 18) =>
    sq(n, `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" x2="16" y1="11" y2="11"/>`),

  xCircle: (n = 18) =>
    sq(n, `<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>`),

  wallet: (n = 18) =>
    sq(n, `<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>`),

  fileSpreadsheet: (n = 16) =>
    sq(n, `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>`),

  fileText: (n = 16) =>
    sq(n, `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`),

  search: (n = 15) =>
    sq(n, `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`),

  userRound: (n = 15) =>
    sq(n, `<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>`),

  mapPinned: (n = 15) =>
    sq(n, `<path d="M18 8c0 4.5-6 9-6 9s-6-4.5-6-9a6 6 0 0 1 12 0"/><circle cx="12" cy="8" r="2"/><path d="M8.835 14H5a1 1 0 0 0-.9.7l-2 6c-.1.1-.1.2-.1.3 0 .6.4 1 1 1h18c.6 0 1-.4 1-1 0-.1 0-.2-.1-.3l-2-6a1 1 0 0 0-.9-.7h-3.835"/>`),

  filter: (n = 15) =>
    sq(n, `<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>`),
};
