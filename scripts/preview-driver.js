// LOCAL PREVIEW ONLY: clicks through the kiosk to a requested state for screenshots.
// Open http://127.0.0.1:8787/preview-driver#step=menu|invoices|confirm|pending|result|demos|demo|demo-result
const step = new URLSearchParams(location.hash.slice(1)).get('step');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const click = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(text))?.click();

// Extra steps: desk | bell (the interior, optionally ringing the bell) | reviewed | again (after one review) | return
if (step === 'desk' || step === 'bell' || step === 'desk2') {
  await wait(300);
  document.querySelector('.scene-actions [data-go="desk"]').click();
  if (step === 'desk2') { await wait(400); document.querySelector('#screen-desk .dialogue .primary').click(); }
  if (step === 'bell') {
    await wait(400);
    // Screenshot only: keep the ring's classes so a frozen frame survives the 950 ms reset.
    const original = window.setTimeout;
    if (location.hash.includes('ring=')) window.setTimeout = (fn, ms, ...rest) => (ms === 950 ? 0 : original(fn, ms, ...rest));
    document.getElementById('desk-bell').click();
  }
} else if (step) {
  await wait(300);
  document.querySelector('[data-go="terminal"]').click();
  await wait(500);
  if (['invoices', 'confirm', 'pending', 'result', 'reviewed', 'again'].includes(step)) { click('Review my invoice'); await wait(500); }
  if (['confirm', 'pending', 'result', 'reviewed', 'again'].includes(step)) { click(new URLSearchParams(location.hash.slice(1)).get('invoice') ?? 'PO-2024-0003'); await wait(300); }
  if (['pending', 'result', 'reviewed', 'again'].includes(step)) click('Ask Temperance to review');
  if (['reviewed', 'again'].includes(step)) { await wait(1500); click('Main menu'); await wait(300); click('Review my invoice'); await wait(500); }
  if (step === 'again') { click('PO-2024-0003'); await wait(300); click('Review this invoice again'); }
  if (step === 'return') click('Return to Hospital');
  if (['demos', 'demo', 'demo-result'].includes(step)) { click('View Demonstrations'); await wait(600); }
  if (['demo', 'demo-result'].includes(step)) { click(new URLSearchParams(location.hash.slice(1)).get('demo') ?? 'Sir Pudding'); await wait(400); }
  if (step === 'demo-result') click('Play the recorded review');
}

// Optional #t=MS (and #ring=MS for the bell): pause every animation at that moment so a screenshot shows one exact frame.
const frozen = new URLSearchParams(location.hash.slice(1));
if (frozen.has('t') || frozen.has('ring')) {
  await wait(frozen.has('ring') ? 100 : 700);
  for (const a of document.getAnimations()) {
    const ring = ['bell-ring', 'ding-float'].includes(a.animationName);
    a.pause();
    a.currentTime = Number(ring ? frozen.get('ring') ?? 0 : frozen.get('t') ?? 0);
  }
}
