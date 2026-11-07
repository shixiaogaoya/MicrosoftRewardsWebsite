// The dashboard's "Ready to claim" card and the confirm control inside the
// flyout it opens are both buttons wrapping this icon. Every label on them
// ("Ready to claim", "Claim", "Claim points", the image alt) is localised, and
// Bing's utility classes are hashed per build — the icon name is the only stable,
// locale-independent handle. The sibling "Available points" card uses
// `OMR.Icons.Coins.svg`, so matching the longer name keeps the two apart.
const CLAIM_ICON_SELECTOR = 'img[src*="OMR.Icons.CoinsTransparent"]';

// Finds the claim control within `root`. Run against the document it returns the
// dashboard card; run against the open dialog it returns the confirm button.
// Scope matters: the dashboard card stays in the DOM behind the flyout.
//
// Deliberately not `button:has(img[...])` — Firefox only shipped `:has()` in 121
// and the extension still supports 91, where such a selector throws.
export function findClaimButton(root: ParentNode): HTMLButtonElement | null {
    for (const icon of root.querySelectorAll<HTMLImageElement>(CLAIM_ICON_SELECTOR)) {
        // The visible "Claim points" pill is a presentational div inside the
        // button, so clicking the label does nothing — climb to the real button.
        const button = icon.closest('button');
        if (button) return button;
    }
    return null;
}

// A `data-disabled` attribute used to count as "not claimable" whatever its
// value (F05). A control carrying `data-disabled="false"` is explicitly usable,
// and reading it as disabled skipped a real claim as "nothing to do".
function marksDisabled(el: Element): boolean {
    const value = el.getAttribute('data-disabled');
    return value !== null && value !== 'false';
}

// Whether pressing the button would actually claim anything. Once the points are
// claimed the markup is unchanged apart from `data-disabled="true"` on the inner
// pill, which is a cheaper and more robust signal than reading the points total
// or the "Pending" badge. The element's own disabled markers are checked too, in
// case the flyout ever moves the state up to the button.
export function isClaimable(button: HTMLButtonElement): boolean {
    if (button.disabled || marksDisabled(button)) return false;
    for (const marked of button.querySelectorAll('[data-disabled]')) {
        if (marksDisabled(marked)) return false;
    }
    return true;
}

// The flyout's dismiss control. `aria-label="Close"` is localised; the slot the
// dialog component assigns is not.
export function findCloseButton(root: ParentNode): HTMLElement | null {
    return root.querySelector<HTMLElement>('[slot="close"]');
}
