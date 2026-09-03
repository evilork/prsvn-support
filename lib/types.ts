// lib/types.ts

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  is_forum?: boolean;
}

export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

export interface TgDocument {
  file_id: string;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  reply_to_message?: TgMessage;
  message_thread_id?: number;
  is_topic_message?: boolean;
  /** Служебное сообщение о создании темы — в ленту клиенту не относится. */
  forum_topic_created?: { name: string };
  forum_topic_closed?: Record<string, never>;
  forum_topic_reopened?: Record<string, never>;
  pinned_message?: TgMessage;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface Update {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type InlineKeyboard = InlineKeyboardButton[][];
