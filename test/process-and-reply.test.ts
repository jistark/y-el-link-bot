import { describe, expect, it } from 'bun:test';
import { processAndReply } from '../src/bot/handlers/process-and-reply.js';
import type { CreatePageResult } from '../src/formatters/telegraph.js';
import type { PendingRequest } from '../src/bot/state.js';

// Tests use a fake ctx that records every api method call so we can
// assert *what* the handler asked Telegram to do (and in what order)
// without going near grammy internals.

interface ApiCall { method: string; args: unknown[]; }

function makeCtx(opts: {
  fromUsername?: string;
  fromFirstName?: string;
  fromId?: number;
  chatId?: number;
  messageId?: number;
  replyToMessageId?: number;
  threadId?: number;
  replyTargetThreadId?: number;
  replyTargetIsBot?: boolean;
  text?: string;
}): { ctx: any; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (method === 'sendMessage') return { message_id: 9999, chat: { id: opts.chatId ?? 1 } };
    return { ok: true };
  };
  const reply = async (text: string, other?: any) => {
    calls.push({ method: 'reply', args: [text, other] });
    return { message_id: 8888, chat: { id: opts.chatId ?? 1 } };
  };
  const ctx: any = {
    api: {
      sendMessage: record('sendMessage'),
      editMessageText: record('editMessageText'),
      deleteMessage: record('deleteMessage'),
    },
    reply,
    chat: { id: opts.chatId ?? 1 },
    from: opts.fromUsername || opts.fromFirstName ? {
      id: opts.fromId ?? 7,
      username: opts.fromUsername,
      first_name: opts.fromFirstName,
    } : undefined,
    message: {
      message_id: opts.messageId ?? 100,
      text: opts.text,
      message_thread_id: opts.threadId,
      reply_to_message: opts.replyToMessageId ? {
        message_id: opts.replyToMessageId,
        message_thread_id: opts.replyTargetThreadId,
        from: { is_bot: opts.replyTargetIsBot ?? false },
      } : undefined,
    },
    msg: {
      message_id: opts.messageId ?? 100,
      message_thread_id: opts.threadId,
    },
  };
  return { ctx, calls };
}

const RESULT: CreatePageResult = {
  url: 'https://telegra.ph/test-page',
  path: 'test-page',
};

function makeReq(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return {
    originalUrl: 'https://example.com/article',
    originalMessageId: 100,
    originalText: 'mira https://example.com/article',
    userId: 42,
    username: 'alice',
    firstName: 'Alice',
    chatId: 1,
    botMessageId: 200,
    timeoutId: setTimeout(() => {}, 0),
    cancelled: false,
    ...overrides,
  };
}

function findCall(calls: ApiCall[], method: string): ApiCall | undefined {
  return calls.find(c => c.method === method);
}

