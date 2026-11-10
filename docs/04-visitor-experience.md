# Visitor Experience and Approved Creative Direction

## Characters and setting

- **Paws & Order Cat Hospital:** a fictional cat-only clinic with humorous but believable personalities, warm earth tones, carrot motifs and approved decorative artwork.
- **Hearthy:** owner/front desk, short introductory dialogue. After handing the customer to the terminal, she does not continue narrating the review.
- **Temperance:** named AI invoice assistant, **no avatar or animated character**.
- **Kiosk:** **Paws & Order Billing Assistance Terminal**, with comically outdated `kioskware v16.2.17`-style system labeling. The orange band at the top of the terminal screen reads **TEMPERANCE**, and the kiosk drawn in the hospital interior carries the same **TEMPERANCE** sign.

## Approved interaction principles

- Short cat-encounter intros, approximately Dumpling the Brave's approved length; personalities are modestly heightened and believable. Visitors reach the kiosk quickly. The already issued invoice is in the customer's possession before narration starts.
- Hearthy's handoff line is **“Temperance is next to the front desk, on the right-hand side.”** She says nothing further after the visitor begins interacting with Temperance. The printer is **not** a hospital prop.
- Persistent server-derived daily allowance counter on kiosk interface; read-only quota lookups consume Cloudflare requests but **no Gemini tokens**.
- `View Demonstrations` is always available, including before any attempts, after all attempts, and on service interruption. Demonstrations have a **selectable list**, not random-only playback.
- No visitor free-text inputs and no stored survey responses. Closing feedback screen reads: **“Your satisfaction is our pleasure. Thank you for stopping in, see you next time!”** (approved intent; exact punctuation may be checked against owner UI reference).
- The service-interruption and exhausted-allowance states both expose `View Demonstrations`. The visitor can still browse without triggering a live Gemini request.
- Three rotating kiosk messages, owner-approved (November 2026) and kept verbatim in `config/kiosk-content.json`; the visitor can pause them:
  1. "Temperance will escalate issues found on your behalf. No need to come back in for the same issue twice!"
  2. "Recorded demonstrations are always available and never use one of your live reviews."
  3. "kioskware v16.2.17: If it ain't broke, don't fix it."

## Approved screen inventory to audit in the repository

Hospital exterior/entry; front desk and brief Hearthy handoff; kiosk landing/menu; server-derived allowance counter; invoice selection/review; findings/explanation; selectable demonstrations; allowance exhausted; service interrupted; canned satisfaction/closing; informational/Behind the Desk content as present in finalized materials. Exact art, coordinates, text, voice, timings, and navigation require comparison against the existing owner-approved files before implementation.

## Implemented scenes, text and motion (as built, November 2026)

This section records what the visitor currently sees. Scene artwork is the approved art; the adjustments listed under *Owner-approved art adjustments* are applied when the site is built, and the source artwork files are left unchanged.

### Hospital exterior

- The approved exterior scene, with **Go inside** below it (the door is also clickable).
- **Window flyer:** shortened to two lines, **HELP WANTED** and **Apply Inside**, on a wider, much shorter sheet that sits on the window glass. Its text is larger than before, and "HELP WANTED" is fitted to the paper's width so it always stays on the sheet.
- **Door notice:** larger card on the same hanging string, reading **Please be patient.** and **Short staffed.** in larger type.
- **Motion:** clouds drift slowly, and the tree canopy sways gently (about two degrees each way on a four-second swing).

### Front desk interior and Hearthy

- Hearthy speaks in a **subtitle-style dialogue panel** joined to the bottom of the scene (dark wood-brown band, carrot-orange top edge, speaker name **HEARTHY** above her line). The panel covers no artwork; it replaced the earlier speech bubble, which overlapped the fan.
- **Continue** and **Skip to the terminal** are inside the panel. The last line's button reads **Use the terminal**.
- The scene is sized to the window height, so the panel and its buttons stay visible without scrolling on short desktop windows; on narrow scenes the buttons move under the line, and on phones the panel stacks below the art with full-width buttons.
- **Hearthy's lines** (`config/kiosk-content.json`, draft pending owner review):
  1. "Welcome to Paws & Order. Mind the paperwork. We're understaffed."
  2. "If you have questions about your invoice Temperance can help you at the kiosk."
  3. "Temperance is next to the front desk, on the right-hand side." (the approved handoff line)
- Returning from the terminal shows Hearthy's last line rather than replaying the introduction; **Start over** begins a new visit and replays it.

### Office animation (interior)

- **Hearthy** blinks, tilts her head and twitches an ear; motion begins as soon as the interior appears (first blink under a second, ear twitch about two seconds in).
- **Oscillating fan:** blades spin continuously and the head swings gently left and right on a 14-second cycle.
- **Pinboard:** the January 2003 calendar and the story flyer flutter on their pins when the fan faces them.
- **Story flyer:** clicking the pinned "The Story of Paws & Order" flyer opens **Behind the Desk** (the header button is the keyboard and screen-reader route). Behind the Desk is the owner's portfolio page for invited reviewers (`config/kiosk-content.json`): project background, how Temperance works, blind-evaluation results with a synthetic-data caveat, security and privacy, and the technology used.
- **Falling papers:** two loose pages take turns (one about every 28 seconds), each lifting off the desk on the fan's swing, drifting down and landing on top of the floor pile. A landed page rests there, then quietly fades and returns to the desk, so the pile never grows without end.
- **Carrot mug:** steam rises gently.
- **Power strip:** a tiny spark pops once every 11 seconds (well below flashing thresholds).
- **Desk bell:** a real button (click or keyboard). It presses and wiggles, and **"Ding!"** floats up and fades. No sound. Repeated rings restart the effect rather than stacking.

### Owner-approved art adjustments (applied at build time)

- The two pages drawn frozen in mid-air off the right side of the desk are removed; pages appear there only while animating. The floor pile is unchanged.
- The keyboard is recoloured from dark grey to warm ivory and beige, matching the vintage computer (shape and placement unchanged).
- The drawn kiosk's sign reads **TEMPERANCE** in place of "Paws & Order".
- The window flyer and door notice changes above also appear, mirrored and faint, in the interior's view of the window and door.

### Terminal

- **Return to Hospital** in the terminal header takes the visitor back to Hearthy. It never uses a review or changes the daily count, is disabled while a review is running, and coming back to the terminal resumes where the visitor left off.
- **Invoice selection** has two sections: **Available to Review** and **Reviewed This Visit**. Invoices move to the second section, with a **Reviewed** badge, when a live review begins (including reviews that fail after starting). A refusal that uses no review, such as the desk being closed, busy or paused, does not mark the invoice.
- Opening a reviewed invoice still shows the paper invoice and its PDF. Asking for another review first asks **"Review this invoice again?"**, explaining that another review uses one more of today's live reviews, with **Review Again** and **Cancel**.
- The reviewed list is kept in the browser session only (cleared when the tab closes) and is never sent to the server. It does not change the daily limits or counting rules.

### Motion and accessibility

- All motion stops under the reduced-motion preference, leaving a complete, still scene (the spark stays hidden; "Ding!" appears briefly without moving).
- Every function remains available without animation. The bell, dialogue buttons and Return to Hospital are keyboard operable with visible focus, and Hearthy's lines and the bell are announced to screen readers.

## Recorded encounters

Nine demonstrations are in place, selected from the new 300-invoice dataset, each with a live recorded review. They have no story (owner decision, November 2026): choosing one goes straight to the recorded review. All nine are owner-approved live recordings (November 2026); the Provisional label and notice have been removed. Preserve the principle of nine short, distinct cats.
