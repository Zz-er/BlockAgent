/**
 * cli/ui/welcome_lines.ts — 26-row welcome panel content (impl-cube-ink owned).
 *
 * Source of truth: ai_com/cube-design-final.md §2 (byte-identical).
 * Colors map to Ink <Text> props:
 *   white → default (no prop)
 *   cyan  → color="cyan"
 *   gray  → dimColor
 *
 * U+2019 RIGHT SINGLE QUOTATION MARK in row 15 ("can't", "can").
 * U+2014 EM DASH in row 18 ("—").
 * File saved UTF-8.
 */

export interface WelcomeLine {
  text: string;
  color: 'white' | 'cyan' | 'gray';
}

export const WELCOME_LINES: ReadonlyArray<WelcomeLine> = [
  /* 01 */ { text: '',                                                          color: 'white' },
  /* 02 */ { text: '   Welcome to',                                             color: 'gray'  },
  /* 03 */ { text: '',                                                          color: 'white' },
  /* 04 */ { text: '   ██████╗ ██╗      ██████╗  ██████╗██╗  ██╗',             color: 'cyan'  },
  /* 05 */ { text: '   ██╔══██╗██║     ██╔═══██╗██╔════╝██║ ██╔╝',             color: 'cyan'  },
  /* 06 */ { text: '   ██████╔╝██║     ██║   ██║██║     █████╔╝',              color: 'cyan'  },
  /* 07 */ { text: '   ██╔══██╗██║     ██║   ██║██║     ██╔═██╗',              color: 'cyan'  },
  /* 08 */ { text: '   ██████╔╝███████╗╚██████╔╝╚██████╗██║  ██╗',             color: 'cyan'  },
  /* 09 */ { text: '   ╚═════╝ ╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝',            color: 'cyan'  },
  /* 10 */ { text: '',                                                          color: 'white' },
  /* 11 */ { text: '   ─────────────────────────────────────────',              color: 'gray'  },
  /* 12 */ { text: '',                                                          color: 'white' },
  /* 13 */ { text: '       capability = f(weights, context)',                   color: 'cyan'  },
  /* 14 */ { text: '',                                                          color: 'white' },
  /* 15 */ { text: '   You can’t change the weights.',                     color: 'white' },
  /* 16 */ { text: '   You can only change the context.',                       color: 'white' },
  /* 17 */ { text: '',                                                          color: 'white' },
  /* 18 */ { text: '   block-agent is one bet — build it well.',           color: 'white' },
  /* 19 */ { text: '',                                                          color: 'white' },
  /* 20 */ { text: '   ─────────────────────────────────────────',              color: 'gray'  },
  /* 21 */ { text: '',                                                          color: 'white' },
  /* 22 */ { text: '   Type / for slash commands · /help · /apps',   color: 'gray'  },
  /* 23 */ { text: '',                                                          color: 'white' },
  /* 24 */ { text: '',                                                          color: 'white' },
  /* 25 */ { text: '',                                                          color: 'white' },
  /* 26 */ { text: '',                                                          color: 'white' },
];