describe('processAndReply — without a PendingRequest (cache hit)', () => {
  it('replies with bare URL when message is not a reply', async () => {
    const { ctx, calls } = makeCtx({ fromUsername: 'alice', fromFirstName: 'Alice' });
    await processAndReply(ctx, 'https://example.com/x', RESULT);
    const reply = findCall(calls, 'reply')!;
    expect(reply.args[0]).toBe(RESULT.url);
    expect((reply.args[1] as any).parse_mode).toBe('HTML');
  });

  it('builds a "@user compartió:" mention when user has username and is replying', async () => {
    // Replying to a non-bot in the same thread → reply_to is preserved.
    const { ctx, calls } = makeCtx({
      fromUsername: 'alice', fromFirstName: 'Alice', fromId: 42,
      replyToMessageId: 50, threadId: 3, replyTargetThreadId: 3,
    });
    await processAndReply(ctx, 'https://example.com/x', RESULT);
    const send = findCall(calls, 'sendMessage')!;
    const text = send.args[1] as string;
    expect(text).toContain('@alice compartió:');
    expect(text).toContain(RESULT.url);
    const opts = send.args[2] as any;
    expect(opts.reply_to_message_id).toBe(50);
    expect(opts.message_thread_id).toBe(3);
  });

  it('drops reply_to when the reply target is in a different thread', async () => {
    const { ctx, calls } = makeCtx({
      fromFirstName: 'Bob', fromId: 7,
      replyToMessageId: 50, threadId: 3, replyTargetThreadId: 9,
    });
    await processAndReply(ctx, 'https://example.com/x', RESULT);
    const send = findCall(calls, 'sendMessage')!;
    const opts = send.args[2] as any;
    expect(opts.reply_to_message_id).toBeUndefined();
    expect(opts.message_thread_id).toBe(3); // thread preserved
  });

  it('drops reply_to when the target is a bot', async () => {
    // Telegram silently moves replies-to-bot into the General topic — we
    // sacrifice the visual reply chain to keep correct topic placement.
    const { ctx, calls } = makeCtx({
      fromFirstName: 'Bob', fromId: 7,
      replyToMessageId: 50, threadId: 3, replyTargetThreadId: 3,
      replyTargetIsBot: true,
    });
    await processAndReply(ctx, 'https://example.com/x', RESULT);
    const send = findCall(calls, 'sendMessage')!;
    const opts = send.args[2] as any;
    expect(opts.reply_to_message_id).toBeUndefined();
  });

  it('escapes HTML in first_name when building tg://user mention', async () => {
    const { ctx, calls } = makeCtx({
      fromFirstName: 'A & <b>Hax</b>', fromId: 7,
      replyToMessageId: 50,
    });
    await processAndReply(ctx, 'https://example.com/x', RESULT);
    const send = findCall(calls, 'sendMessage')!;
    const text = send.args[1] as string;
    expect(text).toContain('A &amp; &lt;b&gt;Hax&lt;/b&gt;');
    expect(text).not.toContain('<b>Hax</b>');
  });
});

describe('processAndReply — with a PendingRequest (post-grace extraction)', () => {
  it('edits the placeholder when message was direct (no reply_to)', async () => {
    const { ctx, calls } = makeCtx({});
    // originalText with no extra prose besides the URL → "compartió:" form.
    const req = makeReq({
      replyToMessageId: undefined,
      originalText: 'https://example.com/article',
    });
    await processAndReply(ctx, req.originalUrl, RESULT, req);
    const editCall = findCall(calls, 'editMessageText');
    expect(editCall).toBeDefined();
    const text = editCall!.args[2] as string;
    expect(text).toContain('@alice compartió:');
    expect(text).toContain(RESULT.url);
  });

  it('uses sendMessage with reply_to when the original message was a reply', async () => {
    const { ctx, calls } = makeCtx({});
    const req = makeReq({
      replyToMessageId: 50, threadId: 3, replyTargetThreadId: 3,
      replyTargetIsBot: false,
    });
    await processAndReply(ctx, req.originalUrl, RESULT, req);
    const send = findCall(calls, 'sendMessage')!;
    const opts = send.args[2] as any;
    expect(opts.reply_to_message_id).toBe(50);
    expect(opts.message_thread_id).toBe(3);
  });

  it('drops reply_to when the reply was to a bot', async () => {
    const { ctx, calls } = makeCtx({});
    const req = makeReq({
      replyToMessageId: 50, threadId: 3, replyTargetThreadId: 3,
      replyTargetIsBot: true,
    });
    await processAndReply(ctx, req.originalUrl, RESULT, req);
    const send = findCall(calls, 'sendMessage')!;
    const opts = send.args[2] as any;
    expect(opts.reply_to_message_id).toBeUndefined();
    expect(opts.message_thread_id).toBe(3);
  });

  it('renders extra prose from the original message when it is not just a URL', async () => {
    const { ctx, calls } = makeCtx({});
    const req = makeReq({
      originalText: 'Mirá esto pibe https://example.com/x lol',
    });
    await processAndReply(ctx, req.originalUrl, RESULT, req);
    const editCall = findCall(calls, 'editMessageText')!;
    const text = editCall.args[2] as string;
    expect(text).toContain('Mirá esto pibe  lol');
    expect(text).toContain(RESULT.url);
  });

  it('falls back to first_name + tg://user link when username is absent', async () => {
    const { ctx, calls } = makeCtx({});
    const req = makeReq({ username: undefined, firstName: 'Sin Username' });
    await processAndReply(ctx, req.originalUrl, RESULT, req);
    const editCall = findCall(calls, 'editMessageText')!;
    const text = editCall.args[2] as string;
    expect(text).toContain('<a href="tg://user?id=42">Sin Username</a>');
  });
});
