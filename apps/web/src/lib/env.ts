/** Public runtime config. Only NEXT_PUBLIC_* values are available in the browser. */
export const env = {
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8081/api/v1',
  wsUrl: process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8080',
  /** Support chat is DISABLED by default (opt-in). Set NEXT_PUBLIC_SUPPORT_CHAT_ENABLED=true to
   *  re-enable once the widget is redesigned; the backend also gates on SUPPORT_CHAT_ENABLED. */
  supportChatEnabled: process.env.NEXT_PUBLIC_SUPPORT_CHAT_ENABLED === 'true',
} as const;
