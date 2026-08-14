/** Support-chat DTOs (mirrors apps/api/src/app.support.ts response shapes). */
export interface SupportCitation {
  source: string;
  heading: string | null;
}

export interface SupportStartResult {
  conversationId: string;
  siteId: string;
}

export interface SupportAnswerResult {
  answer: string;
  citations: SupportCitation[];
  confidence: number;
  shouldEscalate: boolean;
}

export type SupportConvStatus = 'open' | 'resolved' | 'escalated';

export interface SupportConversationDto {
  id: string;
  siteId: string;
  userId: string | null;
  visitorId: string | null;
  status: SupportConvStatus;
  escalated: boolean;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: string;
  lastAt: string;
}

export interface SupportMessageDto {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources: SupportCitation[];
  confidence: number | null;
  ts: string;
}

export interface SupportThreadDto {
  conversation: SupportConversationDto;
  messages: SupportMessageDto[];
}
