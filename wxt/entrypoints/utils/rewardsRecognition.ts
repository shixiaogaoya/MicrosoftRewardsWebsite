import type { TaskResult, TaskStatus } from './runState';
import { matchDailyAnchors } from './dailyAnchors';
import type { ClaimOutcome } from './claimFlow';

// 识别器版本。识别规则变化时递增。识别层写入的每条“待确认/无需执行”
// 结果都带上它（文案与机读字段同源）；后台超时/中断类待确认不是识别器
// 输出，不带版本戳——存储端据此区分两个体系（A08）。
export const RECOGNIZER_VERSION = 1;

// 结构化的不可确认原因，区分页面说“没有可做的事”和“我们没能理解页面”：
//   nothing-pending     页面自己的控件显示没有待领取内容；
//   control-missing     等待结束后页面里仍没有已知控件；
//   timeout             已知内容等待渲染超时；
//   unknown-structure   页面渲染了内容但不匹配任何已知样本（无法区分
//                       “今日没有任务”与“页面已改版”）；
//   no-completion-marker 已执行点击，页面没有可验证的完成标记。
export const RECOGNITION_CAUSES = [
    'nothing-pending',
    'control-missing',
    'timeout',
    'unknown-structure',
    'no-completion-marker',
] as const;

export type RecognitionCause = (typeof RECOGNITION_CAUSES)[number];

const CAUSE_TEXT: Record<RecognitionCause, string> = {
    'nothing-pending': '页面显示没有待领取的内容',
    'control-missing': '未找到可操作的控件',
    'timeout': '等待页面出现已知内容超时',
    'unknown-structure': '页面结构无法识别：可能今日没有任务，也可能页面已改版',
    'no-completion-marker': '已执行操作，页面未提供可验证的完成标记',
};

// `context` 替换默认句子，供需要说明具体动作的流程使用（如“已点击 3 张卡片”）。
export function causeReason(cause: RecognitionCause, context?: string): string {
    return `${context ?? CAUSE_TEXT[cause]}（识别器 v${RECOGNIZER_VERSION}）`;
}

// 识别层统一的结果构造：显示文案与机读字段（cause/recognizerVersion）同源，
// 存储端无需解析中文文案即可判别原因（A08）。没有这两个字段的结果来自后台
// 的超时/中断路径，不经过识别器。
export function pendingResult(cause: RecognitionCause, context?: string, status: TaskStatus = 'unconfirmed'): TaskResult {
    return { status, reason: causeReason(cause, context), cause, recognizerVersion: RECOGNIZER_VERSION };
}

// 未登录识别，两个信号都来自真实脱敏样本（2026-11-07 匿名只读检查）：
// - 未登录的 rewards.bing.com 营销页用同源 /auth/login 作为登录入口，页面
//   上不出现 login.live.com 字样，只匹配后者会漏判；
// - 未登录打开 /dashboard 会整页跳转到账户登录页（login.live.com）。
// 只读 DOM，不点击、不等待。
export function recognizeSignedOut(root: ParentNode): boolean {
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        if (/login\.live\.com|login\.microsoftonline\.com/i.test(anchor.href)) return true;
        const path = anchor.getAttribute('href');
        if (path != null && /^\/auth\/login(\?|#|$)/.test(path.trim())) return true;
    }
    return false;
}

// 每日活动页的三种可判读状态。发现层（dailyAnchors）只找元素，这里只做判读，
// 动作执行在内容脚本里。
export type DailyPageReading =
    | { state: 'cards'; anchors: HTMLAnchorElement[] }
    | { state: 'signed-out' }
    | { state: 'unknown' };

// 先判未登录再找卡片：未登录营销页的 div.grid 里也有带 form 参数的推广链接
// （真实样本中的 Edge / Microsoft Store 卡片），会被发现层的 form 规则匹配到；
// 识别为未登录后不得执行任何点击。没有登录信号也没有可识别卡片时是 unknown，
// 不是“没有任务”——空网格可能是渲染慢或改版，不能当成“全部完成”。
export function readDailyPage(root: ParentNode): DailyPageReading {
    if (recognizeSignedOut(root)) return { state: 'signed-out' };
    const anchors = matchDailyAnchors(root);
    return anchors.length > 0 ? { state: 'cards', anchors } : { state: 'unknown' };
}

// 等待结束时仍不可判读的原因：渲染出了卡片区域却没有一张可识别卡片，与根本
// 没渲染出仪表板不是一回事。
export function dailyWaitExpiredCause(root: ParentNode): RecognitionCause {
    return root.querySelector('div.grid') != null ? 'unknown-structure' : 'timeout';
}

export function dailySignedOutResult(): TaskResult {
    return { status: 'failed', reason: '未登录' };
}

// 领取执行结果（claimFlow 的 ClaimOutcome）到存储结果的映射。
// 注意没有 'claimed'：点击领取后控件禁用、弹层关闭都可能是请求处理中的临时
// 状态，没有经真实样本证实的完成标记之前，一律不确认完成（A08 完成判据）。
const CLAIM_RESULTS: Record<ClaimOutcome, TaskResult> = {
    // 弹层已打开且它的确认控件在整个有界等待中持续显示不可领取：
    // 这是“明确没有待领内容”。
    nothingToClaim: pendingResult('nothing-pending', '领取窗口显示没有待领取的积分', 'not-needed'),
    noCard: pendingResult('control-missing', '未找到领取入口'),
    noDialog: pendingResult('timeout', '领取窗口未打开'),
    clickedUnverified: pendingResult('no-completion-marker', '已点击领取，未出现可验证的完成状态'),
    signedOut: { status: 'failed', reason: '未登录' },
    cancelled: { status: 'cancelled', reason: '已停止' },
};

export function claimTaskResult(outcome: ClaimOutcome): TaskResult {
    return CLAIM_RESULTS[outcome];
}
