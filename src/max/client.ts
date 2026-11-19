import { Bot } from "@maxhub/max-bot-api";
import type { Api, FetchFn } from "@maxhub/max-bot-api";
import type {
  ActionResponse,
  BotCommand,
  BotInfo,
  InlineKeyboardAttachmentRequest,
  Message,
  MessageTextFormat,
} from "@maxhub/max-bot-api/types";
import { createMaxFetch, type RetryPolicy } from "./fetch.js";
import { TokenBucket } from "./rate-limit.js";

// Транспорт MAX поверх официального SDK. Граф диалога — свой (data-driven),
// а здесь только отправка и правка сообщений, ответы на колбэки и корректная
// обработка ответов вида `{ success: false }` (MAX отдаёт их с HTTP 200).

// SDK не экспортирует *Extra-типы из корня, поэтому выводим их из сигнатур.
type SendExtra = NonNullable<Parameters<Api["sendMessageToChat"]>[2]>;
type EditExtra = NonNullable<Parameters<Api["editMessage"]>[1]>;
type CallbackExtra = NonNullable<Parameters<Api["answerOnCallback"]>[1]>;
type CallbackBody = NonNullable<CallbackExtra["message"]>;

export class MaxActionError extends Error {
  constructor(
    readonly action: string,
    message: string,
  ) {
    super(`MAX ${action}: ${message}`);
    this.name = "MaxActionError";
  }
}

export interface MaxClientOptions {
  token: string;
  baseUrl?: string;
  /** Подмена транспорта (тесты): лимит частоты и повторы тогда не применяются. */
  fetch?: FetchFn;
  rateLimit?: { capacity: number; refillPerSecond: number };
  retry?: Partial<RetryPolicy>;
}

export interface SendMessageParams {
  chatId: number;
  text: string;
  keyboard?: InlineKeyboardAttachmentRequest;
  format?: MessageTextFormat;
  disableLinkPreview?: boolean;
  notify?: boolean;
}

export interface EditMessageParams {
  messageId: string;
  text?: string;
  /** null — убрать клавиатуру. */
  keyboard?: InlineKeyboardAttachmentRequest | null;
  format?: MessageTextFormat;
}

export interface CallbackMessage {
  text?: string;
  keyboard?: InlineKeyboardAttachmentRequest;
  format?: MessageTextFormat;
}

export interface AnswerCallbackParams {
  callbackId: string;
  /** Всплывающее уведомление пользователю (или ошибка). */
  notification?: string;
  /** Сообщение, которым можно заменить исходное. */
  message?: CallbackMessage;
}

export class MaxClient {
  readonly api: Api;

  constructor(options: MaxClientOptions) {
    const limiter = new TokenBucket({
      capacity: options.rateLimit?.capacity ?? 25,
      refillPerSecond: options.rateLimit?.refillPerSecond ?? 25,
    });
    const fetch = options.fetch ?? createMaxFetch({ limiter, ...options.retry });
    const bot = new Bot(options.token, {
      clientOptions: { ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), fetch },
    });
    this.api = bot.api;
  }

  /** Информация о боте — заодно проверка, что токен живой. */
  getMe(): Promise<BotInfo> {
    return this.api.getMyInfo();
  }

  async sendMessage(params: SendMessageParams): Promise<Message> {
    const extra: SendExtra = {};
    if (params.keyboard) extra.attachments = [params.keyboard];
    if (params.format) extra.format = params.format;
    if (params.disableLinkPreview !== undefined) extra.disable_link_preview = params.disableLinkPreview;
    if (params.notify !== undefined) extra.notify = params.notify;
    return this.api.sendMessageToChat(params.chatId, params.text, extra);
  }

  async editMessage(params: EditMessageParams): Promise<void> {
    const extra: EditExtra = {};
    if (params.text !== undefined) extra.text = params.text;
    if (params.keyboard !== undefined) extra.attachments = params.keyboard ? [params.keyboard] : null;
    if (params.format !== undefined) extra.format = params.format;
    this.assertOk("editMessage", await this.api.editMessage(params.messageId, extra));
  }

  async answerCallback(params: AnswerCallbackParams): Promise<void> {
    const extra: CallbackExtra = {};
    if (params.notification !== undefined) extra.notification = params.notification;
    if (params.message !== undefined) {
      const body: CallbackBody = {};
      if (params.message.text !== undefined) body.text = params.message.text;
      if (params.message.keyboard) body.attachments = [params.message.keyboard];
      if (params.message.format !== undefined) body.format = params.message.format;
      extra.message = body;
    }
    this.assertOk("answerOnCallback", await this.api.answerOnCallback(params.callbackId, extra));
  }

  async setCommands(commands: BotCommand[]): Promise<void> {
    await this.api.setMyCommands(commands);
  }

  private assertOk(action: string, response: ActionResponse): void {
    if (!response.success) {
      throw new MaxActionError(action, response.message);
    }
  }
}
