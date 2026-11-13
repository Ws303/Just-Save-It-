/**
 * SVG icon library faithfully adapted from Figma export paths (Sharely iK9nRBTc2LWYahDIyEU8TK).
 * Uses `currentColor` where icons participate in theme tinting.
 */

export function escHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const icons = {
  cherry: (size = 18) => `
    <svg width="${size}" height="${size}" viewBox="0 0 15 19" fill="none" aria-hidden="true">
      <path d="M4.94767 1.53783C2.94186 2.54073 1.33721 4.2791 0.601744 6.88666C0.0668605 8.62503 0.668605 10.2965 0 11.7006C1.80523 11.0989 3.40988 9.76166 4.34593 8.09015C5.4157 6.35178 6.21802 4.07852 5.68314 1.93899C5.0814 3.34306 4.41279 4.74713 3.61046 6.01748C3.07558 6.88666 2.60756 7.68899 2.07267 8.35759C2.67442 6.88666 3.40988 5.34887 4.01163 3.87794L4.94767 1.53783Z" fill="currentColor"/>
      <path d="M5.21503 0.869186L5.88363 0C6.6191 0.735465 7.08712 1.53779 7.35456 2.875C8.49119 5.0814 9.22666 7.22093 10.2296 10.2965L9.62782 10.6308C8.82549 7.82267 8.22375 5.95058 7.35456 4.01163C7.22084 6.81977 6.35166 8.9593 5.41561 11.032C5.21503 11.5 5.21503 11.7006 5.88363 12.0349L5.54933 12.5698C4.68014 12.3023 4.47956 11.9012 4.81386 11.1657C5.68305 9.15988 6.88654 6.55233 6.88654 3.74419C6.88654 2.67442 6.01735 1.47093 5.21503 0.869186Z" fill="currentColor"/>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M5.95065 11.1657C6.28495 10.0959 7.15414 9.49419 8.15705 9.56105C8.75879 9.56105 9.09309 9.76163 9.56112 9.82849L9.02623 10.564C9.62798 11.1657 10.3634 10.8983 11.1658 10.2297C11.9012 9.56105 12.7704 9.42732 13.3053 9.96221C13.9739 10.564 14.2413 11.5669 14.0408 12.7035C13.7065 14.7762 12.2355 16.5145 9.36053 16.5145C9.89542 15.1105 9.7617 13.2384 9.09309 12.3692C8.42449 11.4331 7.35472 11.0988 5.95065 11.1657ZM12.4361 10.9651C12.6367 10.7645 12.8373 11.0988 12.971 11.4331C13.5727 12.5698 13.2384 14.1744 12.3024 14.9099C11.9681 15.1773 11.7675 15.1773 11.9012 14.9099C12.503 13.8401 12.8373 12.7703 12.503 11.6337C12.4361 11.3663 12.3024 11.0988 12.4361 10.9651Z" fill="currentColor"/>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M5.48265 12.5697C6.15125 12.0348 6.753 11.7674 7.4216 11.8343C8.49137 11.968 9.02625 12.8372 9.09311 14.1744C9.15997 15.779 8.42451 17.3837 6.88672 18.186C4.94776 19.1889 3.20939 18.7209 2.07276 17.5174C1.27044 16.6482 0.869275 15.5116 0.936135 14.3081C1.003 13.0377 1.73846 12.0348 2.74137 11.8343C3.74427 11.6337 4.61346 12.1017 5.48265 12.5697ZM2.40707 16.3808C2.47393 15.2441 2.74137 14.7761 3.20939 14.1075C3.47683 13.7063 3.34311 13.2383 3.07567 13.1046C2.54079 12.904 2.13962 13.5726 2.07276 14.2412C1.93904 15.1104 2.13962 15.9127 2.40707 16.3808Z" fill="currentColor"/>
    </svg>
  `,

  home: (size = 22) => `
    <svg width="${size}" height="${size}" viewBox="0 0 23 23" fill="none" aria-hidden="true">
      <path d="M2.875 9.58333L11.5 2.875L20.125 9.58333V18.2083C20.125 18.7167 19.9231 19.2042 19.5636 19.5636C19.2042 19.9231 18.7167 20.125 18.2083 20.125H14.375V14.375C14.375 14.1208 14.274 13.8771 14.0943 13.6974C13.9146 13.5176 13.6708 13.4167 13.4167 13.4167H9.58333C9.32917 13.4167 9.08541 13.5176 8.90569 13.6974C8.72597 13.8771 8.625 14.1208 8.625 14.375V20.125H4.79167C4.28334 20.125 3.79582 19.9231 3.43638 19.5636C3.07693 19.2042 2.875 18.7167 2.875 18.2083V9.58333Z" stroke="currentColor" stroke-width="1.68" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,

  folder: (size = 22) => `
    <svg width="${size}" height="${size}" viewBox="0 0 23 23" fill="none" aria-hidden="true">
      <path d="M2.875 6.70833C2.875 6.2 3.07693 5.71249 3.43638 5.35305C3.79582 4.9936 4.28334 4.79167 4.79167 4.79167H8.625L10.5417 6.70833H18.2083C18.7167 6.70833 19.2042 6.91027 19.5636 7.26971C19.9231 7.62916 20.125 8.11667 20.125 8.625V16.2917C20.125 16.8 19.9231 17.2875 19.5636 17.647C19.2042 18.0064 18.7167 18.2083 18.2083 18.2083H4.79167C4.28334 18.2083 3.79582 18.0064 3.43638 17.647C3.07693 17.2875 2.875 16.8 2.875 16.2917V6.70833Z" stroke="currentColor" stroke-width="1.68" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,

  bot: (size = 22) => `
    <svg width="${size}" height="${size}" viewBox="0 0 22 19" fill="none" aria-hidden="true">
      <path d="M10.7812 5.12708V2.53958" stroke="currentColor" stroke-width="1.63" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="10.7812" cy="1.677" r="0.86" stroke="currentColor" stroke-width="1.63"/>
      <rect x="3.21" y="5.41" width="15.14" height="12.55" rx="5.46" stroke="currentColor" stroke-width="1.63"/>
      <path d="M3.21 9.34H2.44C1.54 9.34 0.81 10.07 0.81 10.97V12.89C0.81 13.79 1.54 14.52 2.44 14.52H3.31M18.35 9.34H19.12C20.02 9.34 20.75 10.07 20.75 10.97V12.89C20.75 13.79 20.02 14.52 19.12 14.52H18.26" stroke="currentColor" stroke-width="1.63" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="7.9" cy="11.6" r="1.29" fill="currentColor"/>
      <circle cx="13.65" cy="11.6" r="1.29" fill="currentColor"/>
    </svg>
  `,

  profile: (size = 22) => `
    <svg width="${size}" height="${size}" viewBox="0 0 23 23" fill="none" aria-hidden="true">
      <circle cx="11.5" cy="11.5" r="8.625" stroke="currentColor" stroke-width="1.68"/>
      <circle cx="11.5" cy="9.1" r="2.49" stroke="currentColor" stroke-width="1.68"/>
      <path d="M6.6125 18.1125V17.3458C6.6125 15.334 8.243 13.7042 10.2542 13.7042H12.7458C14.757 13.7042 16.3875 15.334 16.3875 17.3458V18.1125" stroke="currentColor" stroke-width="1.68" stroke-linecap="round"/>
    </svg>
  `,

  bell: (size = 20) => `
    <svg width="${size}" height="${size}" viewBox="0 0 21 21" fill="none" aria-hidden="true">
      <path d="M15.75 7C15.75 5.60761 15.1969 4.27226 14.2123 3.28769C13.2277 2.30312 11.8924 1.75 10.5 1.75C9.10761 1.75 7.77226 2.30312 6.78769 3.28769C5.80312 4.27226 5.25 5.60761 5.25 7C5.25 13.125 2.625 13.125 2.625 14.875H18.375C18.375 13.125 15.75 13.125 15.75 7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M8.75 18.375H12.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  `,

  search: (size = 18) => `
    <svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="9.167" cy="9.167" r="5.833" stroke="currentColor" stroke-width="1.7"/>
      <path d="M16.6667 16.6667L13.3333 13.3333" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </svg>
  `,

  plus: (size = 16) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    </svg>
  `,

  kebab: (size = 16) => `
    <svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="3.2" r="1.35" fill="currentColor"/>
      <circle cx="8" cy="8" r="1.35" fill="currentColor"/>
      <circle cx="8" cy="12.8" r="1.35" fill="currentColor"/>
    </svg>
  `,

  back: (size = 22) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 5L8 12L15 19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,

  chevronRight: (size = 16) => `
    <svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,

  chevronDown: (size = 18) => `
    <svg width="${size}" height="${size}" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M4.5 6.75L9 11.25L13.5 6.75" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,

  clock: (size = 18) => `
    <svg width="${size}" height="${size}" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="6.75" stroke="currentColor" stroke-width="1.5"/>
      <path d="M9 5.25V9L11.25 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  `,

  externalLink: (size = 17) => `
    <svg width="${size}" height="${size}" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M15 7.5V3H10.5M15 3L8.25 9.75M13.5 10.5V15H3V4.5H7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,

  play: (size = 24) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 5V19L19 12L8 5Z" fill="currentColor"/>
    </svg>
  `,

  close: (size = 17) => `
    <svg width="${size}" height="${size}" viewBox="0 0 17 17" fill="none" aria-hidden="true">
      <path d="M4.25 4.25L12.75 12.75M12.75 4.25L4.25 12.75" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>
  `,

  copy: (size = 18) => `
    <svg width="${size}" height="${size}" viewBox="0 0 19 19" fill="none" aria-hidden="true">
      <rect x="6.33" y="6.33" width="9.5" height="9.5" rx="1.6" stroke="currentColor" stroke-width="1.4"/>
      <path d="M12.6667 6.33333V4.75C12.6667 3.875 11.958 3.16667 11.0833 3.16667H4.75C3.875 3.16667 3.16667 3.875 3.16667 4.75V11.0833C3.16667 11.958 3.875 12.6667 4.75 12.6667H6.33333" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>
  `,

  share: (size = 18) => `
    <svg width="${size}" height="${size}" viewBox="0 0 19 19" fill="none" aria-hidden="true">
      <path d="M9.5 11.875V2.375M12.6667 5.54167L9.5 2.375L6.33333 5.54167M4.75 8.70833H3.95833V15.8333H15.0417V8.70833H14.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,

  people: (size = 18) => `
    <svg width="${size}" height="${size}" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="6.75" cy="6" r="2.25" stroke="currentColor" stroke-width="1.3"/>
      <path d="M2.25 14.25V13.5C2.25 11.843 3.593 10.5 5.25 10.5H8.25C9.907 10.5 11.25 11.843 11.25 13.5V14.25M12.75 3.75C13.993 3.75 15 4.757 15 6C15 7.243 13.993 8.25 12.75 8.25M12.75 10.5C14.407 10.5 15.75 11.843 15.75 13.5V14.25" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>
  `,

  check: (size = 16) => `
    <svg width="${size}" height="${size}" viewBox="0 0 17 17" fill="none" aria-hidden="true">
      <path d="M3.54 8.5L6.375 11.333L13.458 4.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,

  pencil: (size = 15) => `
    <svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M13.8 3.6L16.4 6.2M4.5 15.5L8.2 14.7L15.9 7C16.5 6.4 16.5 5.4 15.9 4.8L15.2 4.1C14.6 3.5 13.6 3.5 13 4.1L5.3 11.8L4.5 15.5Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,

  palette: (size = 20) => `
    <svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 2.5C5.86 2.5 2.5 5.86 2.5 10C2.5 14.14 5.86 17.5 10 17.5C10.8 17.5 11.4 16.9 11.4 16.1C11.4 15.7 11.2 15.4 11 15.1C10.8 14.8 10.6 14.5 10.6 14.1C10.6 13.3 11.2 12.7 12 12.7H13.7C15.8 12.7 17.5 11 17.5 8.9C17.5 5.36 14.14 2.5 10 2.5Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/>
      <circle cx="6.5" cy="9" r="0.9" fill="currentColor"/>
      <circle cx="9.2" cy="6.4" r="0.9" fill="currentColor"/>
      <circle cx="13" cy="7.2" r="0.9" fill="currentColor"/>
    </svg>
  `,

  shield: (size = 20) => `
    <svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 18.3333C10 18.3333 15.8333 15.5 15.8333 11.25V4.16667L10 1.66667L4.16667 4.16667V11.25C4.16667 15.5 10 18.3333 10 18.3333Z" stroke="currentColor" stroke-width="1.42" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M7.5 10L9.16667 11.6667L12.5 8.33333" stroke="currentColor" stroke-width="1.42" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,

  help: (size = 20) => `
    <svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.42"/>
      <path d="M7.92 7.5C8.1 6.33 9.1 5.45 10.3 5.5C11.55 5.55 12.5 6.5 12.45 7.75C12.42 8.5 11.9 9 11.2 9.4C10.45 9.85 10 10.3 10 11.25M10 13.83H10.01" stroke="currentColor" stroke-width="1.42" stroke-linecap="round"/>
    </svg>
  `,

  download: (size = 20) => `
    <svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 2.5V12.5M13.3333 9.16667L10 12.5L6.66667 9.16667M4.16667 13.3333V16.6667H15.8333V13.3333" stroke="currentColor" stroke-width="1.42" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,

  signout: (size = 18) => `
    <svg width="${size}" height="${size}" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M7.5 5.25L11.25 9L7.5 12.75M11.25 9H2.25M11.25 3H14.25C15.078 3 15.75 3.672 15.75 4.5V13.5C15.75 14.328 15.078 15 14.25 15H11.25" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,

  imagePlaceholder: (size = 28) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" stroke="#6b7280" stroke-width="1.7"/>
      <circle cx="8.5" cy="9.5" r="1.5" fill="#6b7280"/>
      <path d="M4.5 17L9.5 12.5L13 15.5L16.5 12L19.5 16.5" stroke="#6b7280" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,

  mail: (size = 22) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" stroke-width="1.8"/>
      <path d="M4 7L12 13L20 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>
  `,

  bookmarkSolid: (size = 18) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 3C5.44772 3 5 3.44772 5 4V21.5L12 17.5L19 21.5V4C19 3.44772 18.5523 3 18 3H6Z"/>
    </svg>
  `,

  folderSolid: (size = 22) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 5.5C3 4.67157 3.67157 4 4.5 4H9.08579C9.48362 4 9.86514 4.15804 10.1464 4.43934L12.7071 7H19.5C20.3284 7 21 7.67157 21 8.5V18.5C21 19.3284 20.3284 20 19.5 20H4.5C3.67157 20 3 19.3284 3 18.5V5.5Z"/>
    </svg>
  `,

  shareSheetLogo: (size = 38) => `
    <svg width="${size}" height="${size}" viewBox="0 0 44 44" fill="none" aria-hidden="true">
      <!-- Container border -->
      <rect x="2" y="2" width="40" height="40" rx="10" fill="#ffffff" stroke="#111111" stroke-width="2.5"/>
      <!-- Mascot Bookmark Yellow body -->
      <path d="M12 9C12 7.89543 12.8954 7 14 7H30C31.1046 7 32 7.89543 32 9V35L22 29L12 35V9Z" fill="#FACC15" stroke="#111111" stroke-width="2.2" stroke-linejoin="round"/>
      <!-- Mascot Eyes -->
      <circle cx="18" cy="18" r="1.8" fill="#111111"/>
      <circle cx="26" cy="18" r="1.8" fill="#111111"/>
      <!-- Paper Clip Pink/Red Accent on Top Left -->
      <path d="M10 13.5C8.89543 13.5 8 12.6046 8 11.5C8 10.3954 8.89543 9.5 10 9.5H16C17.6569 9.5 19 10.8431 19 12.5C19 14.1569 17.6569 15.5 16 15.5H11.5" stroke="#F43F5E" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `,

  tiktok: (size = 20) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64c.298-.002.595.042.88.13V9.4a6.33 6.33 0 0 0-.88-.06 6.34 6.34 0 1 0 6.34 6.33V8.87a8.28 8.28 0 0 0 4.82 1.54V6.97a4.85 4.85 0 0 1-1.05-.28z"/>
    </svg>
  `,

  instagram: (size = 20) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
    </svg>
  `,

  youtube: (size = 20) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
    </svg>
  `,
};
