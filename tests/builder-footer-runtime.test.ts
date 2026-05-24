/**
 * Tests for pure utility functions exported from src/card/builder.ts.
 */

import { describe, expect, it } from 'vitest';
import { buildCardContent, compactNumber, formatFooterRuntimeSegments } from '../src/card/builder';
import type { ToolUseDisplayStep } from '../src/card/tool-use-display';

// ---------------------------------------------------------------------------
// compactNumber
// ---------------------------------------------------------------------------

describe('compactNumber', () => {
  it('formats values across ranges', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(999)).toBe('999');
    expect(compactNumber(1000)).toBe('1.0k');
    expect(compactNumber(1250)).toBe('1.3k');
    expect(compactNumber(100_000)).toBe('100k');
    expect(compactNumber(1_000_000)).toBe('1.0m');
    expect(compactNumber(123_456_789)).toBe('123m');
  });
});

// ---------------------------------------------------------------------------
// formatFooterRuntimeSegments
// ---------------------------------------------------------------------------

describe('formatFooterRuntimeSegments', () => {
  it('renders configured runtime metrics as mobile-first lines', () => {
    const result = formatFooterRuntimeSegments({
      footer: {
        status: true,
        elapsed: true,
        tokens: true,
        cache: true,
        context: true,
        model: true,
      },
      elapsedMs: 12_300,
      metrics: {
        inputTokens: 1200,
        outputTokens: 3500,
        cacheRead: 800,
        cacheWrite: 200,
        totalTokens: 4500,
        totalTokensFresh: true,
        contextTokens: 128000,
        model: 'claude-opus-4-6',
      },
    });

    // Returns string[] — one line per info item
    expect(result.length).toBe(2);
    // Line 0: 🪙 Token · ⚡ 缓存 · 🧠 上下文
    expect(result[0]).toContain('🪙');
    expect(result[0]).toContain('1.2k');
    expect(result[0]).toContain('3.5k');
    expect(result[0]).toContain('⚡');
    expect(result[0]).toContain('67%');
    expect(result[0]).toContain('🧠');
    expect(result[0]).toContain('4%');
    // Line 1: ✅ 状态 · ⏱️ 耗时 · 🤖 模型
    expect(result[1]).toContain('✅ 已完成');
    expect(result[1]).toContain('⏱️');
    expect(result[1]).toContain('🤖 claude-opus-4-6');
  });

  it('respects missing metrics and status variants', () => {
    const stopped = formatFooterRuntimeSegments({
      footer: { status: true, tokens: true, cache: true, context: true, model: true },
      isAborted: true,
      metrics: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        totalTokensFresh: false,
        contextTokens: 4096,
        model: ' ',
      },
    });

    expect(stopped[0]).toContain('🪙');
    expect(stopped[0]).toContain('100');
    expect(stopped[0]).toContain('50');
    expect(stopped[1]).toContain('⏸️ 已停止');

    const errored = formatFooterRuntimeSegments({
      footer: { status: true, elapsed: true },
      elapsedMs: 1000,
      isError: true,
    });

    expect(errored[0]).toContain('⏱️');
    // errored[1] may not exist if no detail line
    if (errored.length > 1) expect(errored[1]).toContain('❌ 出错');
  });
});

// ---------------------------------------------------------------------------
// buildCardContent – footer rendered as a single markdown element with \n
// ---------------------------------------------------------------------------

