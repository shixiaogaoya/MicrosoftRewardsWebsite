import { findClaimButton, findCloseButton, isClaimable } from './claimCard';
import { recognizeSignedOut } from './rewardsRecognition';
import { waitForMatch } from './waitForMatch';

// The dashboard renders async, so each step waits for what it clicks. Both waits
// are bounded: "nothing to claim" is an ordinary day, not a failure.
const CLAIM_CARD_TIMEOUT_MS = 15000;
const CLAIM_DIALOG_TIMEOUT_MS = 10000;
// A flyout control that is disabled the very instant it appears may just still
// be loading: reading that snapshot as "nothing pending" made a transient state
// authoritative — the pre-click twin of the post-click rule further down. Only
// a control that stays disabled for this whole bounded window is reported as
// nothing to claim.
const CLAIM_CLAIMABLE_TIMEOUT_MS = 5000;
// After the confirm click we wait, bounded, for anything observable to change.
// The wait is NOT evidence: a control that disables or a flyout that closes can
// be the request still in flight, so the outcome below stays unconfirmed either
// way. What the wait buys is not slamming the flyout shut mid-request.
const CLAIM_CONFIRM_TIMEOUT_MS = 8000;

// Reported rather than logged, so the caller (and the tests) can tell a real
// outcome from the several ways there is simply nothing to do — and from a click
// that never produced a success state we can observe. There is no 'claimed':
// no verified completion marker exists for this page (A08), so a click that
// lands is reported as `clickedUnverified`, never as points earned.
// `controlRemoved` is the confirm control vanishing mid-wait (flyout closed,
// SPA re-render): whatever replaced it was never seen, so unlike
// `nothingToClaim` it is unconfirmed, not a definite nothing-to-do.
export type ClaimOutcome =
    | 'nothingToClaim'
    | 'noCard'
    | 'noDialog'
    | 'controlRemoved'
    | 'clickedUnverified'
    | 'signedOut'
    | 'cancelled';

// Sentinel the claimable wait resolves with when the control leaves the DOM
// mid-wait: a detached node can never become claimable, so waiting on it to
// time out would read a control we lost as a definitive nothingToClaim.
const CONTROL_REMOVED = 'control-removed';

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
    if (!card) return recognizeSignedOut(root) ? 'signedOut' : 'noCard';
    card.click();

    const claimButton = await waitForMatch(() => findClaimButtonInDialog(root), CLAIM_DIALOG_TIMEOUT_MS, root);
    if (await cancelled()) return 'cancelled';
    if (!claimButton) return 'noDialog';

    // The probe checks for detachment first, the same containment guard
    // claimEffectObserved and dismissDialog use: the user can close the flyout
    // or the SPA can re-render it during this wait, and the captured button
    // would otherwise sit detached forever — its timeout is not evidence that
    // nothing was pending.
    const ready = await waitForMatch((): HTMLButtonElement | typeof CONTROL_REMOVED | null => {
        if (!root.contains(claimButton)) return CONTROL_REMOVED;
        return isClaimable(claimButton) ? claimButton : null;
    }, CLAIM_CLAIMABLE_TIMEOUT_MS, root);
    if (await cancelled()) return 'cancelled';
    if (ready === CONTROL_REMOVED) return 'controlRemoved';
    if (!ready) {
        dismissDialog(claimButton, root);
        return 'nothingToClaim';
    }
    claimButton.click();
    const observed = await waitForMatch(() => claimEffectObserved(claimButton, root), CLAIM_CONFIRM_TIMEOUT_MS, root);
    // Close the flyout only once the page visibly acted on the click; with
    // nothing observed we touch the page no further. Either way the click is
    // unverified — the observation is not proof the claim landed.
    if (observed) dismissDialog(claimButton, root);
    return 'clickedUnverified';
}

// Anything observable after the confirm click: the control stops being claimable,
// or the flyout (and with it the button) leaves the DOM. Observed only to time
// the dismiss — neither state is proof the claim landed, which is exactly why
// claimPoints returns `clickedUnverified` whether this fires or not.
function claimEffectObserved(claimButton: HTMLButtonElement, root: ParentNode & Node): true | null {
    return !root.contains(claimButton) || !isClaimable(claimButton) ? true : null;
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
