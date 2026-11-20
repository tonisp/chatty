// Kaja Chat configuration — customize freely before publishing to GitHub Pages.
export const CONFIG = {
  // Display name shown in the UI and browser tab
  APP_NAME: 'Kaja',

  // Default UI language ('et' or 'en')
  DEFAULT_LANG: 'et',

  // Public Nostr relays used as encrypted transport (zero registration required).
  // Users can also customize relays in the Settings modal, including their own private relay.
  DEFAULT_RELAYS: [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://relay.snort.social',
    'wss://offchain.pub',
  ],

  // Optional front-door gate passcode (SHA-256 hex of passcode string).
  // Leave null to allow anyone with the URL to create/join password-protected rooms.
  // Note: Room-level E2EE is always enforced regardless of this setting.
  SITE_PASSCODE_SHA256: null,

  // STUN servers for optional P2P WebRTC voice & video calls inside rooms
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],

  // Nostr event kinds:
  // 42 = NIP-28 channel message (persisted by relays, kept off social feeds)
  // 20042 = NIP-01 ephemeral range (presence, typing, WebRTC signaling — not stored)
  MSG_KIND: 42,
  EPHEMERAL_KIND: 20042,

  // How many past messages to request per room on initial sync
  HISTORY_LIMIT: 200,
};
