(() => {
  const legacyReferences = [
    ['entry', 'assets/reference-scenes/01-entry.png'],
    ['explore', 'assets/reference-scenes/02-explore-map-open.png'],
    ['before', 'assets/reference-scenes/03-before-exhibit.png'],
    ['camera', 'assets/reference-scenes/05-camera-lock.png']
  ];
  const CATALOG_PATH = 'assets/runtime-references/catalog.json';
  const LOCAL_VISION_MODEL_PATH = 'assets/runtime-references/local-vision-model.json';
  const GRID_WIDTH = 32;
  const GRID_HEIGHT = 32;
  const ANALYSIS_WIDTH = 480;
  const ANALYSIS_HEIGHT = 270;
  const TOOL_ANALYSIS_WIDTH = 1200;
  const IDENTITY_GRID = 48;
  const IDENTITY_MIN_SCORE = .84;
  const IDENTITY_MIN_SEPARATION = .01;
  const IDENTITY_MIN_SUBJECT_EVIDENCE = .035;
  const LEGACY_MIN_SCORE = .86;
  const LEGACY_MIN_SEPARATION = .018;
  const STATE_MIN_SCORES = { selected: .79, info: .79, object: .81 };
  const MASK_COLOR = '#b8b8b8';
  let catalogPromise;
  let localVisionModelPromise;
  let runtimeReferencesPromise;

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Bild konnte nicht geladen werden: ${url}`));
      image.src = url;
    });
  }

  async function loadJson(path) {
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  }

  function drawMaskedImage(image, width, height, options = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    const viewport = options.viewport || { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
    const scaleX = width / Math.max(1, viewport.width);
    const scaleY = height / Math.max(1, viewport.height);
    context.fillStyle = MASK_COLOR;
    for (const rect of options.maskRects || []) {
      const left = Math.max(0, Math.floor(rect.left * scaleX));
      const top = Math.max(0, Math.floor(rect.top * scaleY));
      const rectWidth = Math.min(width - left, Math.ceil(rect.width * scaleX));
      const rectHeight = Math.min(height - top, Math.ceil(rect.height * scaleY));
      if (rectWidth > 0 && rectHeight > 0) context.fillRect(left, top, rectWidth, rectHeight);
    }
    return canvas;
  }

  function analysisDimensions(image, maximumWidth = ANALYSIS_WIDTH) {
    const sourceWidth = image.naturalWidth || image.width || maximumWidth;
    const sourceHeight = image.naturalHeight || image.height || ANALYSIS_HEIGHT;
    return {
      width: maximumWidth,
      height: Math.max(220, Math.min(520, Math.round(maximumWidth * sourceHeight / Math.max(1, sourceWidth))))
    };
  }

  function normalizedCrop(crop) {
    return {
      x: Math.max(0, Math.min(1, crop?.x ?? 0)),
      y: Math.max(0, Math.min(1, crop?.y ?? 0)),
      width: Math.max(.02, Math.min(1, crop?.width ?? 1)),
      height: Math.max(.02, Math.min(1, crop?.height ?? 1))
    };
  }

  function vectorFromCanvas(source, crop = null) {
    const area = normalizedCrop(crop);
    const canvas = document.createElement('canvas');
    canvas.width = GRID_WIDTH;
    canvas.height = GRID_HEIGHT;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const sourceX = Math.round(source.width * area.x);
    const sourceY = Math.round(source.height * area.y);
    const sourceWidth = Math.max(1, Math.min(source.width - sourceX, Math.round(source.width * area.width)));
    const sourceHeight = Math.max(1, Math.min(source.height - sourceY, Math.round(source.height * area.height)));
    context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, GRID_WIDTH, GRID_HEIGHT);
    const pixels = context.getImageData(0, 0, GRID_WIDTH, GRID_HEIGHT).data;
    const luminances = new Float32Array(GRID_WIDTH * GRID_HEIGHT);
    for (let index = 0; index < luminances.length; index += 1) {
      const offset = index * 4;
      luminances[index] = (pixels[offset] * .2126 + pixels[offset + 1] * .7152 + pixels[offset + 2] * .0722) / 255;
    }
    const vector = new Float32Array(GRID_WIDTH * GRID_HEIGHT * 6);
    let output = 0;
    for (let y = 0; y < GRID_HEIGHT; y += 1) {
      for (let x = 0; x < GRID_WIDTH; x += 1) {
        const index = y * GRID_WIDTH + x;
        const offset = index * 4;
        const right = luminances[y * GRID_WIDTH + Math.min(GRID_WIDTH - 1, x + 1)];
        const bottom = luminances[Math.min(GRID_HEIGHT - 1, y + 1) * GRID_WIDTH + x];
        vector[output++] = pixels[offset] / 255;
        vector[output++] = pixels[offset + 1] / 255;
        vector[output++] = pixels[offset + 2] / 255;
        vector[output++] = luminances[index];
        vector[output++] = Math.abs(right - luminances[index]);
        vector[output++] = Math.abs(bottom - luminances[index]);
      }
    }
    return vector;
  }

  function vectorFromImage(image) {
    return vectorFromCanvas(drawMaskedImage(image, GRID_WIDTH, GRID_HEIGHT));
  }

  function similarity(left, right) {
    let colorDifference = 0;
    let edgeDifference = 0;
    for (let index = 0; index < left.length; index += 6) {
      colorDifference += Math.abs(left[index] - right[index]);
      colorDifference += Math.abs(left[index + 1] - right[index + 1]);
      colorDifference += Math.abs(left[index + 2] - right[index + 2]);
      colorDifference += Math.abs(left[index + 3] - right[index + 3]);
      edgeDifference += Math.abs(left[index + 4] - right[index + 4]);
      edgeDifference += Math.abs(left[index + 5] - right[index + 5]);
    }
    const pixels = left.length / 6;
    const colorScore = Math.max(0, 1 - colorDifference / (pixels * 4));
    const edgeScore = Math.max(0, 1 - edgeDifference / (pixels * 2));
    return colorScore * .72 + edgeScore * .28;
  }

  function identityDescriptor(source, crop = null) {
    const area = normalizedCrop(crop);
    const canvas = document.createElement('canvas');
    canvas.width = IDENTITY_GRID;
    canvas.height = IDENTITY_GRID;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const sourceX = Math.round(source.width * area.x);
    const sourceY = Math.round(source.height * area.y);
    const sourceWidth = Math.max(1, Math.min(source.width - sourceX, Math.round(source.width * area.width)));
    const sourceHeight = Math.max(1, Math.min(source.height - sourceY, Math.round(source.height * area.height)));
    context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, IDENTITY_GRID, IDENTITY_GRID);
    const pixels = context.getImageData(0, 0, IDENTITY_GRID, IDENTITY_GRID).data;
    const luminances = new Float32Array(IDENTITY_GRID * IDENTITY_GRID);
    for (let index = 0; index < luminances.length; index += 1) {
      const offset = index * 4;
      luminances[index] = (pixels[offset] * .2126 + pixels[offset + 1] * .7152 + pixels[offset + 2] * .0722) / 255;
    }

    const spatialSize = 6;
    const spatial = Array.from({ length: spatialSize * spatialSize }, () => ({ weight: 0, r: 0, g: 0, b: 0, luminance: 0, count: 0 }));
    const hueHistogram = new Float32Array(12);
    const luminanceHistogram = new Float32Array(12);
    const edgeHistogram = new Float32Array(8);
    const xProjection = new Float32Array(12);
    const yProjection = new Float32Array(12);

    for (let y = 0; y < IDENTITY_GRID; y += 1) {
      for (let x = 0; x < IDENTITY_GRID; x += 1) {
        const index = y * IDENTITY_GRID + x;
        const offset = index * 4;
        const r = pixels[offset] / 255;
        const g = pixels[offset + 1] / 255;
        const b = pixels[offset + 2] / 255;
        const maximum = Math.max(r, g, b);
        const minimum = Math.min(r, g, b);
        const saturation = maximum ? (maximum - minimum) / maximum : 0;
        const current = luminances[index];
        const dx = luminances[y * IDENTITY_GRID + Math.min(IDENTITY_GRID - 1, x + 1)] - current;
        const dy = luminances[Math.min(IDENTITY_GRID - 1, y + 1) * IDENTITY_GRID + x] - current;
        const edge = Math.min(1, Math.hypot(dx, dy) * 4.5);
        const darkness = Math.max(0, .8 - current) / .8;
        const weight = Math.min(1, .025 + saturation * 1.35 + edge * 2.1 + darkness * .72);
        const cellX = Math.min(spatialSize - 1, Math.floor(x / IDENTITY_GRID * spatialSize));
        const cellY = Math.min(spatialSize - 1, Math.floor(y / IDENTITY_GRID * spatialSize));
        const cell = spatial[cellY * spatialSize + cellX];
        cell.weight += weight;
        cell.r += r * weight;
        cell.g += g * weight;
        cell.b += b * weight;
        cell.luminance += current * weight;
        cell.count += 1;

        if (saturation > .08) {
          let hue = 0;
          const delta = maximum - minimum;
          if (delta > 0) {
            if (maximum === r) hue = ((g - b) / delta + 6) % 6;
            else if (maximum === g) hue = (b - r) / delta + 2;
            else hue = (r - g) / delta + 4;
          }
          hueHistogram[Math.min(11, Math.floor(hue / 6 * 12))] += saturation * weight;
        }
        luminanceHistogram[Math.min(11, Math.floor(current * 12))] += weight;
        if (edge > .03) {
          const angle = (Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2);
          edgeHistogram[Math.min(7, Math.floor(angle * 8))] += edge;
        }
        xProjection[Math.min(11, Math.floor(x / IDENTITY_GRID * 12))] += weight;
        yProjection[Math.min(11, Math.floor(y / IDENTITY_GRID * 12))] += weight;
      }
    }

    const descriptor = [];
    for (const cell of spatial) {
      const denominator = Math.max(.001, cell.weight);
      descriptor.push(cell.weight / Math.max(1, cell.count), cell.r / denominator, cell.g / denominator, cell.b / denominator, cell.luminance / denominator);
    }
    for (const values of [hueHistogram, luminanceHistogram, edgeHistogram, xProjection, yProjection]) {
      const sum = Array.from(values).reduce((total, value) => total + value, 0) || 1;
      for (const value of values) descriptor.push(value / sum);
    }
    const magnitude = Math.hypot(...descriptor) || 1;
    return Float32Array.from(descriptor, value => value / magnitude);
  }

  function descriptorSimilarity(left, right) {
    let score = 0;
    for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
    return Math.max(0, Math.min(1, score));
  }

  function loadCatalog() {
    if (!catalogPromise) catalogPromise = loadJson(CATALOG_PATH);
    return catalogPromise;
  }

  function loadLocalVisionModel() {
    if (!localVisionModelPromise) {
      localVisionModelPromise = loadJson(LOCAL_VISION_MODEL_PATH).then(model => {
        if (model.type !== 'local-mlp-descriptor-classifier' || model.inputSize !== 236 || model.labels?.length !== 6) {
          throw new Error('Ungültiges lokales Erkennungsmodell');
        }
        return model;
      }).catch(error => {
        console.warn('[Metasteps Hilfe] Lokales KI-Modell nicht verfügbar; regelbasierte Erkennung bleibt aktiv.', error);
        return null;
      });
    }
    return localVisionModelPromise;
  }

  function predictLocalVision(descriptor, model) {
    if (!model) return null;
    const hidden = new Float32Array(model.hiddenSize);
    for (let hiddenIndex = 0; hiddenIndex < model.hiddenSize; hiddenIndex += 1) {
      let value = model.hiddenBias[hiddenIndex];
      for (let featureIndex = 0; featureIndex < model.inputSize; featureIndex += 1) {
        const normalized = (descriptor[featureIndex] - model.featureMean[featureIndex]) / model.featureScale[featureIndex];
        value += normalized * model.hiddenWeights[featureIndex * model.hiddenSize + hiddenIndex];
      }
      hidden[hiddenIndex] = Math.max(0, value);
    }
    const logits = new Float32Array(model.labels.length);
    let maximum = -Infinity;
    for (let classIndex = 0; classIndex < model.labels.length; classIndex += 1) {
      let value = model.outputBias[classIndex];
      for (let hiddenIndex = 0; hiddenIndex < model.hiddenSize; hiddenIndex += 1) {
        value += hidden[hiddenIndex] * model.outputWeights[hiddenIndex * model.labels.length + classIndex];
      }
      logits[classIndex] = value;
      maximum = Math.max(maximum, value);
    }
    const probabilities = new Float32Array(model.labels.length);
    let total = 0;
    for (let index = 0; index < logits.length; index += 1) {
      probabilities[index] = Math.exp(Math.max(-24, logits[index] - maximum));
      total += probabilities[index];
    }
    for (let index = 0; index < probabilities.length; index += 1) probabilities[index] /= total || 1;
    return probabilities;
  }

  async function loadRuntimeReferences() {
    if (!runtimeReferencesPromise) {
      runtimeReferencesPromise = (async () => {
        const [catalog, localVisionModel] = await Promise.all([loadCatalog(), loadLocalVisionModel()]);
        const identity = await Promise.all(catalog.references.map(async reference => {
          const canvas = drawMaskedImage(await loadImage(chrome.runtime.getURL(reference.path)), 128, 128);
          return { ...reference, descriptor: identityDescriptor(canvas), vector: vectorFromCanvas(canvas) };
        }));
        const state = await Promise.all(catalog.stateReferences.map(async reference => ({
          ...reference,
          vector: vectorFromImage(await loadImage(chrome.runtime.getURL(reference.path)))
        })));
        const legacy = await Promise.all(legacyReferences.map(async ([key, path]) => {
          const image = await loadImage(chrome.runtime.getURL(path));
          const size = analysisDimensions(image);
          const canvas = drawMaskedImage(image, size.width, size.height);
          return { key, vector: vectorFromCanvas(canvas), descriptor: identityDescriptor(canvas) };
        }));
        return { catalog, identity, state, legacy, localVisionModel };
      })();
    }
    return runtimeReferencesPromise;
  }

  function luminance(pixels, x, y, width) {
    const offset = (y * width + x) * 4;
    return pixels[offset] * .2126 + pixels[offset + 1] * .7152 + pixels[offset + 2] * .0722;
  }

  function detectMapCanvas(pixels, width, height) {
    const mask = new Uint8Array(width * height);
    for (let y = Math.floor(height * .3); y < Math.floor(height * .95); y += 1) {
      for (let x = 0; x < Math.floor(width * .38); x += 1) {
        const offset = (y * width + x) * 4;
        const r = pixels[offset];
        const g = pixels[offset + 1];
        const b = pixels[offset + 2];
        if (g > 150 && b > 150 && g - r > 5 && b - r > 7 && Math.abs(g - b) < 40) mask[y * width + x] = 1;
      }
    }
    let best = null;
    const queue = new Int32Array(width * height);
    for (let start = 0; start < mask.length; start += 1) {
      if (mask[start] !== 1) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      mask[start] = 2;
      let count = 0;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      while (head < tail) {
        const current = queue[head++];
        const x = current % width;
        const y = Math.floor(current / width);
        count += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        const neighbors = [current - 1, current + 1, current - width, current + width];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || neighbor >= mask.length || mask[neighbor] !== 1) continue;
          const neighborX = neighbor % width;
          if (Math.abs(neighborX - x) > 1) continue;
          mask[neighbor] = 2;
          queue[tail++] = neighbor;
        }
      }
      const component = { count, left: minX, top: minY, right: maxX, bottom: maxY, width: maxX - minX, height: maxY - minY };
      const sufficientlyLarge = component.width >= width * .055 && component.height >= height * .09;
      if (sufficientlyLarge && (!best || component.count > best.count)) best = component;
    }
    if (!best) return null;
    const density = best.count / Math.max(1, (best.width + 1) * (best.height + 1));
    return { ...best, confidence: Math.min(.98, .62 + density * .45) };
  }

  function isNeutralMapPixel(pixels, x, y, width) {
    const offset = (y * width + x) * 4;
    const channels = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
    const brightness = (channels[0] + channels[1] + channels[2]) / 3;
    return Math.max(...channels) - Math.min(...channels) < 18 && brightness >= 110 && brightness <= 238;
  }

  function detectOctagon(pixels, width, height, frame) {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    for (let y = frame.top + 2; y < frame.bottom - 2; y += 1) {
      for (let x = frame.left + 2; x < frame.right - 2; x += 1) {
        if (!isNeutralMapPixel(pixels, x, y, width)) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count += 1;
      }
    }
    const octagon = { left: minX, top: minY, right: maxX, bottom: maxY, width: maxX - minX, height: maxY - minY, count };
    if (count < 30 || octagon.width < frame.width * .55 || octagon.height < frame.height * .55) return null;
    return octagon;
  }

  function detectMapGeometry(pixels, width, height) {
    const frame = detectMapCanvas(pixels, width, height);
    if (!frame) return null;
    const octagon = detectOctagon(pixels, width, height, frame);
    if (!octagon) return null;
    return { frame, octagon, confidence: Math.min(frame.confidence, .94) };
  }

  function ringScore(pixels, x, y, radius, width, height) {
    let contrast = 0;
    let signedContrast = 0;
    let positiveEdges = 0;
    let interior = 0;
    let samples = 0;
    for (let index = 0; index < 16; index += 1) {
      const angle = index / 16 * Math.PI * 2;
      const innerX = Math.round(x + Math.cos(angle) * (radius - 2));
      const innerY = Math.round(y + Math.sin(angle) * (radius - 2));
      const outerX = Math.round(x + Math.cos(angle) * (radius + 2));
      const outerY = Math.round(y + Math.sin(angle) * (radius + 2));
      if (innerX < 0 || innerY < 0 || outerX >= width || outerY >= height) continue;
      const difference = luminance(pixels, innerX, innerY, width) - luminance(pixels, outerX, outerY, width);
      contrast += Math.abs(difference);
      signedContrast += difference;
      if (difference > 0) positiveEdges += 1;
      const interiorX = Math.round(x + Math.cos(angle) * radius * .45);
      const interiorY = Math.round(y + Math.sin(angle) * radius * .45);
      interior += luminance(pixels, interiorX, interiorY, width);
      samples += 1;
    }
    if (!samples) return 0;
    const averageContrast = contrast / samples;
    const averageSigned = signedContrast / samples;
    const positiveRatio = positiveEdges / samples;
    const interiorMean = interior / samples;
    if (averageSigned < 4 || positiveRatio < .56 || interiorMean < 172) return 0;
    return averageContrast + averageSigned * .35 + (positiveRatio - .5) * 18;
  }

  function locateToolRingsInPixels(pixels, width, height, options = {}) {
    const hint = options.searchHint;
    const minX = hint ? Math.max(.04, hint[0] / 100 - .2) : .35;
    const maxX = hint ? Math.min(.96, hint[0] / 100 + .2) : .72;
    const minY = hint ? Math.max(.16, hint[1] / 100 - .28) : .45;
    const maxY = hint ? Math.min(.92, hint[1] / 100 + .28) : .72;
    const candidates = [];
    for (let y = Math.floor(height * minY); y < Math.floor(height * maxY); y += 2) {
      for (let x = Math.floor(width * minX); x < Math.floor(width * maxX); x += 2) {
        const score = Math.max(ringScore(pixels, x, y, 5, width, height), ringScore(pixels, x, y, 7, width, height));
        if (score >= 24) candidates.push({ x, y, score });
      }
    }
    candidates.sort((left, right) => right.score - left.score);
    const reduced = [];
    for (const candidate of candidates) {
      if (reduced.every(item => Math.hypot(item.x - candidate.x, item.y - candidate.y) > 6)) reduced.push(candidate);
      if (reduced.length >= 100) break;
    }
    let best = null;
    for (let first = 0; first < reduced.length - 2; first += 1) {
      for (let second = first + 1; second < reduced.length - 1; second += 1) {
        for (let third = second + 1; third < reduced.length; third += 1) {
          const stack = [reduced[first], reduced[second], reduced[third]].sort((left, right) => left.y - right.y);
          const gap1 = stack[1].y - stack[0].y;
          const gap2 = stack[2].y - stack[1].y;
          const aligned = Math.max(...stack.map(item => item.x)) - Math.min(...stack.map(item => item.x));
          if (gap1 < 9 || gap1 > 24 || gap2 < 9 || gap2 > 24 || Math.abs(gap1 - gap2) > 4 || aligned > 8) continue;
          const score = stack.reduce((sum, item) => sum + item.score, 0) - aligned * 3 - Math.abs(gap1 - gap2) * 2;
          if (!best || score > best.score) best = { stack, score };
        }
      }
    }
    if (!best || best.score < 85) return { ok: false, confidence: 0, reason: 'tools-not-found' };
    const confidence = Math.min(.98, .62 + (best.score - 85) / 180);
    const centerX = best.stack.reduce((sum, item) => sum + item.x, 0) / best.stack.length;
    const firstGap = best.stack[1].y - best.stack[0].y;
    const corrected = [
      { x: centerX, y: best.stack[0].y },
      { x: centerX, y: best.stack[1].y },
      { x: centerX, y: best.stack[1].y + firstGap }
    ];
    const points = corrected.map(item => [item.x / width * 100, item.y / height * 100]);
    return { ok: confidence >= .72, confidence, targets: { camera: points[0], expand: points[1], info: points[2] } };
  }

  function preparedGlyphTemplates(templateBank) {
    if (!templateBank?.entries?.length || !templateBank.gridSize) return [];
    const gridSize = templateBank.gridSize;
    return templateBank.entries.map(entry => {
      const positive = [];
      const background = [];
      for (let index = 0; index < entry.weights.length; index += 1) {
        const x = index % gridSize;
        const y = Math.floor(index / gridSize);
        const weight = entry.weights[index];
        if (weight >= .18) positive.push({ x, y, weight });
        else if (weight === 0 && x >= 2 && x < gridSize - 2 && y >= 2 && y < gridSize - 2 && (x + y) % 2 === 0) background.push({ x, y });
      }
      return { slot: entry.slot, gridSize, positive, background };
    });
  }

  function glyphScoreAt(pixels, x, y, patchSize, template, width, height) {
    const left = x - patchSize / 2;
    const top = y - patchSize / 2;
    if (left < 0 || top < 0 || left + patchSize >= width || top + patchSize >= height) return 0;
    const coordinate = point => ({
      x: Math.max(0, Math.min(width - 1, Math.round(left + (point.x + .5) / template.gridSize * patchSize))),
      y: Math.max(0, Math.min(height - 1, Math.round(top + (point.y + .5) / template.gridSize * patchSize)))
    });
    let positiveLuminance = 0;
    let positiveWeight = 0;
    for (const point of template.positive) {
      const sample = coordinate(point);
      positiveLuminance += luminance(pixels, sample.x, sample.y, width) * point.weight;
      positiveWeight += point.weight;
    }
    let backgroundLuminance = 0;
    for (const point of template.background) {
      const sample = coordinate(point);
      backgroundLuminance += luminance(pixels, sample.x, sample.y, width);
    }
    if (!positiveWeight || !template.background.length) return 0;
    const foregroundMean = positiveLuminance / positiveWeight;
    const backgroundMean = backgroundLuminance / template.background.length;
    const contrast = backgroundMean - foregroundMean;
    if (contrast < 14) return 0;

    const contrastScale = Math.max(24, contrast * 1.45);
    let shapeError = 0;
    let shapeWeight = 0;
    let covered = 0;
    for (const point of template.positive) {
      const sample = coordinate(point);
      const darkness = Math.max(0, Math.min(1, (backgroundMean - luminance(pixels, sample.x, sample.y, width)) / contrastScale));
      shapeError += Math.abs(darkness - point.weight) * point.weight;
      shapeWeight += point.weight;
      if (darkness >= Math.max(.16, point.weight * .32)) covered += point.weight;
    }
    let backgroundPenalty = 0;
    for (const point of template.background) {
      const sample = coordinate(point);
      const darkness = Math.max(0, (backgroundMean - luminance(pixels, sample.x, sample.y, width)) / contrastScale);
      backgroundPenalty += Math.min(1, darkness);
    }
    const shape = Math.max(0, 1 - shapeError / Math.max(.001, shapeWeight));
    const coverage = covered / Math.max(.001, shapeWeight);
    const cleanliness = Math.max(0, 1 - backgroundPenalty / template.background.length);
    const contrastScore = Math.min(1, contrast / 72);
    return shape * .42 + coverage * .3 + cleanliness * .13 + contrastScore * .15;
  }

  function glyphShapeScoreAt(pixels, x, y, patchSize, template, width, height) {
    const left = x - patchSize / 2;
    const top = y - patchSize / 2;
    if (left < 0 || top < 0 || left + patchSize >= width || top + patchSize >= height) return 0;
    const samples = [];
    for (let gridY = 0; gridY < template.gridSize; gridY += 1) {
      for (let gridX = 0; gridX < template.gridSize; gridX += 1) {
        const sampleX = Math.round(left + (gridX + .5) / template.gridSize * patchSize);
        const sampleY = Math.round(top + (gridY + .5) / template.gridSize * patchSize);
        samples.push({ x: gridX, y: gridY, value: luminance(pixels, sampleX, sampleY, width) });
      }
    }
    const darkCount = Math.max(8, Math.min(samples.length, Math.round(template.positive.length * 1.08)));
    const darkest = samples.slice().sort((leftSample, rightSample) => leftSample.value - rightSample.value).slice(0, darkCount);
    const foregroundMean = darkest.reduce((sum, sample) => sum + sample.value, 0) / darkCount;
    const backgroundSamples = samples.slice().sort((leftSample, rightSample) => rightSample.value - leftSample.value).slice(0, Math.max(12, darkCount));
    const backgroundMean = backgroundSamples.reduce((sum, sample) => sum + sample.value, 0) / backgroundSamples.length;
    if (backgroundMean - foregroundMean < 16) return 0;
    const near = (leftPoint, rightPoint) => Math.abs(leftPoint.x - rightPoint.x) <= 1 && Math.abs(leftPoint.y - rightPoint.y) <= 1;
    let recallWeight = 0;
    let recalled = 0;
    for (const point of template.positive) {
      recallWeight += point.weight;
      if (darkest.some(sample => near(point, sample))) recalled += point.weight;
    }
    const recall = recalled / Math.max(.001, recallWeight);
    const precision = darkest.filter(sample => template.positive.some(point => near(point, sample))).length / darkCount;
    const contrastScore = Math.min(1, (backgroundMean - foregroundMean) / 90);
    return recall * .46 + precision * .39 + contrastScore * .15;
  }

  function patchDifferenceScore(pixels, baselinePixels, x, y, patchSize, width, height) {
    if (!baselinePixels) return 0;
    let difference = 0;
    let changed = 0;
    let samples = 0;
    const radius = patchSize * .58;
    for (let sampleY = -3; sampleY <= 3; sampleY += 1) {
      for (let sampleX = -3; sampleX <= 3; sampleX += 1) {
        const pixelX = Math.max(0, Math.min(width - 1, Math.round(x + sampleX / 3 * radius)));
        const pixelY = Math.max(0, Math.min(height - 1, Math.round(y + sampleY / 3 * radius)));
        const delta = Math.abs(luminance(pixels, pixelX, pixelY, width) - luminance(baselinePixels, pixelX, pixelY, width));
        difference += delta;
        if (delta >= 18) changed += 1;
        samples += 1;
      }
    }
    const average = difference / Math.max(1, samples);
    return Math.min(1, average / 72) * .58 + changed / Math.max(1, samples) * .42;
  }

  function glyphCandidates(pixels, width, height, template, bounds, anchor = null, baselinePixels = null) {
    const patchSizes = [18, 22, 26, 30].map(size => size * width / TOOL_ANALYSIS_WIDTH);
    const candidates = [];
    const step = Math.max(2, Math.round(width / 500));
    for (let y = Math.floor(height * bounds.minY); y <= Math.floor(height * bounds.maxY); y += step) {
      for (let x = Math.floor(width * bounds.minX); x <= Math.floor(width * bounds.maxX); x += step) {
        let bestScore = 0;
        let bestSize = patchSizes[0];
        for (const patchSize of patchSizes) {
          const score = glyphScoreAt(pixels, x, y, patchSize, template, width, height);
          if (score > bestScore) {
            bestScore = score;
            bestSize = patchSize;
          }
        }
        const minimumQuickScore = baselinePixels ? .42 : .57;
        if (bestScore >= minimumQuickScore) {
          const differenceScore = patchDifferenceScore(pixels, baselinePixels, x, y, bestSize, width, height);
          if (!baselinePixels || differenceScore >= .035) candidates.push({ x, y, score: bestScore, size: bestSize, differenceScore });
        }
      }
    }
    candidates.sort((left, right) => right.score - left.score);
    const reduced = [];
    for (const candidate of candidates) {
      if (reduced.every(item => Math.hypot(item.x - candidate.x, item.y - candidate.y) > Math.max(7, candidate.size * .42))) reduced.push(candidate);
      if (reduced.length >= 28) break;
    }
    if (anchor) {
      const anchorX = anchor[0] / 100 * width;
      const anchorY = anchor[1] / 100 * height;
      const anchored = [];
      const radius = Math.max(10, Math.round(width * .012));
      for (let y = anchorY - radius; y <= anchorY + radius; y += 2) {
        for (let x = anchorX - radius; x <= anchorX + radius; x += 2) {
          for (const patchSize of patchSizes) {
            const score = glyphScoreAt(pixels, x, y, patchSize, template, width, height);
            if (score >= (baselinePixels ? .3 : .38)) {
              const differenceScore = patchDifferenceScore(pixels, baselinePixels, x, y, patchSize, width, height);
              if (!baselinePixels || differenceScore >= .025) anchored.push({ x, y, score, size: patchSize, anchored: true, targetX: anchorX, targetY: anchorY, differenceScore });
            }
          }
        }
      }
      anchored.sort((left, right) => right.score - left.score);
      for (const candidate of anchored) {
        if (reduced.every(item => Math.hypot(item.x - candidate.x, item.y - candidate.y) > 5)) reduced.unshift(candidate);
        if (reduced.filter(item => item.anchored).length >= 8) break;
      }
    }
    return reduced;
  }

  function locateToolsByGlyphs(pixels, width, height, templateBank, options = {}) {
    const templates = preparedGlyphTemplates(templateBank);
    const templateBySlot = Object.fromEntries(templates.map(template => [template.slot, template]));
    if (!templateBySlot.camera || !templateBySlot.expand || !templateBySlot.info) return { ok: false, confidence: 0, reason: 'tool-templates-missing' };
    const hint = options.searchHint;
    const bounds = hint ? {
      minX: Math.max(.03, hint[0] / 100 - .25),
      maxX: Math.min(.97, hint[0] / 100 + .25),
      minY: Math.max(.12, hint[1] / 100 - .34),
      maxY: Math.min(.94, hint[1] / 100 + .34)
    } : { minX: .27, maxX: .78, minY: .34, maxY: .84 };
    const bySlot = {};
    for (const slot of ['camera', 'expand', 'info']) {
      bySlot[slot] = glyphCandidates(pixels, width, height, templateBySlot[slot], bounds, options.toolAnchors?.[slot], options.baselinePixels);
      bySlot[slot] = bySlot[slot].map(candidate => {
        const shapeScore = glyphShapeScoreAt(pixels, candidate.x, candidate.y, candidate.size, templateBySlot[slot], width, height);
        const combinedScore = options.baselinePixels
          ? candidate.score * .2 + shapeScore * .58 + candidate.differenceScore * .22
          : candidate.score * .28 + shapeScore * .72;
        const competingScore = Math.max(...templates
          .filter(template => template.slot !== slot)
          .map(template => {
            const quick = glyphScoreAt(pixels, candidate.x, candidate.y, candidate.size, template, width, height);
            const shape = glyphShapeScoreAt(pixels, candidate.x, candidate.y, candidate.size, template, width, height);
            return options.baselinePixels
              ? quick * .2 + shape * .58 + candidate.differenceScore * .22
              : quick * .28 + shape * .72;
          }));
        return { ...candidate, score: combinedScore, shapeScore, discrimination: combinedScore - competingScore };
      }).filter(candidate => candidate.score >= (options.baselinePixels ? .45 : .54)
          && candidate.discrimination >= (options.baselinePixels ? .005 : .025))
        .sort((left, right) => right.score - left.score);
    }
    if (Object.values(bySlot).some(candidates => !candidates.length)) return {
      ok: false,
      confidence: 0,
      reason: 'tool-glyph-not-found',
      candidateCounts: Object.fromEntries(Object.entries(bySlot).map(([slot, candidates]) => [slot, candidates.length]))
    };

    let best = null;
    const minimumGap = height * .032;
    const maximumGap = height * .068;
    const maximumAlignment = width * .012;
    for (const camera of bySlot.camera.slice(0, 24)) {
      for (const expand of bySlot.expand.slice(0, 24)) {
        const cameraX = camera.targetX ?? camera.x;
        const cameraY = camera.targetY ?? camera.y;
        const expandX = expand.targetX ?? expand.x;
        const expandY = expand.targetY ?? expand.y;
        const firstGap = expandY - cameraY;
        if (firstGap < minimumGap || firstGap > maximumGap || Math.abs(expandX - cameraX) > maximumAlignment) continue;
        for (const info of bySlot.info.slice(0, 24)) {
          const infoX = info.targetX ?? info.x;
          const infoY = info.targetY ?? info.y;
          const secondGap = infoY - expandY;
          if (secondGap < minimumGap || secondGap > maximumGap || Math.abs(infoX - expandX) > maximumAlignment) continue;
          const gapDifference = Math.abs(firstGap - secondGap) / Math.max(firstGap, secondGap);
          if (gapDifference > .34) continue;
          const alignment = (Math.abs(expandX - cameraX) + Math.abs(infoX - expandX)) / Math.max(1, maximumAlignment * 2);
          const glyphScore = (camera.score + expand.score + info.score) / 3;
          const score = glyphScore - gapDifference * .16 - alignment * .08;
          if (!best || score > best.score) best = { camera, expand, info, score, glyphScore, gapDifference };
        }
      }
    }
    if (!best || best.score < .55) return {
      ok: false,
      confidence: best?.score || 0,
      reason: 'tool-stack-not-found',
      candidates: Object.fromEntries(Object.entries(bySlot).map(([slot, values]) => [slot, values.slice(0, 6)]))
    };
    const targets = Object.fromEntries(['camera', 'expand', 'info'].map(slot => [slot, [
      (best[slot].targetX ?? best[slot].x) / width * 100,
      (best[slot].targetY ?? best[slot].y) / height * 100
    ]]));
    return {
      ok: true,
      confidence: Math.min(.98, .58 + (best.score - .55) * 1.3),
      targets,
      glyphScores: Object.fromEntries(['camera', 'expand', 'info'].map(slot => [slot, best[slot].score])),
      method: 'dark-glyph-template'
    };
  }

  function confirmToolGlyphsAtTargets(image, templateBank, targets, options = {}) {
    const templates = preparedGlyphTemplates(templateBank);
    const templateBySlot = Object.fromEntries(templates.map(template => [template.slot, template]));
    if (!templateBySlot.camera || !templateBySlot.expand || !templateBySlot.info) return { ok: false, reason: 'tool-templates-missing' };
    const width = TOOL_ANALYSIS_WIDTH;
    const height = Math.max(480, Math.round(width * (image.naturalHeight || image.height) / Math.max(1, image.naturalWidth || image.width)));
    const canvas = drawMaskedImage(image, width, height, options);
    const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    const patchSizes = [18, 22, 26, 30].map(size => size * width / TOOL_ANALYSIS_WIDTH);
    const matches = {};
    for (const slot of ['camera', 'expand', 'info']) {
      const anchor = targets?.[slot];
      if (!anchor) return { ok: false, reason: 'tool-ring-target-missing' };
      const anchorX = anchor[0] / 100 * width;
      const anchorY = anchor[1] / 100 * height;
      const radius = Math.max(10, Math.round(width * .014));
      let best = null;
      let bestQualified = null;
      for (let y = anchorY - radius; y <= anchorY + radius; y += 2) {
        for (let x = anchorX - radius; x <= anchorX + radius; x += 2) {
          for (const patchSize of patchSizes) {
            const quick = glyphScoreAt(pixels, x, y, patchSize, templateBySlot[slot], width, height);
            const shape = glyphShapeScoreAt(pixels, x, y, patchSize, templateBySlot[slot], width, height);
            const score = quick * .28 + shape * .72;
            const competingScore = Math.max(...templates
              .filter(template => template.slot !== slot)
              .map(template => glyphScoreAt(pixels, x, y, patchSize, template, width, height) * .28
                + glyphShapeScoreAt(pixels, x, y, patchSize, template, width, height) * .72));
            const discrimination = score - competingScore;
            if (!best || score > best.score) best = { x, y, score, discrimination };
            if (score >= .54 && discrimination >= .025 && (!bestQualified || score > bestQualified.score)) {
              bestQualified = { x, y, score, discrimination };
            }
          }
        }
      }
      if (!bestQualified) {
        return { ok: false, reason: 'tool-glyph-not-confirmed', slot, candidate: best };
      }
      matches[slot] = bestQualified;
    }
    const ordered = ['camera', 'expand', 'info'].map(slot => matches[slot]);
    const firstGap = ordered[1].y - ordered[0].y;
    const secondGap = ordered[2].y - ordered[1].y;
    const horizontalSpread = Math.max(...ordered.map(match => match.x)) - Math.min(...ordered.map(match => match.x));
    const minimumGap = height * .02;
    const maximumGap = height * .085;
    const gapDifference = Math.abs(firstGap - secondGap) / Math.max(1, firstGap, secondGap);
    if (horizontalSpread > width * .015
        || firstGap < minimumGap || firstGap > maximumGap
        || secondGap < minimumGap || secondGap > maximumGap
        || gapDifference > .25) {
      return {
        ok: false,
        reason: 'tool-glyph-stack-geometry-invalid',
        matches,
        geometry: { horizontalSpread, firstGap, secondGap, gapDifference }
      };
    }
    return {
      ok: true,
      confidence: Math.min(.98, Object.values(matches).reduce((sum, match) => sum + match.score, 0) / 3),
      matches
    };
  }

  async function locateTools(dataUrl, options = {}) {
    const [image, runtime, baselineImage] = await Promise.all([
      loadImage(dataUrl),
      loadRuntimeReferences(),
      options.baselineDataUrl ? loadImage(options.baselineDataUrl) : Promise.resolve(null)
    ]);
    const width = TOOL_ANALYSIS_WIDTH;
    const height = Math.max(480, Math.round(width * (image.naturalHeight || image.height) / Math.max(1, image.naturalWidth || image.width)));
    const canvas = drawMaskedImage(image, width, height, options);
    const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    const baselineCanvas = baselineImage ? drawMaskedImage(baselineImage, width, height, options) : null;
    const baselinePixels = baselineCanvas
      ? baselineCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data
      : null;
    const proposalCanvas = drawMaskedImage(image, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, options);
    const proposalPixels = proposalCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT).data;
    const ringProposal = locateToolRingsInPixels(proposalPixels, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, options);
    const selectedScore = statePatchScore(proposalCanvas, runtime, 'selected');
    const selectedMarginThreshold = -.001;
    if (selectedScore.positive < STATE_MIN_SCORES.selected || (!baselinePixels && selectedScore.margin < selectedMarginThreshold)) {
      return { ok: false, confidence: selectedScore.positive, reason: 'selected-tool-state-not-confirmed', stateScore: selectedScore };
    }
    const located = locateToolsByGlyphs(pixels, width, height, runtime.catalog.toolGlyphTemplates, {
      ...options,
      toolAnchors: ringProposal.ok ? ringProposal.targets : null,
      baselinePixels
    });
    return { ...located, stateScore: selectedScore };
  }

  function candidateCrops(profile, state) {
    const offsets = [[0, 0], [-.08, 0], [.08, 0], [0, -.07], [0, .07], [-.07, -.06], [.07, -.06], [-.07, .06], [.07, .06]];
    const candidates = offsets.map(([offsetX, offsetY]) => ({ ...profile, x: profile.x + offsetX, y: profile.y + offsetY }));
    candidates.push(
      { x: profile.x + profile.width * .09, y: profile.y + profile.height * .08, width: profile.width * .82, height: profile.height * .82 },
      { x: profile.x - profile.width * .08, y: profile.y - profile.height * .06, width: profile.width * 1.16, height: profile.height * 1.12 }
    );
    if (state === 'object' || state === 'info') candidates.push(
      { x: .18, y: .1, width: .64, height: .84 },
      { x: .24, y: .16, width: .52, height: .76 }
    );
    else candidates.push(
      { x: .24, y: .24, width: .52, height: .7 },
      { x: .3, y: .3, width: .4, height: .64 }
    );
    return candidates.map(normalizedCrop);
  }

  function cropSaliency(pixels, canvas, crop) {
    let score = 0;
    let samples = 0;
    const left = Math.round(crop.x * canvas.width);
    const top = Math.round(crop.y * canvas.height);
    const cropWidth = Math.max(1, Math.round(crop.width * canvas.width));
    const cropHeight = Math.max(1, Math.round(crop.height * canvas.height));
    for (let sampleY = 1; sampleY <= 9; sampleY += 1) {
      for (let sampleX = 1; sampleX <= 9; sampleX += 1) {
        const x = Math.max(1, Math.min(canvas.width - 2, Math.round(left + sampleX / 10 * cropWidth)));
        const y = Math.max(1, Math.min(canvas.height - 2, Math.round(top + sampleY / 10 * cropHeight)));
        const offset = (y * canvas.width + x) * 4;
        const r = pixels[offset] / 255;
        const g = pixels[offset + 1] / 255;
        const b = pixels[offset + 2] / 255;
        if (Math.abs(r * 255 - 184) < 4 && Math.abs(g * 255 - 184) < 4 && Math.abs(b * 255 - 184) < 4) continue;
        const maximum = Math.max(r, g, b);
        const minimum = Math.min(r, g, b);
        const saturation = maximum ? (maximum - minimum) / maximum : 0;
        const current = r * .2126 + g * .7152 + b * .0722;
        const rightOffset = (y * canvas.width + x + 1) * 4;
        const belowOffset = ((y + 1) * canvas.width + x) * 4;
        const rightLuminance = (pixels[rightOffset] * .2126 + pixels[rightOffset + 1] * .7152 + pixels[rightOffset + 2] * .0722) / 255;
        const belowLuminance = (pixels[belowOffset] * .2126 + pixels[belowOffset + 1] * .7152 + pixels[belowOffset + 2] * .0722) / 255;
        const edge = Math.min(1, (Math.abs(rightLuminance - current) + Math.abs(belowLuminance - current)) * 4);
        score += saturation * .9 + Math.max(0, .72 - current) * .65 + edge * 1.55;
        samples += 1;
      }
    }
    return score / Math.max(1, samples);
  }

  function dynamicCandidateCrops(canvas, profile, state) {
    const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
    const proposals = [];
    const enlarged = state === 'object' || state === 'info';
    const widths = enlarged ? [.16, .21, .26, .34, .42, .5, .58] : [.14, .18, .22, .28, .34, .42, .5];
    const centersX = enlarged ? [.26, .36, .46, .56, .66, .74] : [.3, .38, .46, .54, .62, .7];
    const centersY = enlarged ? [.36, .48, .6, .72] : [.44, .56, .68, .76];
    for (const width of widths) {
      for (const aspect of [1.55, 2.25]) {
        const height = Math.min(.82, width * aspect);
        for (const centerX of centersX) {
          for (const centerY of centersY) {
            const crop = normalizedCrop({ x: centerX - width / 2, y: centerY - height / 2, width, height });
            if (crop.width < width * .85 || crop.height < height * .85) continue;
            const centerPrior = 1 - Math.min(1, Math.hypot((centerX - .5) * 1.35, (centerY - .6) * .72));
            const foregroundPrior = Math.min(1, width / .42);
            proposals.push({ crop, score: cropSaliency(pixels, canvas, crop) + centerPrior * .15 + foregroundPrior * .025 });
          }
        }
      }
    }
    proposals.sort((left, right) => right.score - left.score);
    const selected = [];
    for (const proposal of proposals) {
      const center = [proposal.crop.x + proposal.crop.width / 2, proposal.crop.y + proposal.crop.height / 2];
      if (selected.every(item => Math.hypot(center[0] - item.center[0], center[1] - item.center[1]) > .055 || Math.abs(proposal.crop.width - item.crop.width) > .09)) {
        selected.push({ ...proposal, center });
      }
      if (selected.length >= 10) break;
    }
    const combined = [...candidateCrops(profile, state), ...selected.map(item => item.crop)];
    return combined.filter((crop, index) => combined.findIndex(other => (
      Math.abs(other.x - crop.x) < .012 && Math.abs(other.y - crop.y) < .012 && Math.abs(other.width - crop.width) < .012
    )) === index);
  }

  function compatibleReferenceStates(state) {
    if (state === 'object') return new Set(['object']);
    if (state === 'info') return new Set(['info', 'object']);
    return new Set(['ordinary', 'selected']);
  }

  function matchIdentity(analysisCanvas, runtime, state) {
    const profileKey = runtime.catalog.cropProfiles[state] ? state : 'ordinary';
    const profile = runtime.catalog.cropProfiles[profileKey];
    const analysisPixels = analysisCanvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, analysisCanvas.width, analysisCanvas.height).data;
    const candidates = dynamicCandidateCrops(analysisCanvas, profile, state).map(crop => {
      const descriptor = identityDescriptor(analysisCanvas, crop);
      const centerX = crop.x + crop.width / 2;
      const centerY = crop.y + crop.height / 2;
      const subjectPrior = Math.max(.9, 1 - Math.hypot((centerX - .5) * 1.25, (centerY - .6) * .7) * .16);
      return {
        crop,
        descriptor,
        vector: vectorFromCanvas(analysisCanvas, crop),
        aiProbabilities: predictLocalVision(descriptor, runtime.localVisionModel),
        subjectPrior,
        subjectEvidence: cropSaliency(analysisPixels, analysisCanvas, crop)
      };
    });
    const allowedStates = compatibleReferenceStates(state);
    const matchesByExhibit = new Map();
    for (const reference of runtime.identity) {
      if (reference.domain !== 'model' && !allowedStates.has(reference.state)) continue;
      let score = 0;
      let bestAiSupport = null;
      let bestSubjectEvidence = 0;
      for (const candidate of candidates) {
        const structural = descriptorSimilarity(candidate.descriptor, reference.descriptor);
        const appearance = similarity(candidate.vector, reference.vector);
        const visualScore = reference.domain === 'model'
          ? (structural * .8 + appearance * .2) * .97
          : structural * .58 + appearance * .42;
        const classIndex = runtime.localVisionModel?.labels.indexOf(reference.exhibitId) ?? -1;
        const aiSupport = classIndex >= 0 ? candidate.aiProbabilities?.[classIndex] || 0 : null;
        const foregroundVisualScore = visualScore * candidate.subjectPrior;
        const candidateScore = aiSupport === null
          ? foregroundVisualScore
          : foregroundVisualScore * .82 + aiSupport * .18;
        if (candidateScore >= score) {
          score = candidateScore;
          bestAiSupport = aiSupport;
          bestSubjectEvidence = candidate.subjectEvidence;
        }
      }
      if (!matchesByExhibit.has(reference.exhibitId)) matchesByExhibit.set(reference.exhibitId, []);
      matchesByExhibit.get(reference.exhibitId).push({
        score,
        reference: reference.source,
        domain: reference.domain || 'screenshot',
        aiSupport: bestAiSupport,
        subjectEvidence: bestSubjectEvidence
      });
    }
    const ranked = Array.from(matchesByExhibit, ([exhibitId, matches]) => {
      const bestBySource = new Map();
      for (const match of matches) {
        const previous = bestBySource.get(match.reference);
        if (!previous || match.score > previous.score) bestBySource.set(match.reference, match);
      }
      const distinctMatches = Array.from(bestBySource.values()).sort((left, right) => right.score - left.score);
      const top = distinctMatches.slice(0, 3);
      const weights = [.72, .18, .1];
      const weightTotal = top.reduce((sum, _match, index) => sum + weights[index], 0) || 1;
      const score = top.reduce((sum, match, index) => sum + match.score * weights[index], 0) / weightTotal;
      return {
        exhibitId,
        ...top[0],
        score,
        peakScore: top[0]?.score || 0,
        supportScore: top.reduce((sum, match) => sum + match.score, 0) / Math.max(1, top.length),
        supportingReferences: top.map(match => match.reference)
      };
    }).sort((left, right) => right.score - left.score);
    const best = ranked[0] || { exhibitId: null, score: 0 };
    const separation = best.score - (ranked[1]?.score || 0);
    const corroborated = best.peakScore >= .88 && (best.aiSupport >= .72 || best.supportScore >= .86);
    const known = best.score >= IDENTITY_MIN_SCORE
      && separation >= IDENTITY_MIN_SEPARATION
      && best.subjectEvidence >= IDENTITY_MIN_SUBJECT_EVIDENCE
      && corroborated;
    return { exhibitId: known ? best.exhibitId : null, confidence: best.score, separation, alternatives: ranked.slice(0, 3) };
  }

  function statePatchScore(analysisCanvas, runtime, state) {
    const profile = runtime.catalog.stateCropProfiles[state];
    const vector = vectorFromCanvas(analysisCanvas, profile);
    let positive = 0;
    let negative = 0;
    for (const reference of runtime.state) {
      if (reference.detector !== state) continue;
      const score = similarity(vector, reference.vector);
      if (reference.positive) positive = Math.max(positive, score);
      else negative = Math.max(negative, score);
    }
    return { positive, negative, margin: positive - negative };
  }

  function legacyMatch(rawCanvas, runtime) {
    const vector = vectorFromCanvas(rawCanvas);
    const descriptor = identityDescriptor(rawCanvas);
    const ranked = runtime.legacy.map(reference => ({
      key: reference.key,
      confidence: descriptorSimilarity(descriptor, reference.descriptor) * .68 + similarity(vector, reference.vector) * .32
    })).sort((left, right) => right.confidence - left.confidence);
    return {
      best: ranked[0],
      separation: (ranked[0]?.confidence || 0) - (ranked[1]?.confidence || 0),
      alternatives: ranked.slice(0, 3)
    };
  }

  async function analyze(dataUrl, options = {}) {
    const [image, runtime] = await Promise.all([loadImage(dataUrl), loadRuntimeReferences()]);
    const size = analysisDimensions(image);
    const analysisCanvas = drawMaskedImage(image, size.width, size.height, options);
    const rawCanvas = drawMaskedImage(image, size.width, size.height);
    const pixels = analysisCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size.width, size.height).data;
    const map = options.skipMapDetection ? null : detectMapGeometry(pixels, size.width, size.height);
    if (map) return { state: 'map', stateConfidence: map.confidence, analysisCanvas, rawCanvas, runtime, map };
    if (options.pageStateHint === 'ordinary') {
      return { state: 'ordinary', stateConfidence: .72, analysisCanvas, rawCanvas, runtime, stateScores: null };
    }

    const infoScore = statePatchScore(analysisCanvas, runtime, 'info');
    const objectScore = statePatchScore(analysisCanvas, runtime, 'object');
    const selectedScore = statePatchScore(analysisCanvas, runtime, 'selected');
    if (infoScore.positive >= STATE_MIN_SCORES.info && infoScore.margin >= .012 && infoScore.margin >= objectScore.margin - .008) {
      return { state: 'info', stateConfidence: infoScore.positive, analysisCanvas, rawCanvas, runtime, stateScores: { selected: selectedScore, info: infoScore, object: objectScore } };
    }
    if (objectScore.positive >= STATE_MIN_SCORES.object && objectScore.margin >= .012) {
      return { state: 'object', stateConfidence: objectScore.positive, analysisCanvas, rawCanvas, runtime, stateScores: { selected: selectedScore, info: infoScore, object: objectScore } };
    }

    const toolProposalCanvas = drawMaskedImage(image, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, options);
    const toolProposalPixels = toolProposalCanvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT).data;
    const tools = locateToolRingsInPixels(toolProposalPixels, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, options);
    const selectedMarginThreshold = options.searchHint ? -.015 : .0015;
    if (selectedScore.positive >= STATE_MIN_SCORES.selected && selectedScore.margin >= selectedMarginThreshold && tools.ok) {
      const glyphs = confirmToolGlyphsAtTargets(image, runtime.catalog.toolGlyphTemplates, tools.targets, options);
      if (glyphs.ok) return {
        state: 'selected',
        stateConfidence: Math.max(selectedScore.positive, tools.confidence, glyphs.confidence),
        analysisCanvas,
        rawCanvas,
        runtime,
        tools: { ...tools, glyphs },
        stateScores: { selected: selectedScore, info: infoScore, object: objectScore }
      };
    }
    return { state: 'ordinary', stateConfidence: .72, analysisCanvas, rawCanvas, runtime, stateScores: { selected: selectedScore, info: infoScore, object: objectScore } };
  }

  function exhibitKey(exhibitId) {
    return exhibitId ? `object${Number(exhibitId.slice(-2))}` : null;
  }

  async function classify(dataUrl, options = {}) {
    const result = await analyze(dataUrl, options);
    if (result.state === 'map') {
      return { key: 'map', state: 'map', exhibitId: null, confidence: result.stateConfidence, separation: .2, alternatives: [{ key: 'map', confidence: result.stateConfidence }] };
    }

    const legacy = legacyMatch(result.rawCanvas, result.runtime);
    if (legacy.best?.key === 'entry' && legacy.best.confidence >= .995 && legacy.separation >= .012) {
      return {
        key: 'entry',
        state: 'entry',
        exhibitId: null,
        confidence: legacy.best.confidence,
        separation: legacy.separation,
        alternatives: legacy.alternatives
      };
    }

    const identity = matchIdentity(result.analysisCanvas, result.runtime, result.state);
    if (identity.exhibitId) {
      const key = result.state === 'ordinary' ? exhibitKey(identity.exhibitId) : result.state;
      return {
        key,
        state: result.state,
        exhibitId: identity.exhibitId,
        confidence: Math.min(.99, identity.confidence * .72 + result.stateConfidence * .28),
        separation: identity.separation,
        alternatives: identity.alternatives,
        stateScores: result.stateScores
      };
    }

    if (['info', 'object', 'selected'].includes(result.state) && result.stateConfidence >= .78) {
      return {
        key: result.state,
        state: result.state,
        exhibitId: null,
        confidence: Math.min(.88, result.stateConfidence),
        separation: identity.separation,
        alternatives: identity.alternatives,
        stateScores: result.stateScores
      };
    }

    const legacyScoreThreshold = legacy.best?.key === 'entry' ? .995 : LEGACY_MIN_SCORE;
    const legacySeparationThreshold = legacy.best?.key === 'entry' ? .012 : LEGACY_MIN_SEPARATION;
    if (legacy.best?.confidence >= legacyScoreThreshold
        && legacy.separation >= legacySeparationThreshold
        && legacy.best.key !== 'explore') {
      return {
        key: legacy.best.key,
        state: legacy.best.key,
        exhibitId: null,
        confidence: legacy.best.confidence,
        separation: legacy.separation,
        alternatives: legacy.alternatives
      };
    }

    return {
      key: 'unknown',
      state: 'unknown',
      exhibitId: null,
      confidence: Math.min(.69, Math.max(identity.confidence, legacy.best?.confidence || 0)),
      separation: identity.separation,
      alternatives: identity.alternatives,
      legacySeparation: legacy.separation,
      legacyAlternatives: legacy.alternatives,
      stateScores: result.stateScores
    };
  }

  async function detectState(dataUrl, expectedState, options = {}) {
    if (expectedState === 'selected' && options.baselineDataUrl) {
      const tools = await locateTools(dataUrl, options);
      return {
        ok: tools.ok,
        key: tools.ok ? 'selected' : 'unknown',
        state: tools.ok ? 'selected' : 'unknown',
        exhibitId: null,
        confidence: tools.confidence,
        tools
      };
    }
    const result = await classify(dataUrl, options);
    const matches = expectedState?.startsWith('not-') ? result.state !== expectedState.slice(4) : result.state === expectedState || result.key === expectedState;
    return { ok: Boolean(matches), ...result };
  }

  globalThis.MetastepsSceneClassifier = {
    classify,
    detectState,
    locateTools,
    thresholds: { identity: IDENTITY_MIN_SCORE, separation: IDENTITY_MIN_SEPARATION, legacy: LEGACY_MIN_SCORE, legacySeparation: LEGACY_MIN_SEPARATION },
    referenceCount: 160,
    localVisionModel: 'local-mlp-descriptor-classifier',
    referenceBanks: ['page-state', 'exhibit-identity', 'map-state']
  };
})();
