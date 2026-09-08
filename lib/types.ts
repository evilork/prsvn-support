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
  /**
   * Размер в байтах. Telegram присылает его у каждого размера фотографии, но
   * обещания в схеме нет — поэтому необязательный. По нему выбирается самый
   * крупный снимок, который влезает в наш предел (см. lib/attachments.ts).
   */
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

/**
 * Кадр предпросмотра — то единственное, что мы можем показать модели от видео.
 *
 * Поле называлось `thumb` и с Bot API 7.0 называется `thumbnail`. Telegram
 * присылает новое имя, но старое встречается у пересланных и у сторонних
 * клиентов, поэтому читаем оба: разница между ними — это разница между
 * «разобрал кадр» и «не смог, идите к оператору».
 */
export interface TgThumbnailed {
  thumbnail?: TgPhotoSize;
  thumb?: TgPhotoSize;
}

export interface TgVideo extends TgThumbnailed {
  file_id: string;
  mime_type?: string;
  file_size?: number;
  duration?: number;
}

/** Кружок. Отличается от видео только формой и отсутствием подписи. */
export interface TgVideoNote extends TgThumbnailed {
  file_id: string;
  file_size?: number;
  duration?: number;
}

/** Гифка. Для Telegram это беззвучное видео, а не картинка. */
export interface TgAnimation extends TgThumbnailed {
  file_id: string;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

export interface TgVoice {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

export interface TgAudio {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

/**
 * Игральная кость, дартс, «баскетбол» — анимированная реплика без содержания.
 *
 * Знать про неё нужно ровно затем, чтобы НЕ заводить по ней тикет: до
 * 08.09.2026 такое сообщение уходило живому оператору как «неизвестное
 * вложение».
 */
export interface TgDice {
  emoji?: string;
  value?: number;
}

export interface TgSticker extends TgThumbnailed {
  file_id: string;
  emoji?: string;
  is_animated?: boolean;
  is_video?: boolean;
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
  video?: TgVideo;
  video_note?: TgVideoNote;
  animation?: TgAnimation;
  voice?: TgVoice;
  audio?: TgAudio;
  sticker?: TgSticker;
  dice?: TgDice;
  /**
   * Альбом: одна пачка, отправленная человеком за раз.
   *
   * Telegram доставляет её НЕСКОЛЬКИМИ обновлениями с общим значением этого
   * поля — собранного альбома в одном сообщении не существует. Как мы с этим
   * поступаем и почему именно так, описано в lib/ai.ts (`claimAlbum`).
   */
  media_group_id?: string;
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
