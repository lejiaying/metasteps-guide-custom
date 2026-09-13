const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const manifest = JSON.parse(read('manifest.json'));
assert(manifest.manifest_version === 3, 'Manifest V3 is required.');
assert(manifest.version === '0.10.1', 'Extension version must match the v0.10.1 runtime.');
assert(manifest.background?.service_worker, 'Service worker is missing.');
assert(manifest.host_permissions?.includes('<all_urls>'), 'Persistent capture permission is missing.');
assert(manifest.content_scripts?.[0]?.matches?.includes('https://*.metasteps.com/viewer/*'), 'Viewer URL match is missing.');
assert(manifest.web_accessible_resources?.length === 1, 'Web-accessible resources are missing.');

const sandbox = { globalThis: {} };
vm.runInNewContext(read('src/guide/flows.de.js'), sandbox, { filename: 'flows.de.js' });
const config = sandbox.globalThis.MetastepsGuideConfig;
assert(config, 'Guide configuration was not exported.');
assert(['start', 'move', 'exhibit', 'lost'].every(key => config.flows[key]), 'One of the four home flows is missing.');

for (const [flowKey, flow] of Object.entries(config.flows)) {
  assert(flow.title && flow.steps?.length, `${flowKey}: title or steps missing.`);
  for (const [stepIndex, step] of flow.steps.entries()) {
    assert(step.text && step.icon, `${flowKey}/${stepIndex}: text or icon missing.`);
    assert(['explanation', 'choice', 'action', 'terminal'].includes(step.kind), `${flowKey}/${stepIndex}: invalid node kind.`);
    if (step.target) {
      assert(step.target.length === 2, `${flowKey}/${stepIndex}: invalid target.`);
      assert(step.target.every(value => value >= 0 && value <= 100), `${flowKey}/${stepIndex}: target is outside viewport.`);
    }
  }
}

const html = read('src/content/overlay.html');
assert((html.match(/class="service-button"/g) || []).length === 4, 'Home must contain exactly four service buttons.');
assert(!/Anhören|>Weiter<|>Zurück</.test(html), 'Forbidden tutorial navigation/audio controls found.');
assert(!/id="guide-close"|id="recognition-close"/.test(html), 'Legacy overlay close buttons found.');
assert((html.match(/OK, danke\./g) || []).length >= 2, 'Acknowledgement controls are missing.');

const overlay = read('src/content/overlay.js');
const css = read('src/content/overlay.css');
assert(overlay.includes('METASTEPS_CAPTURE_VISIBLE_TAB'), 'Screenshot request is not wired.');
assert(overlay.includes("document.addEventListener('wheel'"), 'Page wheel observer is not wired.');
assert(overlay.includes("document.addEventListener('pointermove'"), 'Page drag observer is not wired.');
assert(overlay.includes("document.addEventListener('click'"), 'Page click observer is not wired.');
assert(!overlay.includes('locateMapTarget'), 'Removed map target-point scanning is still wired.');
assert(!overlay.includes("locator.type === 'map'"), 'Removed demo map target locator is still wired.');
assert(!overlay.includes('gradient-dot') && !css.includes('gradient-dot'), 'Removed map target-dot renderer is still present.');
assert(overlay.includes('locateTools'), 'Dynamic exhibit-tool locator is not wired.');
assert(overlay.includes('isWithinRequiredTarget'), 'Map-button click is not constrained to the highlighted circle.');
assert(overlay.includes('collectDomMaskRects'), 'Dynamic DOM masking is not wired.');
assert(overlay.includes('isWithinViewer'), 'Full Viewer/Canvas gesture observation is not wired.');
assert(!overlay.includes('isWithinTarget('), 'Gesture completion still depends on the marker rectangle.');
assert(overlay.includes('detectState'), 'Expected page-state confirmation is not wired.');
assert(overlay.includes('prepareSelectionBaseline'), 'Pre-selection baseline capture is not wired.');
assert(overlay.includes("console.info('[Metasteps Hilfe] Erkennung'"), 'Recognition diagnostics are not available in the page console.');
assert(overlay.includes('combineRecognitionResults'), 'Uncertain and entry recognition does not use a fresh confirmation frame.');
assert(overlay.includes('index < 3') && overlay.includes('recognitionVoteKey'), 'Three-frame majority recognition is not wired.');
assert(overlay.includes('baselineDataUrl: selectionBaseline?.dataUrl'), 'State confirmation does not receive the pre-selection baseline.');
assert(overlay.includes('showRecognitionError'), 'Capture failures are still reported as uncertain recognition.');
assert(overlay.includes('scheduleDynamicToolRefresh(delay = 700)'), 'Dynamic relocalization is not throttled.');

const serviceWorker = read('src/background/service-worker.js');
assert(serviceWorker.includes('CAPTURE_MIN_INTERVAL_MS = 550'), 'Screenshot queue does not enforce the browser rate limit.');
assert(serviceWorker.includes('CAPTURE_PERMISSION_REQUIRED'), 'Screenshot permission errors are not classified.');

