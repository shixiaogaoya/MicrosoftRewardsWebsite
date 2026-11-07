import { describe, it, expect } from 'vitest';
import {
    RECOGNIZER_VERSION,
    causeReason,
    claimTaskResult,
    dailySignedOutResult,
    dailyWaitExpiredCause,
    readDailyPage,
    recognizeSignedOut,
    type RecognitionCause,
} from './rewardsRecognition';

// 真实脱敏样本（fixtures/rewards-signed-out.html）：2026-11-07 匿名只读加载
// 未登录 rewards.bing.com 的记录。只用已知结构（现有测试夹具）与该样本，
// 不猜测线上 selector。
import SIGNED_OUT_SAMPLE from './fixtures/rewards-signed-out.html?raw';

function sampleRoot(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.append(root);
    return root;
}

// 已知卡片结构：登录后的每日活动网格（形状来自现有 dailyAnchors 夹具）。
function signedInGrid(): HTMLElement {
    return sampleRoot(`
      <div class="grid">
        <a href="https://www.bing.com/search?q=Trip+to+Tokyo&FORM=tgrew4">tokyo</a>
        <a href="https://www.bing.com/search?q=Berlin+quiz&form=dsetqu">quiz</a>
      </div>`);
}

describe('recognizeSignedOut', () => {
    it('recognises the real logged-out sample by its /auth/login entry', () => {
        expect(recognizeSignedOut(sampleRoot(SIGNED_OUT_SAMPLE))).toBe(true);
    });

    // 未登录打开 /dashboard 会跳转到账户登录页（2026-11-07 匿名检查观察到
    // login.live.com 页面）；同源 /auth/login 是营销页变体的入口。两种都要认。
    it('still recognises an absolute account sign-in link', () => {
        const root = sampleRoot('<a href="https://login.live.com/login.srf">Sign in</a>');
        expect(recognizeSignedOut(root)).toBe(true);
    });

    it('accepts the /auth/login entry with query parameters', () => {
        const root = sampleRoot('<a href="/auth/login?ru=%2Fdashboard">登录</a>');
        expect(recognizeSignedOut(root)).toBe(true);
    });

    it('does not treat an ordinary dashboard as signed out', () => {
        expect(recognizeSignedOut(signedInGrid())).toBe(false);
    });
});

describe('readDailyPage', () => {
    it('reads a known grid as cards (recognition success on a known structure)', () => {
        const reading = readDailyPage(signedInGrid());
        expect(reading.state).toBe('cards');
        if (reading.state === 'cards') {
            expect(reading.anchors.map((a) => a.textContent)).toEqual(['tokyo', 'quiz']);
        }
    });

    // 回归（来自真实未登录样本）：营销页 div.grid 里带 form 参数的推广链接
    // （Edge / Microsoft Store）会被发现层的 form 规则匹配到。识别出未登录后
    // 必须停在“未登录”，绝不能把这些当成每日活动卡片去点击。
    it('reads the real logged-out sample as signed-out, never as cards', () => {
        const reading = readDailyPage(sampleRoot(SIGNED_OUT_SAMPLE));
        expect(reading).toEqual({ state: 'signed-out' });
    });

    it('reads a grid without recognisable cards as unknown, not as "nothing to do"', () => {
        const root = sampleRoot(`
          <div class="grid">
            <a href="/redeem">Redeem</a>
          </div>`);
        expect(readDailyPage(root)).toEqual({ state: 'unknown' });
    });

    it('reads an empty page as unknown while it may still be rendering', () => {
        expect(readDailyPage(sampleRoot('<div></div>'))).toEqual({ state: 'unknown' });
    });
});

describe('dailyWaitExpiredCause', () => {
    // 结构变化：网格渲染了但没有一张可识别卡片——无法区分“今日没有任务”
    // 与“页面改版”，归为结构未知而不是超时或无需执行。
    it('says unknown-structure when a grid rendered without recognisable cards', () => {
        const root = sampleRoot('<div class="grid"><a href="/redeem">Redeem</a></div>');
        expect(dailyWaitExpiredCause(root)).toBe('unknown-structure');
    });

    it('says timeout when the dashboard never rendered at all', () => {
        expect(dailyWaitExpiredCause(sampleRoot('<div></div>'))).toBe('timeout');
    });

    it('reports the signed-out page as failed 未登录', () => {
        expect(dailySignedOutResult()).toEqual({ status: 'failed', reason: '未登录' });
    });
});

describe('causeReason', () => {
    const CAUSES: RecognitionCause[] = [
        'nothing-pending',
        'control-missing',
        'timeout',
        'unknown-structure',
        'no-completion-marker',
    ];

    it('gives every cause its own sentence, stamped with the recognizer version', () => {
        const reasons = new Set(CAUSES.map((cause) => causeReason(cause)));
        expect(reasons.size).toBe(CAUSES.length);
        for (const reason of reasons) {
            expect(reason).toContain(`（识别器 v${RECOGNIZER_VERSION}）`);
        }
    });

    it('uses the flow context when one is given', () => {
        expect(causeReason('no-completion-marker', '已点击 3 张卡片，页面没有完成标记'))
            .toBe(`已点击 3 张卡片，页面没有完成标记（识别器 v${RECOGNIZER_VERSION}）`);
    });
});

describe('claimTaskResult', () => {
    it('maps a flyout that says nothing pending to not-needed with the cause', () => {
        const result = claimTaskResult('nothingToClaim');
        expect(result.status).toBe('not-needed');
        expect(result.reason).toContain('没有待领取');
        expect(result.reason).toContain(`识别器 v${RECOGNIZER_VERSION}`);
    });

    // 完成判据（A08）：点击后禁用/弹层关闭都不是完成。领取没有 'claimed'
    // 结果——clickUnverified 必须落到待确认，并说明缺少完成标记。
    it('maps a landed click to unconfirmed with the no-completion-marker cause', () => {
        const result = claimTaskResult('clickedUnverified');
        expect(result.status).toBe('unconfirmed');
        expect(result.reason).toContain('可验证的完成状态');
    });

    it('carries machine-readable cause and recognizer version on recognizer-written rows', () => {
        expect(claimTaskResult('clickedUnverified')).toMatchObject({
            cause: 'no-completion-marker',
            recognizerVersion: RECOGNIZER_VERSION,
        });
        expect(claimTaskResult('nothingToClaim')).toMatchObject({
            cause: 'nothing-pending',
            recognizerVersion: RECOGNIZER_VERSION,
        });
        // 后台超时/中断路径写入的结果不经过识别器：没有这两个字段。
        expect(dailySignedOutResult().cause).toBeUndefined();
    });

    it('maps a missing card and an unopened dialog to distinct unconfirmed causes', () => {
        expect(claimTaskResult('noCard').reason).not.toBe(claimTaskResult('noDialog').reason);
        expect(claimTaskResult('noCard').cause).not.toBe(claimTaskResult('noDialog').cause);
        expect(claimTaskResult('noCard').status).toBe('unconfirmed');
        expect(claimTaskResult('noDialog').status).toBe('unconfirmed');
    });

    it('maps signed out to failed and cancelled to cancelled', () => {
        expect(claimTaskResult('signedOut')).toEqual({ status: 'failed', reason: '未登录' });
        expect(claimTaskResult('cancelled')).toEqual({ status: 'cancelled', reason: '已停止' });
    });
});
