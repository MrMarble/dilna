import { computeAccessibleName } from "dom-accessibility-api";

/**
 * Guard for the class of bug in issue #223: an icon-only `<button>` whose only
 * naming came from `title`, or — worse — which had no name at all and got
 * announced as a bare "button".
 *
 * The assertion runs the *real* accessible-name computation
 * (`dom-accessibility-api`, the same one `@testing-library`'s `getByRole`
 * consults), so it fails for exactly the thing a screen reader would get
 * wrong.
 *
 * `title` is stripped before naming, deliberately: it is the last-resort
 * accname source, and leaning on it is what let these buttons' names drift
 * state-by-state. A `title`-only button therefore counts as unnamed here — the
 * fix is a stable `aria-label` (or text), not a tooltip.
 *
 * Call it after rendering, ideally with the component's in-flight/disabled
 * states exercised too — the transient states are where the name used to be
 * swapped out wholesale.
 */
export function expectEveryButtonNamed(root: HTMLElement): void {
	const buttons = Array.from(root.querySelectorAll("button"));
	if (buttons.length === 0) {
		throw new Error("No buttons found — did the component render?");
	}

	const unnamed = buttons
		.filter((button) => {
			const title = button.getAttribute("title");
			button.removeAttribute("title");
			try {
				return computeAccessibleName(button).trim() === "";
			} finally {
				if (title !== null) button.setAttribute("title", title);
			}
		})
		.map((button) => button.outerHTML.replace(/\s+/g, " ").slice(0, 140));

	if (unnamed.length > 0) {
		throw new Error(
			`${unnamed.length} button(s) have no accessible name ` +
				`(a \`title\` alone does not count — add \`aria-label\`):\n` +
				unnamed.map((html) => `  ${html}`).join("\n"),
		);
	}
}
