export interface ChannelMessage {
  message: string;
  write: (text: string) => void;
  signal: AbortSignal;
}

export interface ConversationIdentity {
  channel: string;
  conversationId: string;
  userId: string;
}

export interface Conversation {
  handleMessage: (message: ChannelMessage) => Promise<void>;
  dispose: () => void | Promise<void>;
}

export type ConversationFactory = (
  identity: ConversationIdentity,
) => Conversation | Promise<Conversation>;