describe('buildCardContent – footer line joining', () => {
  /** Extract footer markdown elements (notation-sized) from the card's top-level elements array. */
  function footerElements(card: ReturnType<typeof buildCardContent>) {
    const elements = (card as { elements?: Array<Record<string, unknown>> }).elements ?? [];
    return elements.filter((el) => el.tag === 'markdown' && el.text_size === 'notation');
  }

  it('merges all footer info into one markdown element with \\n', () => {
    const card = buildCardContent('complete', {
      text: 'hello',
      footer: { status: true, elapsed: true, tokens: true, cache: true, context: true, model: true },
      footerMetrics: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 1200,
        totalTokensFresh: true,
        contextTokens: 128000,
        model: 'test-model',
      },
      elapsedMs: 5000,
    });

    const fes = footerElements(card);

    // Should be exactly ONE footer element
    expect(fes).toHaveLength(1);

    // The content should contain multiple lines (mobile-first layout)
    const content = fes[0].content as string;
    const lines = content.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // No separator when no session stats
    // Line 0: 🪙 Token · ⚡ 缓存 · 🧠 上下文
    expect(lines[0]).toContain('🪙');
    expect(lines[0]).toContain('⚡');
    expect(lines[0]).toContain('🧠');
    // Line 1: ✅ 状态 · ⏱️ 耗时 · 🤖 模型
    expect(lines[1]).toContain('✅ 已完成');
    expect(lines[1]).toContain('⏱️');
    expect(lines[1]).toContain('🤖 test-model');
  });

  it('renders single line when only primary segments exist', () => {
    const card = buildCardContent('complete', {
      text: 'hello',
      footer: { status: true, elapsed: true },
      elapsedMs: 3000,
    });

    const fes = footerElements(card);
    expect(fes).toHaveLength(1);

    const content = fes[0].content as string;
    expect(content).not.toContain('\n');
  });

  it('renders no footer element when all footer flags are off', () => {
    const card = buildCardContent('complete', { text: 'hello' });
    expect(footerElements(card)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildCardContent – tool-use step markdown rendering
// ---------------------------------------------------------------------------

describe('buildCardContent – tool-use step rendering', () => {
  const toolUseContentIndent = '0px 0px 0px 22px';

  function toolUseElements(card: ReturnType<typeof buildCardContent>) {
    const panel = (card.elements[0] ?? {}) as Record<string, unknown>;
    return (panel.elements ?? []) as Array<Record<string, unknown>>;
  }

  it('renders tool-use steps as separate title, detail, and result rows', () => {
    const toolUseSteps = [
      {
        title: 'Run command (2.0 s)',
        detail: 'echo foo > bar',
        status: 'success',
        iconToken: 'setting_outlined',
        resultBlock: {
          language: 'json',
          content: '{\n  "status": "completed",\n  "exitCode": 0\n}',
        },
      },
    ] satisfies ToolUseDisplayStep[];

    const card = buildCardContent('complete', {
      text: 'hello',
      toolUseSteps,
    });

    const panel = (card.elements[0] ?? {}) as Record<string, unknown>;
    const [titleRow, detailRow, outputRow] = toolUseElements(card);
    expect(panel.vertical_spacing).toBe('4px');
    expect(((titleRow?.icon ?? {}) as Record<string, unknown>).color).toBe('grey');
    expect(((titleRow?.text ?? {}) as Record<string, unknown>).tag).toBe('lark_md');
    expect(((titleRow?.text ?? {}) as Record<string, unknown>).text_size).toBe('notation');
    expect(((titleRow?.text ?? {}) as Record<string, unknown>).content).toMatch(/Succeeded|Completed/);
    expect(((titleRow?.text ?? {}) as Record<string, unknown>).content).not.toContain("<font color='grey'>");
    expect(((titleRow?.text ?? {}) as Record<string, unknown>).content).not.toContain('```json');

    expect(((detailRow?.text ?? {}) as Record<string, unknown>).tag).toBe('plain_text');
    expect(((detailRow?.text ?? {}) as Record<string, unknown>).text_color).toBe('grey');
    expect(((detailRow?.text ?? {}) as Record<string, unknown>).text_size).toBe('notation');
    expect(((detailRow?.text ?? {}) as Record<string, unknown>).content).toBe('echo foo > bar');
    expect(((detailRow?.text ?? {}) as Record<string, unknown>).content).not.toContain('\\>');
    expect(detailRow?.margin).toBe(toolUseContentIndent);

    expect(((outputRow?.text ?? {}) as Record<string, unknown>).tag).toBe('lark_md');
    expect(((outputRow?.text ?? {}) as Record<string, unknown>).text_size).toBe('notation');
    expect(((outputRow?.text ?? {}) as Record<string, unknown>).content).toContain('```json');
    expect(((outputRow?.text ?? {}) as Record<string, unknown>).content).toContain('"status": "completed"');
    expect(((outputRow?.text ?? {}) as Record<string, unknown>).content).not.toContain('<br>');
    expect(((outputRow?.text ?? {}) as Record<string, unknown>).content).not.toContain('\n\n**Result**');
    expect(outputRow?.margin).toBe(toolUseContentIndent);
  });

  it('renders tool-use errors as separate detail and fenced output rows', () => {
    const toolUseSteps = [
      {
        title: 'Run command (420 ms)',
        detail: 'cat < input.txt > output.txt',
        status: 'error',
        iconToken: 'setting_outlined',
        errorBlock: {
          language: 'text',
          content: 'exit code 1',
        },
      },
    ] satisfies ToolUseDisplayStep[];

    const card = buildCardContent('complete', {
      text: 'hello',
      toolUseSteps,
    });

    const [titleRow, detailRow, outputRow] = toolUseElements(card);
    expect(((titleRow?.icon ?? {}) as Record<string, unknown>).color).toBe('grey');
    expect(((titleRow?.text ?? {}) as Record<string, unknown>).text_size).toBe('notation');
    expect(((titleRow?.text ?? {}) as Record<string, unknown>).content).toContain('Failed');

    expect(((detailRow?.text ?? {}) as Record<string, unknown>).tag).toBe('plain_text');
    expect(((detailRow?.text ?? {}) as Record<string, unknown>).content).toBe('cat < input.txt > output.txt');
    expect(detailRow?.margin).toBe(toolUseContentIndent);

    expect(((outputRow?.text ?? {}) as Record<string, unknown>).tag).toBe('lark_md');
    expect(((outputRow?.text ?? {}) as Record<string, unknown>).content).toContain('```text');
    expect(((outputRow?.text ?? {}) as Record<string, unknown>).content).toContain('exit code 1');
    expect(outputRow?.margin).toBe(toolUseContentIndent);
  });
});
