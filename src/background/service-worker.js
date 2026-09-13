const CAPTURE_MIN_INTERVAL_MS = 550;
let captureQueue = Promise.resolve();
let lastCaptureStartedAt = 0;

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function captureErrorCode(error) {
  const message = String(error?.message || error || '');
  if (/activeTab|<all_urls>|permission/i.test(message)) return 'CAPTURE_PERMISSION_REQUIRED';
  if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|rate|quota|too many/i.test(message)) return 'CAPTURE_RATE_LIMITED';
  return 'CAPTURE_FAILED';
}

function enqueueCapture(windowId) {
  const capture = captureQueue.catch(() => undefined).then(async () => {
    const remainingDelay = Math.max(0, lastCaptureStartedAt + CAPTURE_MIN_INTERVAL_MS - Date.now());
    if (remainingDelay) await wait(remainingDelay);
    lastCaptureStartedAt = Date.now();
    return chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 88 });
  });
  captureQueue = capture.then(() => undefined, () => undefined);
  return capture;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'METASTEPS_CAPTURE_VISIBLE_TAB') return false;

  const windowId = sender.tab?.windowId;
  enqueueCapture(windowId)
    .then(dataUrl => sendResponse({ ok: true, dataUrl }))
    .catch(error => sendResponse({
      ok: false,
      code: captureErrorCode(error),
      error: error?.message || String(error)
    }));
  return true;
});

chrome.action.onClicked.addListener(tab => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'METASTEPS_TOGGLE' }).catch(() => undefined);
});
