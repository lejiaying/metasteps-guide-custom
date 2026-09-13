(() => {
  const mapButton = { type: 'fixed', target: [2.7, 80.5] };
  const flows = {
    start: {
      title: 'Wie fange ich an?',
      steps: [
        { kind: 'explanation', icon: 'mouse', text: 'Willkommen in der Ausstellung. Sie können sich mit der Maus durch den Raum bewegen.', position: 'bottom-center' },
        { kind: 'action', icon: 'click', text: 'Klicken Sie auf eine freie Stelle auf dem Boden. Ihre Figur geht dorthin.', position: 'top-center', target: [50, 72], markerStyle: 'icon-only' },
        { kind: 'action', icon: 'drag', text: 'Halten Sie die linke Maustaste gedrückt und ziehen Sie die Maus. So ändern Sie Ihre Blickrichtung.', position: 'bottom-center', target: [54, 46], markerStyle: 'gesture-drag' },
        { kind: 'explanation', icon: 'help', text: 'Wenn Sie später Hilfe brauchen, öffnen Sie diesen Hilfe-Knopf erneut.', position: 'left-center' },
        { kind: 'terminal', icon: 'start', text: 'Sie können jetzt mit dem Rundgang beginnen.', position: 'center' }
      ]
    },
    move: {
      title: 'Im Raum bewegen',
      steps: [
        { kind: 'action', icon: 'click', text: 'Klicken Sie auf die Stelle am Boden, zu der Sie gehen möchten.', position: 'top-center', target: [52, 72], markerStyle: 'icon-only' },
        { kind: 'action', icon: 'drag', text: 'Halten Sie die linke Maustaste gedrückt und ziehen Sie die Maus. So sehen Sie sich nach links oder rechts um.', position: 'bottom-center', target: [55, 46], markerStyle: 'gesture-drag' },
        { kind: 'action', icon: 'map', text: 'Für einen längeren Weg öffnen Sie unten links die Karte.', position: 'left-center', locator: mapButton, size: 72, visualSize: 58, markerStyle: 'ring-only map-icon-ring', ringOnly: true, requireTargetHit: true, extra: 'Sie können sich auch mit den Tasten W, A, S und D bewegen.' },
        { kind: 'terminal', icon: 'map', text: 'Wählen Sie auf der Karte ein Ziel aus. Metasteps führt Ihre Figur automatisch dorthin.', position: 'map-right' }
      ]
    },
    exhibit: {
      title: 'Am Ausstellungsstück',
      steps: [
        { kind: 'action', icon: 'click', text: 'Klicken Sie einmal auf das Ausstellungsstück.', position: 'left-center', target: [48, 58], markerStyle: 'object-click', visualSize: 88, visualOffsetX: 4, expectedState: 'selected' },
        { kind: 'choice', icon: 'exhibit', text: 'Neben dem Ausstellungsstück erscheinen drei Knöpfe. Was möchten Sie tun?', position: 'left-center', locator: { type: 'tools' }, sceneChoices: [
          { label: 'Kamera ausrichten', flow: 'cameraBranch', step: 1, slot: 'camera' },
          { label: 'Objekt groß ansehen', flow: 'enlargeBranch', step: 1, slot: 'expand' },
          { label: 'Informationen lesen', flow: 'infoBranch', step: 1, slot: 'info' }
        ] }
      ]
    },
    cameraBranch: {
      title: 'Kamera ausrichten',
      steps: [
        { kind: 'action', icon: 'camera', text: 'Klicken Sie auf den oberen Knopf mit der Lupe.', position: 'left-center', locator: { type: 'tool', slot: 'camera' }, size: 52, markerStyle: 'ring-only', ringOnly: true },
        { kind: 'terminal', icon: 'camera', text: 'Das Ausstellungsstück befindet sich jetzt in der Mitte Ihres Blickfeldes.', position: 'left-center' }
      ]
    },
    enlargeBranch: {
      title: 'Objekt groß ansehen',
      steps: [
        { kind: 'action', icon: 'expand', text: 'Klicken Sie auf den mittleren Knopf mit den Pfeilen.', position: 'left-center', locator: { type: 'tool', slot: 'expand' }, size: 52, markerStyle: 'ring-only', ringOnly: true, expectedState: 'object' },
        { kind: 'action', icon: 'drag', text: 'Halten Sie die linke Maustaste gedrückt und ziehen Sie die Maus. So drehen Sie das Ausstellungsstück.', position: 'left-center', target: [50, 61], size: 94, markerStyle: 'gesture-drag' },
        { kind: 'action', icon: 'scroll', text: 'Drehen Sie das Mausrad, um das Ausstellungsstück zu vergrößern oder zu verkleinern.', position: 'left-center', target: [51, 57], size: 94, markerStyle: 'gesture-scroll' },
        { kind: 'action', icon: 'close', text: 'Klicken Sie oben rechts auf das Kreuz, um die große Ansicht zu schließen.', position: 'right-center', target: [92.7, 12.2], size: 58, markerStyle: 'ring-only', ringOnly: true, expectedState: 'not-object' },
        { kind: 'terminal', icon: 'close', text: 'Die große Ansicht ist geschlossen. Sie können Ihren Rundgang fortsetzen.', position: 'right-center' }
      ]
    },
    infoBranch: {
      title: 'Informationen lesen',
      steps: [
        { kind: 'action', icon: 'info', text: 'Klicken Sie auf den unteren Knopf mit dem Buchstaben i.', position: 'left-center', locator: { type: 'tool', slot: 'info' }, size: 52, markerStyle: 'ring-only', ringOnly: true, expectedState: 'info' },
        { kind: 'action', icon: 'scroll', text: 'Die Informationen erscheinen rechts. Scrollen Sie im Fenster, um den ganzen Text zu lesen.', position: 'left-center', target: [84, 67], size: 86, markerStyle: 'gesture-scroll' },
        { kind: 'action', icon: 'close', text: 'Schließen Sie das Informationsfenster mit dem Kreuz oben rechts.', position: 'left-center', target: [92.4, 31.2], size: 58, markerStyle: 'ring-only', ringOnly: true, expectedState: 'not-info' },
        { kind: 'terminal', icon: 'close', text: 'Das Informationsfenster ist geschlossen. Sie können Ihren Rundgang fortsetzen.', position: 'left-center' }
      ]
    },
    lost: {
      title: 'Zu Objekt 1',
      steps: [
        { kind: 'action', icon: 'map', text: 'Öffnen Sie unten links die Karte.', position: 'center', locator: mapButton, size: 72, visualSize: 58, markerStyle: 'ring-only map-icon-ring', ringOnly: true, requireTargetHit: true },
        { kind: 'terminal', icon: 'map', text: 'Klicken Sie auf den schwarzen, quadratischen Punkt links unten in der Karte. So gelangen Sie zu Objekt 1. Mit den anderen schwarzen Punkten gelangen Sie direkt zu den anderen Ausstellungsstücken.', position: 'map-right' }
      ]
    },
    lostMap: {
      title: 'Zu Objekt 1',
      steps: [
        { kind: 'terminal', icon: 'map', text: 'Klicken Sie auf den schwarzen, quadratischen Punkt links unten in der Karte. So gelangen Sie zu Objekt 1. Mit den anderen schwarzen Punkten gelangen Sie direkt zu den anderen Ausstellungsstücken.', position: 'map-right' }
      ]
    }
  };

  const recognition = {
    entry: { title: 'Sie befinden sich am Anfang der Ausstellung.', flow: 'start' },
    explore: { title: 'Sie bewegen sich gerade durch den Ausstellungsraum.', flow: 'move' },
    before: { title: 'Sie stehen vor einem Ausstellungsstück.', flow: 'exhibit' },
    object1: { title: 'Sie stehen vor Objekt 1, der schwarzen Teedose.', flow: 'exhibit' },
    object2: { title: 'Sie stehen vor Objekt 2, der Flasche mit Tierkopfausguss.', flow: 'exhibit' },
    object3: { title: 'Sie stehen vor Objekt 3, der Fasanenterrine.', flow: 'exhibit' },
    object4: { title: 'Sie stehen vor Objekt 4, dem Plat de Ménage.', flow: 'exhibit' },
    object5: { title: 'Sie stehen vor Objekt 5, der gelben Teedose.', flow: 'exhibit' },
    object6: { title: 'Sie stehen vor Objekt 6, der Sängerin aus der Affenkapelle.', flow: 'exhibit' },
    selected: { title: 'Das Ausstellungsstück ist ausgewählt; die drei Funktionen sind sichtbar.', flow: 'exhibit', step: 1 },
    camera: { title: 'Die Kamera ist auf das Ausstellungsstück gerichtet.', flow: 'cameraBranch', step: 1 },
    object: { title: 'Sie sehen das Ausstellungsstück in der großen Ansicht.', flow: 'enlargeBranch', step: 1 },
    zoomed: { title: 'Sie sehen das Ausstellungsstück in der großen Ansicht.', flow: 'enlargeBranch', step: 2 },
    info: { title: 'Das Informationsfenster ist geöffnet.', flow: 'infoBranch', step: 1 },
    map: { title: 'Die Karte ist geöffnet.', flow: 'lostMap' }
  };

  globalThis.MetastepsGuideConfig = { flows, recognition };
})();