const referenceFiles = fs.readdirSync(path.join(root, 'assets', 'reference-scenes')).filter(file => file.endsWith('.png'));
assert(referenceFiles.length >= 9, 'At least nine reference scenes are required.');
const exhibitSources = fs.readdirSync(path.join(root, 'assets', 'reference-source', 'map-open')).filter(file => file.endsWith('.png'));
assert(exhibitSources.length === 6, 'Six registered exhibit sources are required.');
const catalog = JSON.parse(read('assets/runtime-references/catalog.json'));
assert(catalog.schemaVersion === 6, 'Runtime catalog must separate live screenshot references from offline model diagnostics.');
assert(catalog.toolGlyphTemplates?.entries?.length === 3, 'Three Canvas tool glyph templates are required.');
assert(catalog.exhibits.length === 6, 'Six runtime exhibit identities are required.');
assert(catalog.references.length === 160, 'Live identity matching must load one context reference per Viewer capture.');
assert(catalog.references.every(reference => reference.domain === 'screenshot'), 'Model renders must not participate in live identity matching.');
assert(catalog.trainingReferences?.length >= 480, 'Multi-scale screenshot training references were not indexed.');
const referencesBySource = Object.groupBy(catalog.trainingReferences, reference => reference.source);
assert(Object.values(referencesBySource).every(references => references.length >= 3), 'Every Viewer capture must provide at least three subject scales.');
assert(Object.values(referencesBySource).every(references => new Set(references.map(reference => reference.variant)).size >= 3), 'Viewer subject-scale variants are not distinct.');
assert(catalog.modelReferences?.length >= 120, 'Offline multi-view model diagnostics are missing.');
assert(catalog.stateReferences.length >= 80, 'Layered state references were not generated.');
assert(catalog.exhibits.every(exhibit => exhibit.model?.format), 'A model inventory entry is missing.');
assert(!catalog.mapCalibration, 'Removed map target calibration is still present.');
assert(!Object.values(config.flows).some(flow => flow.steps.some(step => step.locator?.type === 'map' || step.dot)), 'A removed map target-point step is still configured.');
assert(config.flows.lost.steps.length === 2 && !config.flows.lost.steps.some(step => step.kind === 'choice'), 'Lost flow must directly guide the user to Objekt 1 without a destination choice.');
assert(['move', 'lost'].every(flowKey => config.flows[flowKey].steps.filter(step => step.icon === 'map' && step.kind === 'action').every(step => step.requireTargetHit && !step.expectedState)), 'Map-button steps must advance on a highlighted-circle click without screenshot confirmation.');
const localVisionModel = JSON.parse(read('assets/runtime-references/local-vision-model.json'));
const localVisionReport = JSON.parse(read('assets/runtime-references/local-vision-model.report.json'));
assert(localVisionModel.type === 'local-mlp-descriptor-classifier', 'The local AI vision model is missing.');
assert(localVisionModel.labels?.length === 6 && localVisionModel.inputSize === 236, 'The local AI model shape is invalid.');
assert(localVisionModel.training?.externalApi === false, 'The local AI model must not depend on an external API.');
assert(localVisionModel.hiddenWeights.length === localVisionModel.inputSize * localVisionModel.hiddenSize, 'The local AI hidden layer is incomplete.');
assert(localVisionReport.externalApi === false, 'The local AI validation report is missing or invalid.');
assert(localVisionReport.screenshotHoldoutStrategy === 'viewpoint-family-grouped' && localVisionReport.screenshotHoldoutSamples >= 40, 'Screenshot validation does not isolate complete viewpoint families.');
assert(localVisionReport.screenshotHoldoutAccuracy >= .9, `Screenshot-only holdout accuracy regressed: ${localVisionReport.screenshotHoldoutAccuracy}`);
assert(localVisionReport.trainingAccuracy >= .95, `The live screenshot model is underfitting its training set: ${localVisionReport.trainingAccuracy}`);
assert(localVisionModel.training?.modelReferences === 0, 'The live local AI model must be trained only on Viewer screenshots.');

console.log(JSON.stringify({
  status: 'ok',
  manifestVersion: manifest.manifest_version,
  homeFlows: 4,
  configuredFlows: Object.keys(config.flows).length,
  recognitionStates: Object.keys(config.recognition).length,
  referenceScenes: referenceFiles.length,
  registeredExhibits: exhibitSources.length,
  runtimeIdentityReferences: catalog.references.length,
  modelViewReferences: catalog.modelReferences.length,
  runtimeStateReferences: catalog.stateReferences.length,
  mapTargetGuidanceRemoved: true,
  localVisionModel: localVisionModel.type,
  localVisionModelBytes: fs.statSync(path.join(root, 'assets', 'runtime-references', 'local-vision-model.json')).size,
  localVisionScreenshotHoldoutAccuracy: localVisionReport.screenshotHoldoutAccuracy,
  localVisionModelAngleHoldoutAccuracy: localVisionReport.modelAngleHoldoutAccuracy,
  indexedModels: catalog.exhibits.length,
  nodeKinds: ['explanation', 'choice', 'action', 'terminal']
}, null, 2));
