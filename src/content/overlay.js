(() => {
  if (document.getElementById('metasteps-guide-extension-host')) return;

  const { flows, recognition } = globalThis.MetastepsGuideConfig;
  const classifier = globalThis.MetastepsSceneClassifier;
  const host = document.createElement('div');
  host.id = 'metasteps-guide-extension-host';
  host.setAttribute('aria-label', 'Metasteps Orientierungshilfe');
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: 'open' });

  let currentFlow = null;
  let currentStep = 0;
  let renderedStep = null;
  let recognitionResult = null;
  let sequenceToken = 0;
  let activeAction = null;
  let targetActionReady = false;
  let dragStart = null;
  let activeSceneChoices = [];
  let helpPillHasAppeared = false;
  let lastToolTargets = null;
  let lastSceneClick = null;
  let dynamicRefreshTimer = 0;
  let locatorDragStart = null;
  let locatorDragMoved = false;
  let stateCheckInFlight = false;
  let selectionBaseline = null;
  let selectionBaselinePromise = null;

  const resourceText = path => fetch(chrome.runtime.getURL(path)).then(response => {
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.text();
  });

  Promise.all([resourceText('src/content/overlay.html'), resourceText('src/content/overlay.css')])
    .then(([markup, css]) => {
      shadow.innerHTML = `<style>${css}</style>${markup}`;
      initialize();
    })
    .catch(error => {
      console.error('[Metasteps Hilfe] Overlay konnte nicht geladen werden.', error);
      host.remove();
    });

  function initialize() {
    const el = id => shadow.getElementById(id);
    const homePanel = el('home-panel');
    const guideCard = el('guide-card');
    const targetMarker = el('target-marker');
    const sceneAnnotations = el('scene-annotations');
    const helpPill = el('help-pill');
    const recognitionPanel = el('recognition-panel');

    function icon(name, label = '') {
      const accessibility = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
      return `<svg class="icon-svg" viewBox="0 0 48 48" ${accessibility}><use class="icon-halo" href="#msg-i-${name}"></use><use class="icon-line" href="#msg-i-${name}"></use></svg>`;
    }

    shadow.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });

    function stopSpeech() {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }

    function speak(text) {
      if (!('speechSynthesis' in window) || !text) return;
      stopSpeech();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'de-DE';
      utterance.rate = .93;
      const germanVoice = window.speechSynthesis.getVoices().find(voice => /^de(?:-|_)/i.test(voice.lang));
      if (germanVoice) utterance.voice = germanVoice;
      window.speechSynthesis.speak(utterance);
    }

    function clearNodeState() {
      guideCard.classList.remove('node-pulse');
      targetMarker.classList.remove('node-pulse', 'wheel-continuous');
      sceneAnnotations.classList.remove('node-pulse');
      recognitionPanel.classList.remove('node-pulse');
    }

    function hideAll() {
      sequenceToken += 1;
      window.clearTimeout(dynamicRefreshTimer);
      dynamicRefreshTimer = 0;
      clearNodeState();
      homePanel.hidden = true;
      guideCard.hidden = true;
      targetMarker.hidden = true;
      sceneAnnotations.hidden = true;
      recognitionPanel.hidden = true;
      helpPill.hidden = true;
      el('locator-retry').hidden = true;
      renderedStep = null;
      activeAction = null;
      targetActionReady = false;
      activeSceneChoices = [];
      dragStart = null;
      locatorDragStart = null;
      locatorDragMoved = false;
      stateCheckInFlight = false;
      selectionBaseline = null;
      selectionBaselinePromise = null;
    }

    function showHome() {
      stopSpeech();
      hideAll();
      currentFlow = null;
      homePanel.hidden = false;
      homePanel.classList.add('node-pulse');
    }

    function closeToPill() {
      stopSpeech();
      hideAll();
      homePanel.classList.remove('node-pulse');
      helpPill.hidden = false;
      helpPill.className = 'help-pill';
      if (!helpPillHasAppeared) {
        helpPill.classList.add('pill-attention');
        helpPillHasAppeared = true;
      }
    }

    function openFlow(flowName, step = 0) {
      if (!flows[flowName]) return;
      stopSpeech();
      hideAll();
      currentFlow = flowName;
      currentStep = step;
      renderStep();
    }

    function demoLocator(locator) {
      if (locator.type === 'tools') return { tools: { camera: [45.2, 54.2], expand: [45.2, 58.7], info: [45.2, 63] } };
      if (locator.type === 'tool') {
        const y = { camera: 54.2, expand: 58.7, info: 63 }[locator.slot];
        return { target: [45.2, y] };
      }
      return null;
    }

    function mergeMaskRects(rects) {
      const merged = [];
      for (const rect of rects.sort((left, right) => (left.top - right.top) || (left.left - right.left))) {
        const existing = merged.find(item => (
          rect.left <= item.left + item.width + 6 && rect.left + rect.width + 6 >= item.left &&
          rect.top <= item.top + item.height + 6 && rect.top + rect.height + 6 >= item.top
        ));
        if (!existing) {
          merged.push({ ...rect });
          continue;
        }
        const right = Math.max(existing.left + existing.width, rect.left + rect.width);
        const bottom = Math.max(existing.top + existing.height, rect.top + rect.height);
        existing.left = Math.min(existing.left, rect.left);
        existing.top = Math.min(existing.top, rect.top);
        existing.width = right - existing.left;
        existing.height = bottom - existing.top;
      }
      return merged;
    }

    function collectDomMaskRects() {
      const selector = [
        'button', '[role="button"]', '[aria-label]', '[tabindex]',
        'img', 'svg',
        '[class*="toolbar" i]', '[class*="controls" i]', '[class*="control" i]',
        '[class*="avatar" i]', '[class*="profile" i]', '[class*="accessib" i]',
        '[class*="minimap" i]', '[class*="navigation" i]', '[class*="menu" i]',
        '[class*="chat" i]', '[class*="sound" i]', '[class*="audio" i]', '[class*="settings" i]'
      ].join(',');
      const padding = 12;
      const viewportArea = window.innerWidth * window.innerHeight;
      const rects = [];
      document.querySelectorAll(selector).forEach(node => {
        if (!(node instanceof Element) || host.contains(node) || node.closest(`#${host.id}`)) return;
        if (node instanceof HTMLCanvasElement || node.closest('canvas')) return;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < .05) return;
        const box = node.getBoundingClientRect();
        const area = box.width * box.height;
        if (box.width < 12 || box.height < 12 || area <= 0 || area > viewportArea * .18) return;
        if (box.right <= 0 || box.bottom <= 0 || box.left >= window.innerWidth || box.top >= window.innerHeight) return;
        rects.push({
          left: Math.max(0, box.left - padding),
          top: Math.max(0, box.top - padding),
          width: Math.min(window.innerWidth, box.right + padding) - Math.max(0, box.left - padding),
          height: Math.min(window.innerHeight, box.bottom + padding) - Math.max(0, box.top - padding)
        });
      });
      return mergeMaskRects(rects);
    }

    async function captureVisible() {
      const options = {
        maskRects: collectDomMaskRects(),
        viewport: { width: window.innerWidth, height: window.innerHeight }
      };
      host.style.visibility = 'hidden';
      try {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const response = await chrome.runtime.sendMessage({ type: 'METASTEPS_CAPTURE_VISIBLE_TAB' });
        if (!response?.ok) {
          const error = new Error(response?.error || 'capture-failed');
          error.code = response?.code || 'CAPTURE_FAILED';
          throw error;
        }
        return { dataUrl: response.dataUrl, options };
      } finally {
        host.style.visibility = '';
      }
    }

    async function resolveDynamicLocator(locator) {
      if (el('scene-select').value !== 'auto') return demoLocator(locator);
      if (locator.type === 'tools' || locator.type === 'tool') {
        const hint = lastToolTargets
          ? Object.values(lastToolTargets).reduce((sum, target) => [sum[0] + target[0] / 3, sum[1] + target[1] / 3], [0, 0])
          : lastSceneClick;
        const baselineDataUrl = lastToolTargets ? null : selectionBaseline?.dataUrl;
        const locate = async capture => {
          let result = await classifier.locateTools(capture.dataUrl, { ...capture.options, searchHint: hint, baselineDataUrl });
          if (!result?.ok && hint) result = await classifier.locateTools(capture.dataUrl, { ...capture.options, baselineDataUrl });
          return result;
        };
        const first = await locate(await captureVisible());
        await new Promise(resolve => window.setTimeout(resolve, 550));
        const second = await locate(await captureVisible());
        if (!first?.ok || !second?.ok) return null;
        const slots = ['camera', 'expand', 'info'];
        const stable = slots.every(slot => Math.hypot(
          (first.targets[slot][0] - second.targets[slot][0]) * window.innerWidth / 100,
          (first.targets[slot][1] - second.targets[slot][1]) * window.innerHeight / 100
        ) <= 18);
        if (!stable) return null;
        const targets = Object.fromEntries(slots.map(slot => [slot, [
          (first.targets[slot][0] + second.targets[slot][0]) / 2,
          (first.targets[slot][1] + second.targets[slot][1]) / 2
        ]]));
        lastToolTargets = targets;
        return locator.type === 'tools' ? { tools: targets } : { target: targets[locator.slot] };
      }
      return null;
    }

    async function prepareDynamicStep(baseStep, token) {
      guideCard.hidden = true;
      targetMarker.hidden = true;
      sceneAnnotations.hidden = true;
      try {
        const located = await resolveDynamicLocator(baseStep.locator);
        if (token !== sequenceToken) return;
        if (!located) {
          showLocatorFailure(baseStep);
          return;
        }
        renderStep({ ...baseStep, ...located });
      } catch (error) {
        if (token !== sequenceToken) return;
        console.warn('[Metasteps Hilfe] Ziel konnte nicht lokalisiert werden.', error);
        showLocatorFailure(baseStep, error);
      }
    }

    function captureFailureCopy(error) {
      const code = error?.code;
      const message = String(error?.message || '');
      if (code === 'CAPTURE_PERMISSION_REQUIRED' || /activeTab|<all_urls>|permission/i.test(message)) {
        return {
          title: 'Die Bildschirmaufnahme ist nicht freigegeben.',
          text: 'Bitte bestätigen Sie die Berechtigung der Erweiterung und laden Sie die Metasteps-Seite neu.',
          status: 'Aufnahme nicht freigegeben'
        };
      }
      if (code === 'CAPTURE_RATE_LIMITED' || /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|rate|quota|too many/i.test(message)) {
        return {
          title: 'Die Ansicht wird gerade aktualisiert.',
          text: 'Bitte warten Sie einen Moment und versuchen Sie es erneut.',
          status: 'Aufnahme kurz pausiert'
        };
      }
      return {
        title: 'Die aktuelle Ansicht konnte nicht aufgenommen werden.',
        text: 'Bitte laden Sie die Metasteps-Seite neu und versuchen Sie es erneut.',
        status: 'Aufnahme fehlgeschlagen'
      };
    }

    function showLocatorFailure(step, error = null) {
      renderedStep = null;
      activeAction = null;
      targetActionReady = false;
      guideCard.hidden = false;
      guideCard.className = `panel guide-card pos-${step.position || 'center'}`;
      el('guide-progress').textContent = 'Bitte prüfen';
      el('guide-title').textContent = flows[currentFlow].title;
      el('guide-step-icon').innerHTML = icon(step.icon);
      el('guide-text').textContent = 'Bitte halten Sie das Ausstellungsstück und die drei Knöpfe vollständig sichtbar.';
      el('guide-choices').hidden = true;
      el('guide-ack').hidden = true;
      el('guide-extra').hidden = true;
      el('locator-retry').hidden = false;
      el('locator-message').textContent = error
        ? captureFailureCopy(error).text
        : 'Das Ziel ist noch nicht sicher zu erkennen.';
    }

    function renderStep(runtimeStep = null) {
      const token = ++sequenceToken;
      const flow = flows[currentFlow];
      const baseStep = flow.steps[currentStep];
      let step = runtimeStep || baseStep;
      el('locator-retry').hidden = true;

      if (baseStep.locator?.type === 'fixed') step = { ...baseStep, target: baseStep.locator.target };
      else if (baseStep.locator && !runtimeStep) {
        prepareDynamicStep(baseStep, token);
        return;
      }

      renderedStep = step;
      clearNodeState();
      guideCard.hidden = false;
      guideCard.className = `panel guide-card pos-${step.position || 'center'}${step.sceneChoices ? ' has-scene-choices' : ''} node-pulse`;
      el('guide-title').textContent = flow.title;
      el('guide-progress').textContent = step.kind === 'terminal' ? 'Abschluss' : `Schritt ${currentStep + 1} von ${flow.steps.length}`;
      el('guide-text').textContent = step.text;
      el('guide-step-icon').innerHTML = icon(step.icon);
      targetMarker.hidden = true;
      targetMarker.className = 'target-marker';
      sceneAnnotations.hidden = true;
      sceneAnnotations.innerHTML = '';
      activeAction = step.kind === 'action' ? getActionKind(step) : null;
      targetActionReady = false;
      activeSceneChoices = [];
      dragStart = null;

      renderChoices(step);
      el('guide-ack').hidden = !['explanation', 'terminal'].includes(step.kind);
      renderExtra(step);
      if (step.sceneChoices) renderSceneChoices(step);
      if (step.kind === 'action' && step.target) renderTarget(step);
      if (step.expectedState === 'selected' && el('scene-select').value === 'auto') prepareSelectionBaseline(token);
      speak(step.text);
    }

    function prepareSelectionBaseline(token) {
      targetActionReady = false;
      selectionBaseline = null;
      selectionBaselinePromise = captureVisible()
        .then(capture => {
          if (token === sequenceToken) selectionBaseline = capture;
          return capture;
        })
        .catch(error => {
          console.warn('[Metasteps Hilfe] Ausgangsansicht konnte nicht aufgenommen werden.', error);
          return null;
        })
        .finally(() => {
          if (token === sequenceToken && activeAction === 'click') targetActionReady = true;
        });
    }

    function renderChoices(step) {
      const choices = el('guide-choices');
      choices.innerHTML = '';
      choices.hidden = !step.choices;
      if (!step.choices) return;
      step.choices.forEach(choice => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'choice-button';
        button.innerHTML = `<span class="small-icon">${icon(choice.icon)}</span><span>${choice.label}</span>`;
        button.addEventListener('click', () => openFlow(choice.flow, choice.step || 0));
        choices.append(button);
      });
    }

    function renderExtra(step) {
      el('guide-extra').hidden = true;
      el('guide-extra').innerHTML = '';
      shadow.querySelector('[data-extra-trigger]')?.remove();
      if (!step.extra) return;
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'secondary-button optional-trigger';
      trigger.dataset.extraTrigger = 'true';
      trigger.textContent = 'Weitere Möglichkeit';
      trigger.addEventListener('click', () => {
        el('guide-extra').hidden = false;
        el('guide-extra').innerHTML = `<div class="extra-content"><span class="small-icon">${icon('keyboard')}</span><span>${step.extra}</span></div>`;
        trigger.remove();
      });
      el('guide-extra').before(trigger);
    }

    function renderTarget(step) {
      const markerStyle = step.markerStyle || '';
      targetMarker.hidden = false;
      targetMarker.className = `target-marker${markerStyle ? ` ${markerStyle}` : ''} node-pulse`;
      targetMarker.style.setProperty('--target-x', step.target[0]);
      targetMarker.style.setProperty('--target-y', step.target[1]);
      targetMarker.style.setProperty('--target-size', `${step.size || 86}px`);
      targetMarker.style.setProperty('--hit-width', `${step.hitWidth || step.size || 86}px`);
      targetMarker.style.setProperty('--hit-height', `${step.hitHeight || step.size || 86}px`);
      targetMarker.style.setProperty('--visual-size', `${step.visualSize || step.size || 86}px`);
      targetMarker.style.setProperty('--visual-offset-x', `${step.visualOffsetX ?? 18}px`);
      targetMarker.innerHTML = step.ringOnly ? '' : icon(step.icon);
      if (markerStyle === 'gesture-scroll') targetMarker.classList.add('wheel-continuous');
      targetActionReady = true;
    }

    function renderSceneChoices(step) {
      activeSceneChoices = step.sceneChoices.map(choice => ({ ...choice, target: step.tools?.[choice.slot] }));
      if (activeSceneChoices.some(choice => !choice.target)) {
        showLocatorFailure(step);
        return;
      }
      activeSceneChoices.forEach((choice, index) => {
        const annotation = document.createElement('div');
        annotation.className = 'scene-choice';
        annotation.dataset.choiceIndex = String(index);
        annotation.style.setProperty('--choice-x', choice.target[0]);
        annotation.style.setProperty('--choice-y', choice.target[1]);
        annotation.innerHTML = `<span class="scene-choice-ring"></span><span class="scene-choice-label">${choice.label}</span>`;
        sceneAnnotations.append(annotation);
      });
      sceneAnnotations.hidden = false;
      sceneAnnotations.classList.add('node-pulse');
    }

    function confirmSceneChoice(index) {
      const choice = activeSceneChoices[index];
      if (!choice) return;
      stopSpeech();
      guideCard.classList.remove('node-pulse');
      sceneAnnotations.classList.remove('node-pulse');
      Array.from(sceneAnnotations.children).forEach((annotation, annotationIndex) => {
        annotation.classList.toggle('choice-selected', annotationIndex === index);
        annotation.classList.toggle('choice-dismissed', annotationIndex !== index);
      });
      activeSceneChoices = [];
      const token = ++sequenceToken;
      window.setTimeout(() => token === sequenceToken && openFlow(choice.flow, choice.step ?? 1), 650);
    }

    function getActionKind(step) {
      if (step.icon === 'drag') return 'drag';
      if (step.icon === 'scroll') return 'scroll';
      return 'click';
    }

    function viewerBounds() {
      const candidates = Array.from(document.querySelectorAll('canvas'))
        .filter(canvas => !host.contains(canvas))
        .map(canvas => ({ canvas, box: canvas.getBoundingClientRect() }))
        .filter(item => item.box.width >= 240 && item.box.height >= 180 && getComputedStyle(item.canvas).visibility !== 'hidden')
        .sort((left, right) => right.box.width * right.box.height - left.box.width * left.box.height);
      return candidates[0]?.box || { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight };
    }

    function isWithinViewer(clientX, clientY) {
      const box = viewerBounds();
      return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
    }

    function isWithinRequiredTarget(step, clientX, clientY) {
      if (!step?.requireTargetHit || !step.target) return true;
      const centerX = window.innerWidth * step.target[0] / 100;
      const centerY = window.innerHeight * step.target[1] / 100;
      const radius = (step.hitSize || step.size || 86) / 2;
      return Math.hypot(clientX - centerX, clientY - centerY) <= radius;
    }

    function sceneChoiceAt(clientX, clientY) {
      const distances = activeSceneChoices.map((choice, index) => ({
        index,
        distance: Math.hypot(clientX - window.innerWidth * choice.target[0] / 100, clientY - window.innerHeight * choice.target[1] / 100)
      })).sort((left, right) => left.distance - right.distance);
      return distances[0]?.distance <= 44 ? distances[0].index : -1;
    }

    function finishTargetAction() {
      targetActionReady = false;
      stateCheckInFlight = false;
      stopSpeech();
      clearNodeState();
      window.setTimeout(nextStep, 120);
    }

    async function completeTargetAction(kind) {
      if (!targetActionReady || !activeAction || kind !== activeAction || stateCheckInFlight) return;
      const step = renderedStep;
      if (!step?.expectedState || el('scene-select').value !== 'auto') {
        finishTargetAction();
        return;
      }
      stateCheckInFlight = true;
      targetActionReady = false;
      const token = sequenceToken;
      try {
        await new Promise(resolve => window.setTimeout(resolve, 240));
        const capture = await captureVisible();
        const result = await classifier.detectState(capture.dataUrl, step.expectedState, {
          ...capture.options,
          searchHint: lastSceneClick,
          baselineDataUrl: selectionBaseline?.dataUrl
        });
        if (token !== sequenceToken) return;
        if (result?.ok) {
          finishTargetAction();
          return;
        }
      } catch (error) {
        console.warn('[Metasteps Hilfe] Zustandsbestätigung nicht verfügbar.', error);
      }
      if (token === sequenceToken) {
        stateCheckInFlight = false;
        targetActionReady = true;
      }
    }

    function nextStep() {
      const flow = flows[currentFlow];
      if (currentStep >= flow.steps.length - 1) {
        closeToPill();
        return;
      }
      currentStep += 1;
      stopSpeech();
      renderStep();
    }

    function acknowledgeCurrent() {
      const step = flows[currentFlow].steps[currentStep];
      stopSpeech();
      clearNodeState();
      if (step.kind === 'terminal') closeToPill();
      else nextStep();
    }

    function eventComesFromOverlay(event) {
      return event.composedPath().includes(host);
    }

    function hasDynamicToolLocator() {
      const step = currentFlow ? flows[currentFlow]?.steps?.[currentStep] : null;
      return ['tools', 'tool'].includes(step?.locator?.type);
    }

    function invalidateDynamicToolLocator() {
      if (!hasDynamicToolLocator()) return;
      targetMarker.hidden = true;
      sceneAnnotations.hidden = true;
      activeSceneChoices = [];
      targetActionReady = false;
    }

    function scheduleDynamicToolRefresh(delay = 700) {
      if (!hasDynamicToolLocator()) return;
      window.clearTimeout(dynamicRefreshTimer);
      dynamicRefreshTimer = window.setTimeout(() => {
        dynamicRefreshTimer = 0;
        if (hasDynamicToolLocator()) renderStep();
      }, delay);
    }

    document.addEventListener('click', event => {
      if (eventComesFromOverlay(event)) return;
      const choiceIndex = sceneChoiceAt(event.clientX, event.clientY);
      if (choiceIndex >= 0) {
        confirmSceneChoice(choiceIndex);
        return;
      }
      if (activeAction === 'click' && targetActionReady && isWithinViewer(event.clientX, event.clientY) && isWithinRequiredTarget(renderedStep, event.clientX, event.clientY)) {
        if (renderedStep?.expectedState === 'selected') lastToolTargets = null;
        lastSceneClick = [event.clientX / window.innerWidth * 100, event.clientY / window.innerHeight * 100];
        completeTargetAction('click');
      }
    }, true);
    document.addEventListener('pointerdown', event => {
      if (eventComesFromOverlay(event) || !isWithinViewer(event.clientX, event.clientY)) return;
      if (hasDynamicToolLocator() && event.button === 0) {
        locatorDragStart = { x: event.clientX, y: event.clientY };
        locatorDragMoved = false;
      }
      if (activeAction === 'drag' && targetActionReady && event.button === 0) dragStart = { x: event.clientX, y: event.clientY };
    }, true);
    document.addEventListener('pointermove', event => {
      if (locatorDragStart && !locatorDragMoved && Math.hypot(event.clientX - locatorDragStart.x, event.clientY - locatorDragStart.y) >= 8) {
        locatorDragMoved = true;
        invalidateDynamicToolLocator();
      }
      if (dragStart && activeAction === 'drag' && Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) >= 24) completeTargetAction('drag');
    }, true);
    document.addEventListener('pointerup', () => {
      dragStart = null;
      locatorDragStart = null;
      if (locatorDragMoved) scheduleDynamicToolRefresh();
      locatorDragMoved = false;
    }, true);
    document.addEventListener('pointercancel', () => {
      dragStart = null;
      locatorDragStart = null;
      if (locatorDragMoved) scheduleDynamicToolRefresh();
      locatorDragMoved = false;
    }, true);
    document.addEventListener('wheel', event => {
      if (eventComesFromOverlay(event) || !isWithinViewer(event.clientX, event.clientY)) return;
      if (hasDynamicToolLocator()) {
        invalidateDynamicToolLocator();
        scheduleDynamicToolRefresh(320);
      }
      if (activeAction === 'scroll' && targetActionReady) completeTargetAction('scroll');
    }, { capture: true, passive: true });
    window.addEventListener('resize', () => {
      if (!hasDynamicToolLocator()) return;
      invalidateDynamicToolLocator();
      scheduleDynamicToolRefresh(180);
    }, { passive: true });

    function recognitionVoteKey(result) {
      return result.exhibitId ? `exhibit:${result.exhibitId}` : `key:${result.key || 'unknown'}`;
    }

    function combineRecognitionResults(samples) {
      const groups = new Map();
      for (const sample of samples) {
        const key = recognitionVoteKey(sample);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(sample);
      }
      const rankedGroups = Array.from(groups.entries()).sort((left, right) => {
        if (right[1].length !== left[1].length) return right[1].length - left[1].length;
        return Math.max(...right[1].map(result => result.confidence || 0)) - Math.max(...left[1].map(result => result.confidence || 0));
      });
      const [winningKey, matching = []] = rankedGroups[0] || [];
      if (matching.length >= 2 && winningKey !== 'key:unknown') {
        const preferred = matching.reduce((best, current) => (current.separation || 0) > (best.separation || 0) ? current : best);
        return {
          ...preferred,
          confidence: Math.min(.99, matching.reduce((sum, result) => sum + (result.confidence || 0), 0) / matching.length),
          separation: Math.min(...matching.map(result => result.separation || 0)),
          samples
        };
      }
      return {
        key: 'unknown',
        state: 'unknown',
        exhibitId: null,
        confidence: Math.min(.69, Math.max(...samples.map(result => result.confidence || 0))),
        separation: 0,
        alternatives: samples.flatMap(result => result.alternatives || []).slice(0, 6),
        samples
      };
    }

    async function startRecognition() {
      stopSpeech();
      hideAll();
      recognitionPanel.hidden = false;
      recognitionPanel.classList.add('node-pulse');
      el('recognition-spinner').hidden = false;
      el('recognition-icon').hidden = true;
      el('recognition-title').textContent = 'Einen Moment bitte.';
      el('recognition-text').textContent = 'Ich sehe mir Ihre Ansicht an.';
      el('recognition-confidence').hidden = true;
      el('recognition-actions').hidden = true;
      const token = sequenceToken;
      try {
        const demoKey = el('scene-select').value;
        let result;
        if (demoKey !== 'auto') {
          await new Promise(resolve => window.setTimeout(resolve, 650));
          result = { key: demoKey, confidence: demoKey === 'unknown' ? .42 : .99 };
        } else {
          const samples = [];
          for (let index = 0; index < 3; index += 1) {
            if (index > 0) {
              el('recognition-text').textContent = `Ich prüfe die Ansicht noch einmal (${index + 1}/3).`;
              await new Promise(resolve => window.setTimeout(resolve, 550));
            }
            const capture = await captureVisible();
            samples.push(await classifier.classify(capture.dataUrl, capture.options));
          }
          result = combineRecognitionResults(samples);
        }
        console.info('[Metasteps Hilfe] Erkennung', {
          key: result.key,
          state: result.state,
          exhibitId: result.exhibitId,
          confidence: result.confidence,
          separation: result.separation,
          alternatives: result.alternatives?.slice?.(0, 3)
        });
        if (token === sequenceToken) showRecognitionResult(result);
      } catch (error) {
        console.warn('[Metasteps Hilfe] Erkennung nicht verfügbar.', error);
        if (token === sequenceToken) showRecognitionError(error);
      }
    }

    function showRecognitionError(error) {
      const copy = captureFailureCopy(error);
      recognitionResult = null;
      el('recognition-spinner').hidden = true;
      el('recognition-icon').hidden = false;
      el('recognition-icon').innerHTML = icon('scan');
      el('recognition-title').textContent = copy.title;
      el('recognition-text').textContent = copy.text;
      el('recognition-confidence').textContent = copy.status;
      el('recognition-confidence').hidden = false;
      el('recognition-accept').hidden = true;
      el('recognition-actions').hidden = false;
    }

    function showRecognitionResult(result) {
      const known = result.key !== 'unknown' && recognition[result.key];
      recognitionResult = known ? recognition[result.key] : null;
      el('recognition-spinner').hidden = true;
      el('recognition-icon').hidden = false;
      el('recognition-icon').innerHTML = icon('scan');
      el('recognition-title').textContent = known ? recognitionResult.title : 'Ich kann die Ansicht noch nicht sicher einordnen.';
      el('recognition-text').textContent = known ? 'Passt das zu Ihrer Ansicht?' : 'Bitte wählen Sie aus, wobei Sie Hilfe brauchen.';
      el('recognition-confidence').textContent = known ? `Sicher erkannt · ${Math.round(result.confidence * 100)} %` : 'Nicht sicher';
      el('recognition-confidence').hidden = false;
      el('recognition-accept').hidden = !known;
      el('recognition-actions').hidden = false;
    }

    shadow.querySelectorAll('[data-flow]').forEach(button => button.addEventListener('click', () => openFlow(button.dataset.flow)));
    el('home-close').addEventListener('click', closeToPill);
    el('guide-ack').addEventListener('click', acknowledgeCurrent);
    el('locator-retry-button').addEventListener('click', () => renderStep());
    helpPill.addEventListener('click', showHome);
    el('recognize-button').addEventListener('click', startRecognition);
    el('recognition-accept').addEventListener('click', () => recognitionResult && openFlow(recognitionResult.flow, recognitionResult.step || 0));
    el('recognition-reject').addEventListener('click', showHome);
    el('demo-toggle').addEventListener('click', () => {
      const menu = el('demo-menu');
      const opening = menu.hidden;
      menu.hidden = !opening;
      el('demo-toggle').setAttribute('aria-expanded', String(opening));
    });
    el('scene-select').addEventListener('change', () => {
      const isDemo = el('scene-select').value !== 'auto';
      el('demo-toggle').textContent = isDemo ? 'DEMO · AKTIV' : 'DEMO';
      el('demo-menu').hidden = true;
      el('demo-toggle').setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeToPill();
    });
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type !== 'METASTEPS_TOGGLE') return;
      if (helpPill.hidden) closeToPill(); else showHome();
    });
    showHome();
  }
})();
