const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'background', 'service-worker.js'), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

(async () => {
  let messageListener;
  let captureFailure = null;
  const captureTimes = [];
  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    tabs: {
      async captureVisibleTab() {
        captureTimes.push(Date.now());
        if (captureFailure) throw captureFailure;
        return `data:image/jpeg;base64,frame-${captureTimes.length}`;
      },
      sendMessage: async () => undefined
    },
    action: { onClicked: { addListener() {} } }
  };

  vm.runInNewContext(source, { chrome, Date, Promise, setTimeout }, { filename: 'service-worker.js' });
  assert(messageListener, 'Screenshot message listener was not registered.');

  const requestCapture = () => new Promise(resolve => {
    const keepChannelOpen = messageListener(
      { type: 'METASTEPS_CAPTURE_VISIBLE_TAB' },
      { tab: { windowId: 7 } },
      resolve
    );
    assert(keepChannelOpen === true, 'Screenshot response channel was not kept open.');
  });

  const [first, second] = await Promise.all([requestCapture(), requestCapture()]);
  assert(first.ok && second.ok, 'Queued screenshots did not succeed.');
  const spacing = captureTimes[1] - captureTimes[0];
  assert(spacing >= 500, `Screenshot calls were only ${spacing} ms apart.`);

  captureFailure = new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
  const permissionFailure = await requestCapture();
  assert(permissionFailure.ok === false, 'Capture failure was not returned to the content script.');
  assert(permissionFailure.code === 'CAPTURE_PERMISSION_REQUIRED', 'Capture permission failure was not classified.');

  console.log(JSON.stringify({
    status: 'ok',
    queuedCaptures: 2,
    minimumObservedSpacingMs: spacing,
    permissionFailureCode: permissionFailure.code
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
