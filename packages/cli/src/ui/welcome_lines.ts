/**
 * cli/ui/welcome_lines.ts — 26-row welcome panel content (impl-cube-ink owned).
 *
 * Source of truth: ai_com/cube-design-final.md §2 (byte-identical).
 * Colors map to Ink <Text> props:
 *   white → default (no prop)
 *   cyan  → color="cyan"
 *   gray  → dimColor
 *
 * Layout — 2 blank top + 21 content rows (3..23) + 3 blank bottom = 26.
 * Content vertical midline sits at row 13, matching the cube's halfH so the
 * BLOCK ASCII / equation block visually aligns with the cube's center on
 * `npm start`.
 *
 * U+2019 RIGHT SINGLE QUOTATION MARK in the "You can't" row.
 * U+2014 EM DASH in the "block-agent is one bet — build it well" row.
 * File saved UTF-8.
 */

export interface WelcomeLine {
  text: string;
  color: 'white' | 'cyan' | 'gray';
}

export const WELCOME_LINES: ReadonlyArray<WelcomeLine> = [
  /* 01 */ { text: '',                                                          color: 'white' },
  /* 02 */ { text: '',                                                          color: 'white' },
  /* 03 */ { text: '   Welcome to',                                             color: 'gray'  },
  /* 04 */ { text: '',                                                          color: 'white' },
  /* 05 */ { text: '   ██████╗ ██╗      ██████╗  ██████╗██╗  ██╗',             color: 'cyan'  },
  /* 06 */ { text: '   ██╔══██╗██║     ██╔═══██╗██╔════╝██║ ██╔╝',             color: 'cyan'  },
  /* 07 */ { text: '   ██████╔╝██║     ██║   ██║██║     █████╔╝',              color: 'cyan'  },
  /* 08 */ { text: '   ██╔══██╗██║     ██║   ██║██║     ██╔═██╗',              color: 'cyan'  },
  /* 09 */ { text: '   ██████╔╝███████╗╚██████╔╝╚██████╗██║  ██╗',             color: 'cyan'  },
  /* 10 */ { text: '   ╚═════╝ ╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝',            color: 'cyan'  },
  /* 11 */ { text: '',                                                          color: 'white' },
  /* 12 */ { text: '   ─────────────────────────────────────────',              color: 'gray'  },
  /* 13 */ { text: '',                                                          color: 'white' },
  /* 14 */ { text: '       capability = f(weights, context)',                   color: 'cyan'  },
  /* 15 */ { text: '',                                                          color: 'white' },
  /* 16 */ { text: '   You can’t change the weights.',                          color: 'white' },
  /* 17 */ { text: '   You can only change the context.',                       color: 'white' },
  /* 18 */ { text: '',                                                          color: 'white' },
  /* 19 */ { text: '   block-agent is one bet — build it well.',                color: 'white' },
  /* 20 */ { text: '',                                                          color: 'white' },
  /* 21 */ { text: '   ─────────────────────────────────────────',              color: 'gray'  },
  /* 22 */ { text: '',                                                          color: 'white' },
  /* 23 */ { text: '   Type / for slash commands · /help · /apps',              color: 'gray'  },
  /* 24 */ { text: '',                                                          color: 'white' },
  /* 25 */ { text: '',                                                          color: 'white' },
  /* 26 */ { text: '',                                                          color: 'white' },
];
