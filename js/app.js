/* BRASS — Main Application Bootstrapper
 * Initializes city generation, road network graph, document store,
 * high-DPI canvas renderer, tool controller, and UI event bindings.
 */
(function () {
  window.addEventListener('DOMContentLoaded', () => {
    const B = window.B;
    const canvas = document.getElementById('map-canvas');

    // 1. Generate island city
    console.time('Generate City');
    const city = B.generateCity();
    console.timeEnd('Generate City');

    // 2. Build road network graph
    console.time('Road Network');
    const net = new B.RoadNetwork(city);
    console.timeEnd('Road Network');
    city.mrtStations = B.placeMrtStations(city, net);

    // 3. Build sample bus routes & stops
    console.time('Sample Data');
    const sampleDoc = B.buildSampleDoc(city, net);
    console.timeEnd('Sample Data');
    // Saved maps keep only their changes from this network; maps from the earlier island are set aside
    B.setDocBase(JSON.stringify(sampleDoc));
    B.migrateStorage();

    // 4. Initialize reactive document store
    const store = new B.Store(city, net, sampleDoc);

    // 5. Initialize canvas renderer
    const renderer = new B.MapRenderer(canvas, city, net, store);

    // 6. Initialize interactive controller
    const controller = new B.Controller(city, net, store, renderer);

    // Initial fit to island boundary
    setTimeout(() => {
      renderer.fitToBoundary();
    }, 100);

    // ------------------------------------------------------------- Map Control Buttons
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      renderer.zoomAt(renderer.width / 2, renderer.height / 2, 1.25);
    });

    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      renderer.zoomAt(renderer.width / 2, renderer.height / 2, 0.8);
    });



    // Close Inspector
    document.getElementById('btn-close-inspector').addEventListener('click', () => {
      controller._hideInspector();
      renderer.selected = null;
      renderer.requestRender();
    });

    // Close Road Segment (the Bus Route panel stays open)
    document.getElementById('btn-close-segment').addEventListener('click', () => {
      controller._dismissSegmentPanel();
    });

    // Route Connecting HUD Bar buttons
    const btnConnFinish = document.getElementById('btn-conn-finish');
    if (btnConnFinish) {
      btnConnFinish.addEventListener('click', () => {
        controller._finishConnectingStops();
      });
    }

    const btnConnNewLine = document.getElementById('btn-conn-new-line');
    if (btnConnNewLine) {
      btnConnNewLine.addEventListener('click', () => {
        controller._startNewBusLine();
      });
    }

    const btnConnCancel = document.getElementById('btn-conn-cancel');
    if (btnConnCancel) {
      btnConnCancel.addEventListener('click', () => {
        controller._cancelConnectingStops();
      });
    }

    // ------------------------------------------------------------- Layer Toggles
    const layerCheckboxes = {
      'layer-routes': ['existingRoutes', 'proposedRoutes'],
      'layer-stop-points': ['stopPoints'],
      'layer-stop-names': ['stopNames'],
      'layer-mrt': ['mrtStations'],
      'layer-stops': ['stopPoints', 'stops'],
      'layer-closures': ['closures'],
      'layer-areas': ['affectedAreas'],
      'layer-buildings': ['buildings'],
      'layer-parks': ['parks', 'waterways'],
    };

    Object.entries(layerCheckboxes).forEach(([id, layerKeys]) => {
      const chk = document.getElementById(id);
      if (chk) {
        chk.addEventListener('change', (e) => {
          layerKeys.forEach((k) => (renderer.layers[k] = e.target.checked));
          renderer.requestRender();
        });
      }
    });



    // Bus route operations dropdown and randomize button are managed by B.Controller


    // Initial state refresh
    controller._updateUIState();

    // Expose for testing & console inspection
    window.BRASS_APP = { city, net, store, renderer, controller };
    console.log('🚍 BRASS Map Editor loaded successfully.', window.BRASS_APP);
  });
})();
