import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/reply-runtime', () => ({ SILENT_REPLY_TOKEN: '__silent__' }));
vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../src/core/lark-client', () => ({ LarkClient: {} }));
vi.mock('../src/core/shutdown-hooks', () => ({ registerShutdownHook: () => () => {} }));
vi.mock('../src/messaging/outbound/send', () => ({
  sendCardFeishu: vi.fn(),
  updateCardFeishu: vi.fn(),
}));
vi.mock('../src/card/cardkit', () => ({
  createCardEntity: vi.fn(),
  sendCardByCardId: vi.fn(),
  setCardStreamingMode: vi.fn(),
  streamCardContent: vi.fn(),
  updateCardKitCard: vi.fn(),
}));
vi.mock('../src/card/flush-controller', () => ({
  FlushController: class {
    constructor() {}
    cancelPendingFlush() {}
    complete() {}
    waitForFlush() { return Promise.resolve(); }
    setCardMessageReady() {}
    throttledUpdate() { return Promise.resolve(); }
  },
}));
vi.mock('../src/card/image-resolver', () => ({
  ImageResolver: class {
    resolveImages(text: string) { return text; }
    resolveImagesAwait(text: string) { return Promise.resolve(text); }
  },
}));
vi.mock('../src/card/unavailable-guard', () => ({
  UnavailableGuard: class {
    shouldSkip() { return false; }
    terminate() { return false; }
    get isTerminated() { return false; }
  },
}));

import { createCardEntity, sendCardByCardId, updateCardKitCard } from '../src/card/cardkit';
import { StreamingCardController } from '../src/card/streaming-card-controller';

function createController(): StreamingCardController {
  return new StreamingCardController({
    cfg: {} as never,
    agentId: 'main',
    sessionKey: 'agent:main:feishu:direct:test',
    accountId: undefined,
    chatId: 'chat-id',
    replyToMessageId: undefined,
    replyInThread: undefined,
    toolUseDisplay: {
      mode: 'off',
      showToolUse: false,
      showToolResultDetails: false,
      showFullPaths: false,
    },
    resolvedFooter: {
      status: false,
      elapsed: false,
      tokens: false,
      cache: false,
      context: false,
      model: false,
      sessionStats: false,
      dailyStats: false,
      monthlyStats: false,
    },
  });
}

function getMarkdownContents(card: Record<string, unknown>): string[] {
  const body = card.body as { elements?: Array<Record<string, unknown>> } | undefined;
  return (body?.elements ?? [])
    .filter((element) => element.tag === 'markdown')
    .map((element) => String(element.content ?? ''));
}

describe('StreamingCardController text lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createCardEntity).mockResolvedValue('card-id');
    vi.mocked(sendCardByCardId).mockResolvedValue({ messageId: 'message-id', chatId: 'chat-id' });
  });

  it('keeps the complete answer when a later partial snapshot is shorter', async () => {
    const completeAnswer = '配置已写入，重启 gateway 生效：';
    const shorterSnapshot = 'y 生效：';
    const controller = createController();

    await controller.onPartialReply({ text: completeAnswer });
    const deliverPromise = controller.onDeliver({ text: completeAnswer });
    await Promise.resolve();
    await controller.onPartialReply({ text: shorterSnapshot });
    await deliverPromise;
    controller.markFullyComplete();
    await controller.onIdle();

    const finalCard = vi.mocked(updateCardKitCard).mock.calls.at(-1)?.[0].card as Record<string, unknown>;
    expect(getMarkdownContents(finalCard)).toContain(completeAnswer);
  });

  it('does not duplicate a partial snapshot that repeats a delivered answer', async () => {
    const answer = '已完成';
    const controller = createController();

    await controller.onDeliver({ text: answer });
    await controller.onPartialReply({ text: answer });
    controller.markFullyComplete();
    await controller.onIdle();

    const finalCard = vi.mocked(updateCardKitCard).mock.calls.at(-1)?.[0].card as Record<string, unknown>;
    expect(getMarkdownContents(finalCard)).toContain(answer);
    expect(getMarkdownContents(finalCard).filter((content) => content === answer)).toHaveLength(1);
  });

  it('keeps the latest cumulative partial snapshot when no deliver has arrived yet', async () => {
    const controller = createController();

    await controller.onPartialReply({ text: '第一版' });
    await controller.onPartialReply({ text: '第一版继续' });
    controller.markFullyComplete();
    await controller.onIdle();

    const finalCard = vi.mocked(updateCardKitCard).mock.calls.at(-1)?.[0].card as Record<string, unknown>;
    expect(getMarkdownContents(finalCard)).toContain('第一版继续');
    expect(getMarkdownContents(finalCard)).not.toContain('第一版\n\n第一版继续');
  });

  it('keeps a later partial segment after a delivered segment', async () => {
    const controller = createController();

    await controller.onDeliver({ text: '第一段' });
    await controller.onPartialReply({ text: '第二段' });
    controller.markFullyComplete();
    await controller.onIdle();

    const finalCard = vi.mocked(updateCardKitCard).mock.calls.at(-1)?.[0].card as Record<string, unknown>;
    expect(getMarkdownContents(finalCard)).toContain('第一段\n\n第二段');
  });

  it('replaces cumulative partial snapshots without duplicating the delivered segment', async () => {
    const controller = createController();

    await controller.onDeliver({ text: '第一段' });
    await controller.onPartialReply({ text: '第一段扩展' });
    await controller.onPartialReply({ text: '第一段扩展更多' });
    controller.markFullyComplete();
    await controller.onIdle();

    const finalCard = vi.mocked(updateCardKitCard).mock.calls.at(-1)?.[0].card as Record<string, unknown>;
    expect(getMarkdownContents(finalCard)).toContain('第一段扩展更多');
    expect(getMarkdownContents(finalCard)).not.toContain('第一段\n\n第一段扩展更多');
  });
});
