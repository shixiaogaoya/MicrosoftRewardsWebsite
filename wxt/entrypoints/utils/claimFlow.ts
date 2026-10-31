import { findClaimButton, findCloseButton, isClaimable } from './claimCard';
import { waitForMatch } from './waitForMatch';

// The dashboard renders async, so each step waits for what it clicks. Both waits
// are bounded: "nothing to claim" is an ordinary day, not a failure.
const CLAIM_CARD_TIMEOUT_MS = 15000;
const CLAIM_DIALOG_TIMEOUT_MS = 10000;
// After the confirm click we wait for a state we can see change. A fixed pause
// is not evidence that the claim landed.
const CLAIM_CONFIRM_TIMEOUT_MS = 8000;

// Reported rather than logged, so the caller (and the tests) can tell a real
// claim from the several ways there is simply nothing to do — and from a click
// that never produced a success state we can observe.
export type ClaimOutcome = 'claimed' | 'nothingToClaim' | 'noCard' | 'noDialog' | 'unconfirmed' | 'signedOut' | 'cancelled';

// The dashboard's "Ready to claim" card is only a trigger: it opens a flyout
// whose own card carries the button that actually claims. So this is two clicks,
// and the flyout is what reveals whether anything was pending at all. `cancelled`
// is checked before each click, so a stop that lands during either wait does not
// press the next control.
export async function claimPoints(
    root: ParentNode & Node = document,
    cancelled: () => Promise<boolean> = async () => false
): Promise<ClaimOutcome> {
    const card = await waitForMatch(() => findClaimButton(root), CLAIM_CARD_TIMEOUT_MS, root);
    if (await cancelled()) return 'cancelled';
    if (!card) return hasSignInLink(root) ? 'signedOut' : 'noCard';
    card.click();

    const claimButton = await waitForMatch(() => findClaimButtonInDialog(root), CLAIM_DIALOG_TIMEOUT_MS, root);
    if (await cancelled()) return 'cancelled';
    if (!claimButton) return 'noDialog';

    if (!isClaimable(claimButton)) {
        dismissDialog(claimButton, root);
        return 'nothingToClaim';
    }
    claimButton.click();
    const confirmed = await waitForMatch(
        () => claimSettled(claimButton, root),
        CLAIM_CONFIRM_TIMEOUT_MS,
        root
    );
    if (!confirmed) return 'unconfirmed';
    dismissDialog(claimButton, root);
    return 'claimed';
}

// The only success signals this page currently exposes: the confirm control
// becomes disabled, or the flyout that held it goes away. A button that stays
// clickable is not a claim, however long we wait.
// A signed-out dashboard shows a sign-in link instead of the claim card. The
// content script only runs on rewards.bing.com, so the address bar never leaves
// that host; the link is the signal we can actually see.
export function hasSignInLink(root: ParentNode): boolean {
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        if (/login\.live\.com|login\.microsoftonline\.com/i.test(anchor.href)) return true;
    }
    return false;
}

function claimSettled(claimButton: HTMLButtonElement, root: ParentNode & Node): true | null {
    if (!root.contains(claimButton)) return true;
    return isClaimable(claimButton) ? null : true;
}

// Scoped to the flyout on purpose: the dashboard card is still in the DOM behind
// it and carries the same icon, so an unscoped search would find the trigger
// again and click it a second time.
function findClaimButtonInDialog(root: ParentNode): HTMLButtonElement | null {
    for (const dialog of root.querySelectorAll('[role="dialog"]')) {
        const button = findClaimButton(dialog);
        if (button) return button;
    }
    return null;
}

// Close the flyout so a dashboard the user had open themselves isn't left stuck
// behind it. If the flyout closed itself on claiming, the button is detached and
// there is nothing to dismiss.
function dismissDialog(withinDialog: HTMLElement, root: ParentNode & Node): void {
    if (!root.contains(withinDialog)) return;
    const dialog = withinDialog.closest('[role="dialog"]');
    if (dialog) findCloseButton(dialog)?.click();
}
