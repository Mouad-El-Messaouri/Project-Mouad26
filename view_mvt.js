// ── STATE ────────────────────────────────────────────────────────────────────
var map               = null;
var currentDataset    = null;
var allDatasets       = [];
var currentGeometryType = null;
var currentAttributes = [];
var activePopup       = null;
var urlUpdateTimer    = null;
var activeLayers      = {};

// Label renderer state
var _labelAttr  = null;
var _labelSize  = 12;
var _labelColor = '#202124';
var _labelFrame = null;

// ── CONSTANTS ────────────────────────────────────────────────────────────────
var LAYER_COLORS = [
  { fill: '#4285f4', outline: '#1a73e8', circle: '#4285f4', line: '#4285f4' },
  { fill: '#ea4335', outline: '#c5221f', circle: '#ea4335', line: '#ea4335' },
  { fill: '#34a853', outline: '#1e8e3e', circle: '#34a853', line: '#34a853' },
  { fill: '#fbbc04', outline: '#e37400', circle: '#fbbc04', line: '#fbbc04' },
  { fill: '#9c27b0', outline: '#7b1fa2', circle: '#9c27b0', line: '#9c27b0' },
  { fill: '#00bcd4', outline: '#0097a7', circle: '#00bcd4', line: '#00bcd4' }
];

// Hardcoded metadata for known datasets (used when server stats are unavailable)
var datasetMetadata = {
  'OSM2015/all_objects': { size: '91.6 GB', records: '264 m', geometry: 'GEOMETRYCOLLECTION', desc: 'All OpenStreetMap objects.' },
  'TIGER2018/COUNTY':   { size: '2.3 GB',  records: '3142',  geometry: 'POLYGON',             desc: 'US County boundaries.' },
  'TIGER2018/POINTLM':  { size: '1.8 GB',  records: '100 k', geometry: 'POINT',               desc: 'Point landmarks.' },
  'TIGER2018/ROADS':    { size: '45 GB',   records: '22 m',  geometry: 'LINESTRING',          desc: 'US Road network.' }
};

var datasetAttributesFallback = {
  'TIGER2018/COUNTY':  ['ALAND', 'AWATER', 'STATEFP', 'COUNTYFP', 'NAME'],
  'TIGER2018/POINTLM': ['MTFCC', 'NAME'],
  'TIGER2018/ROADS':   ['MTFCC', 'RTTYP', 'FULLNAME']
};

// ── DOM REFS ─────────────────────────────────────────────────────────────────
var searchInput     = document.getElementById('searchInput');
var downloadAllBtn  = document.getElementById('downloadAllBtn');
var downloadViewBtn = document.getElementById('downloadViewBtn');
var legendEl        = document.getElementById('legend');
var legendContentEl = document.getElementById('legendContent');

// ── URL STATE ─────────────────────────────────────────────────────────────────
function parseUrlState() {
  var p  = new URLSearchParams(window.location.search);
  var hp = new URLSearchParams(window.location.hash.slice(1));
  var dataset = p.get('dataset') || null;
  var center  = null;
  var zoom    = null;
  var cs = hp.get('center');
  if (cs) {
    var pts = cs.split(',').map(Number);
    if (pts.length === 2 && !isNaN(pts[0])) center = [pts[1], pts[0]];
  }
  var zs = hp.get('zoom');
  if (zs) zoom = parseFloat(zs);
  return { dataset: dataset, center: center, zoom: zoom };
}

function updateUrl() {
  if (!map) return;
  var c = map.getCenter(), z = map.getZoom();
  var datasets = Object.keys(activeLayers);
  var search = datasets.length ? '?datasets=' + datasets.map(encodeURIComponent).join(',') : '';
  var hash   = 'center=' + c.lat.toFixed(5) + ',' + c.lng.toFixed(5) + '&zoom=' + z.toFixed(2);
  window.history.replaceState({}, '', window.location.pathname + search + '#' + hash);
}

function scheduleUrlUpdate() {
  clearTimeout(urlUpdateTimer);
  urlUpdateTimer = setTimeout(updateUrl, 150);
}

// ── ATTRIBUTE HELPERS ─────────────────────────────────────────────────────────
async function loadAttributes(dataset) {
  try {
    var res  = await fetch('/api/datasets/' + encodeURIComponent(dataset) + '/stats');
    if (!res.ok) throw new Error();
    var data = await res.json();
    currentAttributes = Array.isArray(data.attributes)
      ? data.attributes.filter(function(a) { return a.name !== 'geometry'; })
      : [];
  } catch(e) {
    currentAttributes = [];
  }
}

function getAttributeNames() {
  if (currentAttributes.length) return currentAttributes.map(function(a) { return a.name; });
  return (currentDataset && datasetAttributesFallback[currentDataset]) || [];
}

// ── DATASET LIST ──────────────────────────────────────────────────────────────
async function loadDatasets() {
  try {
    var res  = await fetch('/api/datasets');
    var data = await res.json();
    allDatasets = data.datasets || [];
    document.getElementById('datasetCount').textContent = allDatasets.length;
    renderDatasetList();
  } catch(e) {
    document.getElementById('datasetList').innerHTML =
      '<div style="padding:40px 20px;color:#d93025;text-align:center;">Server offline</div>';
  }
}

function renderDatasetList(filter) {
  filter = filter || '';
  var listEl   = document.getElementById('datasetList');
  var filtered = allDatasets.filter(function(d) {
    return d.toLowerCase().indexOf(filter.toLowerCase()) !== -1;
  });

  if (!filtered.length) {
    listEl.innerHTML = '<div style="padding:40px 20px;color:#9aa0a6;text-align:center;">No datasets found</div>';
    return;
  }

  listEl.innerHTML = filtered.map(function(d) {
    var isActive = !!activeLayers[d];
    // Show "+" only when dataset is NOT already loaded (adding same one twice breaks map)
    var addBtn = isActive
      ? ''
      : '<span class="ds-add-btn" onclick="event.stopPropagation();addDatasetLayer(\'' + d + '\')" title="Add as extra layer">+</span>';
    return (
      '<div class="dataset-item' + (d === currentDataset ? ' active' : '') + (isActive ? ' loaded' : '') + '"' +
      ' onclick="selectDataset(\'' + d + '\')"' +
      ' title="' + (isActive ? 'Active — click layers panel to manage' : 'Click to switch to this dataset') + '">' +
        (isActive ? '<span class="ds-check">&#10003;</span>' : '<span class="ds-dot-empty"></span>') +
        '<span class="ds-name">' + d + '</span>' +
        addBtn +
      '</div>'
    );
  }).join('');
}

// ── LAYER MANAGEMENT ──────────────────────────────────────────────────────────

// Normal click on dataset list: switch (removes previous layers first)
async function selectDataset(dataset) {
  if (currentDataset === dataset) return;
  var toRemove = Object.keys(activeLayers).filter(function(d) { return d !== dataset; });
  toRemove.forEach(function(d) { removeDatasetLayer(d); });
  if (!activeLayers[dataset]) {
    await addDatasetLayer(dataset);
  } else {
    selectActiveDataset(dataset);
  }
}

// "+" button: add as extra overlay layer without removing existing ones
async function toggleDatasetLayer(dataset) {
  if (activeLayers[dataset]) {
    removeDatasetLayer(dataset);
  } else {
    await addDatasetLayer(dataset);
  }
}

async function addDatasetLayer(dataset) {
  if (!map) return;
  var idx = Object.keys(activeLayers).length;
  if (idx >= LAYER_COLORS.length) {
    alert('Maximum ' + LAYER_COLORS.length + ' layers at once.');
    return;
  }

  currentDataset = dataset;

  // Animate map transition
  var mapEl = document.getElementById('map');
  mapEl.classList.add('dataset-switching');
  setTimeout(function() { mapEl.classList.remove('dataset-switching'); }, 400);

  await loadAttributes(dataset);

  // Detect geometry type from server stats
  var sl       = 'layer0';
  var geomType = null;
  try {
    var r = await fetch('/api/datasets/' + encodeURIComponent(dataset) + '/stats');
    if (r.ok) {
      var d = await r.json();
      if (d.source_layer) sl = d.source_layer;
      if (d.geometry_type) {
        var gt = String(d.geometry_type).toLowerCase();
        if (gt.indexOf('point') !== -1)                              geomType = 'point';
        else if (gt.indexOf('line') !== -1 || gt.indexOf('string') !== -1) geomType = 'line';
        else if (gt.indexOf('polygon') !== -1)                       geomType = 'polygon';
      }
    }
  } catch(e) {}

  // Fallback: infer from dataset name
  if (!geomType) {
    var n       = dataset.toUpperCase();
    var pointKw = ['POINT','PORT','AIRPORT','STATION','STOP','NODE','TOWER','ANTENNA','HOSPITAL','SCHOOL','LANDMARK','PLACE','CITY','TOWN'];
    var lineKw  = ['ROAD','EDGE','LINE','RAIL','TRACK','PIPE','CABLE','STREET','HIGHWAY','PATH','ROUTE','RIVER','STREAM'];
    var isPoint = pointKw.some(function(k) { return n.indexOf(k) !== -1; });
    var isLine  = !isPoint && lineKw.some(function(k) { return n.indexOf(k) !== -1; });
    geomType = isPoint ? 'point' : isLine ? 'line' : 'polygon';
  }
  currentGeometryType = geomType;

  var tileUrl = 'http://127.0.0.1:5000/' + dataset + '/{z}/{x}/{y}.mvt';
  var colors  = LAYER_COLORS[idx % LAYER_COLORS.length];
  var srcId   = 'src-' + idx;
  var prefix  = 'ds' + idx + '-';

  map.addSource(srcId, { type: 'vector', tiles: [tileUrl], minzoom: 0, maxzoom: 14 });

  // Add all geometry type layers — MapLibre filters handle mixed-geometry datasets
  map.addLayer({ id: prefix + 'fill', type: 'fill', source: srcId, 'source-layer': sl,
    filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
    paint: { 'fill-color': colors.fill, 'fill-opacity': 0.45 } });

  map.addLayer({ id: prefix + 'outline', type: 'line', source: srcId, 'source-layer': sl,
    filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
    paint: { 'line-color': colors.outline, 'line-width': 1 } });

  map.addLayer({ id: prefix + 'points', type: 'circle', source: srcId, 'source-layer': sl,
    filter: ['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']],
    paint: { 'circle-radius': 5, 'circle-color': colors.circle, 'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(255,255,255,0.6)' } });

  map.addLayer({ id: prefix + 'lines', type: 'line', source: srcId, 'source-layer': sl,
    filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'MultiLineString']],
    paint: { 'line-color': colors.line, 'line-width': 2 } });

  var addedLayers = [prefix + 'fill', prefix + 'outline', prefix + 'points', prefix + 'lines'];

  addedLayers.forEach(function(lid) {
    map.on('mouseenter', lid, function() { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', lid, function() { map.getCanvas().style.cursor = ''; });
  });

  activeLayers[dataset] = {
    srcId: srcId, prefix: prefix, layers: addedLayers,
    geomType: geomType, sourceLayer: sl, colorIdx: idx, colors: colors
  };

  renderDatasetList(searchInput.value);
  updateDetailPanel();
  populateAttributeSelect();
  populateLabelSelect();
  updateLayersPanel();
  updateUrl();
}

function removeDatasetLayer(dataset) {
  if (!map || !activeLayers[dataset]) return;
  var info = activeLayers[dataset];
  info.layers.forEach(function(lid) { try { map.removeLayer(lid); } catch(e) {} });
  try { map.removeSource(info.srcId); } catch(e) {}
  delete activeLayers[dataset];

  if (currentDataset === dataset) {
    var remaining = Object.keys(activeLayers);
    currentDataset = remaining.length ? remaining[remaining.length - 1] : null;
    if (currentDataset) {
      var inf = activeLayers[currentDataset];
      currentGeometryType = inf.geomType;
    } else {
      currentGeometryType = null;
      currentAttributes   = [];
      resetLegend();
      _detachLabelRenderer();
      document.getElementById('stylePanel').classList.remove('visible');
    }
  } else if (!Object.keys(activeLayers).length) {
    // Removed a non-current dataset and now nothing is left
    resetLegend();
    _detachLabelRenderer();
    document.getElementById('stylePanel').classList.remove('visible');
  }

  renderDatasetList(searchInput.value);
  updateDetailPanel();
  populateAttributeSelect();
  populateLabelSelect();
  updateLayersPanel();
  updateUrl();
}

function clearFilters() {
  Object.keys(activeLayers).forEach(removeDatasetLayer);
  currentDataset    = null;
  currentAttributes = [];
  searchInput.value = '';
  window.history.replaceState({}, '', window.location.pathname + window.location.hash);
  renderDatasetList();
  updateDetailPanel();
  populateAttributeSelect();
  populateLabelSelect();
  resetLegend();
  updateLayersPanel();
}

// ── LAYERS PANEL ──────────────────────────────────────────────────────────────
function updateLayersPanel() {
  var panel = document.getElementById('layersPanel');
  var keys  = Object.keys(activeLayers);
  if (!keys.length) {
    panel.innerHTML = '<div class="layers-empty">No layers loaded</div>';
    return;
  }
  panel.innerHTML = keys.map(function(ds) {
    var info     = activeLayers[ds];
    var isActive = ds === currentDataset;
    var opacity  = info.opacity !== undefined ? info.opacity * 100 : 50;
    var eyeIcon  = info.hidden ? '&#128683;' : '&#128065;';
    var eyeTitle = info.hidden ? 'Show layer' : 'Hide layer';
    var eyeStyle = info.hidden ? 'opacity:0.35;text-decoration:line-through;' : '';
    return (
      '<div class="layer-row' + (isActive ? ' layer-active' : '') + '"' +
      ' onclick="selectActiveDataset(\'' + ds + '\')" title="Click to select for styling">' +
        '<span class="layer-swatch" style="background:' + info.colors.fill + '"></span>' +
        '<span class="layer-name">' + ds + '</span>' +
        '<span class="layer-vis" style="' + eyeStyle + '" onclick="event.stopPropagation();toggleLayerVisibility(\'' + ds + '\')" title="' + eyeTitle + '">' + eyeIcon + '</span>' +
        '<span class="layer-opacity-wrap">' +
          '<input type="range" class="layer-opacity" min="0" max="100" value="' + opacity + '"' +
          ' oninput="event.stopPropagation();setLayerOpacity(\'' + ds + '\',this.value/100)">' +
        '</span>' +
        '<span class="layer-del" onclick="event.stopPropagation();removeDatasetLayer(\'' + ds + '\')">&#215;</span>' +
      '</div>'
    );
  }).join('');
}

function selectActiveDataset(dataset) {
  currentDataset = dataset;
  var info = activeLayers[dataset];
  if (info) {
    currentGeometryType = info.geomType;
    loadAttributes(dataset).then(function() {
      populateAttributeSelect();
      populateLabelSelect();
      updateLayersPanel();
      updateDetailPanel();
    });
  }
}

function toggleLayerVisibility(dataset) {
  if (!map || !activeLayers[dataset]) return;
  var info = activeLayers[dataset];
  info.hidden = !info.hidden;
  var vis = info.hidden ? 'none' : 'visible';
  info.layers.forEach(function(lid) {
    try { map.setLayoutProperty(lid, 'visibility', vis); } catch(e) {}
  });
  updateLayersPanel();
}

function setLayerOpacity(dataset, val) {
  if (!map || !activeLayers[dataset]) return;
  var info = activeLayers[dataset];
  info.opacity = val;
  info.layers.forEach(function(lid) {
    try {
      var layer = map.getLayer(lid);
      if (!layer) return;
      if (layer.type === 'fill')   map.setPaintProperty(lid, 'fill-opacity',   val * 0.9);
      if (layer.type === 'circle') map.setPaintProperty(lid, 'circle-opacity',  val);
      if (layer.type === 'line')   map.setPaintProperty(lid, 'line-opacity',    val);
    } catch(e) {}
  });
}

// ── DETAIL PANEL ──────────────────────────────────────────────────────────────
function updateDetailPanel() {
  var has = !!currentDataset;
  downloadAllBtn.disabled = downloadViewBtn.disabled = !has;

  if (!has) {
    document.getElementById('detailTitle').textContent = 'Select a dataset';
    ['detailSize', 'detailRecords', 'detailGeometry'].forEach(function(id) {
      document.getElementById(id).textContent = '-';
    });
    document.getElementById('detailDesc').style.display = 'none';
    return;
  }

  var ds = currentDataset;
  document.getElementById('detailTitle').textContent = ds;
  ['detailSize', 'detailRecords'].forEach(function(id) {
    document.getElementById(id).textContent = '…';
  });

  var knownGeom = activeLayers[ds] && activeLayers[ds].geomType;
  document.getElementById('detailGeometry').textContent = knownGeom
    ? knownGeom.toUpperCase()
    : guessGeometryType(ds);
  document.getElementById('detailDesc').style.display = 'none';

  // 1. Hardcoded metadata (instant)
  var known = datasetMetadata[ds];
  if (known) {
    document.getElementById('detailSize').textContent     = known.size     || '-';
    document.getElementById('detailRecords').textContent  = known.records  || '-';
    document.getElementById('detailGeometry').textContent = known.geometry || guessGeometryType(ds);
    if (known.desc) {
      var d = document.getElementById('detailDesc');
      d.textContent    = known.desc;
      d.style.display  = 'block';
    }
  }

  // 2. /datasets/<dataset>.json → size
  fetch('/datasets/' + encodeURIComponent(ds) + '.json')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(meta) {
      if (!meta || currentDataset !== ds) return;
      if (meta.size !== undefined) {
        document.getElementById('detailSize').textContent = fmtBytes(meta.size);
      }
    })
    .catch(function() {});

  // 3. /api/datasets/<dataset>/stats → records, geometry, attributes
  fetch('/api/datasets/' + encodeURIComponent(ds) + '/stats')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(stats) {
      if (!stats || currentDataset !== ds) return;

      if (stats.feature_count !== undefined) {
        document.getElementById('detailRecords').textContent = stats.feature_count.toLocaleString();
      } else if (stats.attributes && stats.attributes.length) {
        var maxCount = 0;
        stats.attributes.forEach(function(a) {
          if (a.stats && a.stats.non_null_count > maxCount) maxCount = a.stats.non_null_count;
        });
        if (maxCount > 0) document.getElementById('detailRecords').textContent = maxCount.toLocaleString();
      }

      var geomSrc = activeLayers[ds] && activeLayers[ds].geomType;
      if (geomSrc) {
        document.getElementById('detailGeometry').textContent = geomSrc.toUpperCase();
      } else if (stats.geometry_type) {
        document.getElementById('detailGeometry').textContent = stats.geometry_type;
      }

      if (stats.attributes && stats.attributes.length && !known) {
        var names  = stats.attributes.slice(0, 6).map(function(a) { return a.name; }).join(', ');
        var extra  = stats.attributes.length > 6 ? ' +' + (stats.attributes.length - 6) + ' more' : '';
        var descEl = document.getElementById('detailDesc');
        descEl.textContent   = stats.attributes.length + ' attributes: ' + names + extra;
        descEl.style.display = 'block';
      }
    })
    .catch(function() {});
}

function fmtBytes(b) {
  if (!b)       return '-';
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
  return b + ' B';
}

function guessGeometryType(name) {
  if (!name) return 'GEOMETRY';
  var n = name.toUpperCase();
  if (n.indexOf('COUNTY') !== -1 || n.indexOf('PLACE') !== -1) return 'POLYGON';
  if (n.indexOf('POINT')  !== -1)                              return 'POINT';
  if (n.indexOf('ROAD')   !== -1 || n.indexOf('EDGE')  !== -1) return 'LINESTRING';
  return 'GEOMETRY';
}

// ── DOWNLOAD ──────────────────────────────────────────────────────────────────
function downloadDataset(mode) {
  if (!currentDataset) return;
  var fmtEl = document.getElementById('downloadFormat');
  var fmt   = fmtEl ? fmtEl.value : 'geojson';
  var ext   = fmt === 'csv' ? '.csv' : fmt === 'shp' ? '.zip' : '.geojson';
  var enc   = encodeURIComponent(currentDataset);
  var url;

  if (mode === 'viewport' && map) {
    var b   = map.getBounds();
    var mbr = b.getWest().toFixed(6) + ',' + b.getSouth().toFixed(6) + ',' +
              b.getEast().toFixed(6) + ',' + b.getNorth().toFixed(6);
    url = '/datasets/' + enc + '/features.' + fmt + '?mbr=' + mbr;
  } else {
    url = '/datasets/' + enc + '/features.' + fmt;
  }

  var btn  = mode === 'viewport' ? downloadViewBtn : downloadAllBtn;
  var orig = btn.textContent;
  btn.disabled   = true;
  btn.textContent = '⏳ Preparing...';

  var a = document.createElement('a');
  a.href     = url;
  a.download = currentDataset.replace(/\//g, '_') + (mode === 'viewport' ? '_view' : '_full') + ext;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(function() { btn.textContent = orig; btn.disabled = false; }, 2500);
}

// ── MAP INIT ──────────────────────────────────────────────────────────────────
async function initMap(initialCenter, initialZoom) {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  _detachLabelRenderer();
  if (map) { map.remove(); map = null; }
  activeLayers = {};

  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: { basemap: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256 } },
      layers:  [{ id: 'basemap', type: 'raster', source: 'basemap' }]
    },
    center: initialCenter || [-98, 39],
    zoom:   initialZoom   || 4
  });

  map.on('load', function() {
    attachClickHandlers();
    updateLayersPanel();
  });
  map.on('moveend', scheduleUrlUpdate);
  map.on('zoomend', scheduleUrlUpdate);
}

function attachClickHandlers() {
  if (!map) return;
  map.on('click', function(e) {
    var allLayerIds = [];
    Object.values(activeLayers).forEach(function(info) { allLayerIds = allLayerIds.concat(info.layers); });
    if (!allLayerIds.length) return;

    var avail = allLayerIds.filter(function(l) {
      try { return map.getLayer(l); } catch(x) { return false; }
    });
    var feats = map.queryRenderedFeatures(e.point, { layers: avail });
    if (!feats || !feats.length) return;

    var props = feats[0].properties;
    if (!props || !Object.keys(props).length) return;

    var rows = Object.entries(props).filter(function(kv) {
      return kv[0] !== 'geometry' && kv[0].indexOf('_') !== 0;
    });
    if (!rows.length) return;

    var geomType    = feats[0].geometry ? feats[0].geometry.type : '';
    var headerLabel = geomType ? '📍 ' + geomType : '📍 Feature Properties';
    var countLabel  = rows.length + ' attribute' + (rows.length !== 1 ? 's' : '');

    var body = rows.map(function(kv) {
      var v  = kv[1];
      var vs = v === null || v === undefined
        ? '<em class="popup-null">null</em>'
        : typeof v === 'number'
          ? '<span class="popup-num">' + v.toLocaleString() + '</span>'
          : String(v);
      return '<div class="popup-row">' +
               '<span class="popup-key" title="' + kv[0] + '">' + kv[0] + '</span>' +
               '<span class="popup-val">' + vs + '</span>' +
             '</div>';
    }).join('');

    var html = '<div class="popup-header">' +
                 '<span>' + headerLabel + '</span>' +
                 '<span class="popup-count">' + countLabel + '</span>' +
               '</div>' +
               '<div class="popup-body">' + body + '</div>';

    if (activePopup) activePopup.remove();
    activePopup = new maplibregl.Popup({ maxWidth: '360px', closeButton: true })
      .setLngLat(e.lngLat)
      .setHTML(html)
      .addTo(map);
  });
}

// ── STYLE PANEL ───────────────────────────────────────────────────────────────
function toggleStylePanel() {
  var panel = document.getElementById('stylePanel');
  if (panel.classList.contains('visible')) {
    panel.classList.remove('visible');
    return;
  }
  if (!currentDataset) { alert('Select a dataset first'); return; }
  panel.classList.add('visible');
}

function populateAttributeSelect() {
  var el = document.getElementById('attributeSelect');
  if (!el) return;
  el.innerHTML = '<option value="">Default style</option>';
  if (!currentDataset) return;
  getAttributeNames().forEach(function(name) {
    var o    = document.createElement('option');
    o.value  = name;
    var attr = currentAttributes.find(function(a) { return a.name === name; });
    var cnt  = attr && attr.stats && attr.stats.non_null_count;
    o.textContent = cnt ? name + ' (' + cnt.toLocaleString() + ' vals)' : name;
    el.appendChild(o);
  });
}

function populateLabelSelect() {
  var el = document.getElementById('labelSelect');
  if (!el) return;
  el.innerHTML = '<option value="">No labels</option>';
  if (!currentDataset) return;
  getAttributeNames().forEach(function(name) {
    var o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    el.appendChild(o);
  });
}

// ── STYLE APPLICATION ─────────────────────────────────────────────────────────
function applyStyle(attrArg, vizArg, schemeArg) {
  if (!map || !currentDataset || !activeLayers[currentDataset]) return;
  var attr   = attrArg   !== undefined ? attrArg   : document.getElementById('attributeSelect').value;
  var viz    = vizArg    !== undefined ? vizArg    : document.getElementById('vizType').value;
  var scheme = schemeArg !== undefined ? schemeArg : document.getElementById('colorScheme').value;
  var lAttr  = document.getElementById('labelSelect').value;
  var lSize  = document.getElementById('labelSize').value  || '12';
  var lColor = document.getElementById('labelColor').value || '#202124';

  if (!attr) {
    resetToDefaultStyle();
    resetLegend();
  } else {
    var stats;
    if (viz === 'categorical') {
      stats = statsFromFeatures(attr, true) || computeStats(attr, viz);
    } else {
      stats = computeStats(attr, viz);
      if (!stats) stats = statsFromFeatures(attr, false);
    }
    if (!stats) {
      resetToDefaultStyle();
      resetLegend();
    } else {
      try { _dispatchStyle(attr, viz, stats, scheme); }
      catch(e) { console.error(e); }
    }
  }
  applyLabels(lAttr, lSize, lColor);
}

function _dispatchStyle(attr, viz, stats, scheme) {
  if (!activeLayers[currentDataset]) return;
  var info = activeLayers[currentDataset];
  // Always reset legend before applying new style
  hideLegend();
  _applyPolygonStyle(attr, viz, stats, scheme, info.prefix);
  _applyPointStyle(attr, viz, stats, scheme, info.prefix);
  _applyLineStyle(attr, viz, stats, scheme, info.prefix);
  // Update legend once, after all geometry types have been processed
  if (viz === 'categorical') {
    updateLegendCategorical(attr, stats, scheme);
  } else if (viz === 'size') {
    updateLegendSize(attr, stats, info);
  } else {
    updateLegendChoropleth(attr, stats, scheme);
  }
}

function _applyPolygonStyle(attr, viz, stats, scheme, prefix) {
  if (!map.getLayer(prefix + 'fill')) return;
  if (viz === 'choropleth') {
    var e = buildChoroplethExpr(attr, stats, scheme);
    if (!e) return;
    map.setPaintProperty(prefix + 'fill', 'fill-color',   e);
    map.setPaintProperty(prefix + 'fill', 'fill-opacity', 0.8);
    if (map.getLayer(prefix + 'outline')) {
      map.setPaintProperty(prefix + 'outline', 'line-color', e);
      map.setPaintProperty(prefix + 'outline', 'line-width', 1);
    }
  } else if (viz === 'categorical') {
    var e = buildCategoricalExpr(attr, stats, scheme);
    if (!e) return;
    map.setPaintProperty(prefix + 'fill', 'fill-color',   e);
    map.setPaintProperty(prefix + 'fill', 'fill-opacity', 0.8);
    if (map.getLayer(prefix + 'outline')) {
      map.setPaintProperty(prefix + 'outline', 'line-color', e);
    }
  } else { // size — keep solid color, vary opacity only
    if (!isFinite(stats.min) || !isFinite(stats.max) || stats.min === stats.max) return;
    var info = activeLayers[currentDataset];
    map.setPaintProperty(prefix + 'fill', 'fill-color', info.colors.fill);
    map.setPaintProperty(prefix + 'fill', 'fill-opacity',
      ['interpolate', ['linear'], ['to-number', ['get', attr]], stats.min, 0.15, stats.max, 0.9]);
    if (map.getLayer(prefix + 'outline')) {
      map.setPaintProperty(prefix + 'outline', 'line-color', info.colors.outline);
    }
  }
}

function _applyPointStyle(attr, viz, stats, scheme, prefix) {
  if (!map.getLayer(prefix + 'points')) return;
  if (viz === 'size') {
    var e = buildSizeExpr(attr, stats, 5);
    if (!e) return;
    // Keep solid color, only vary size
    var info = activeLayers[currentDataset];
    map.setPaintProperty(prefix + 'points', 'circle-color', info.colors.circle);
    map.setPaintProperty(prefix + 'points', 'circle-radius', e);
  } else {
    var isCat = viz === 'categorical';
    var e     = isCat ? buildCategoricalExpr(attr, stats, scheme) : buildChoroplethExpr(attr, stats, scheme);
    if (!e) return;
    map.setPaintProperty(prefix + 'points', 'circle-color', e);
  }
}

function _applyLineStyle(attr, viz, stats, scheme, prefix) {
  if (!map.getLayer(prefix + 'lines')) return;
  if (viz === 'size') {
    var e = buildSizeExpr(attr, stats, 3);
    if (!e) return;
    // Keep solid color, only vary width
    var info = activeLayers[currentDataset];
    map.setPaintProperty(prefix + 'lines', 'line-color', info.colors.line);
    map.setPaintProperty(prefix + 'lines', 'line-width', e);
  } else {
    var isCat = viz === 'categorical';
    var e     = isCat ? buildCategoricalExpr(attr, stats, scheme) : buildChoroplethExpr(attr, stats, scheme);
    if (!e) return;
    map.setPaintProperty(prefix + 'lines', 'line-color', e);
  }
}

function resetToDefaultStyle() {
  if (!map || !currentDataset || !activeLayers[currentDataset]) return;
  var info = activeLayers[currentDataset];
  var c = info.colors, p = info.prefix;
  try {
    if (map.getLayer(p + 'fill'))    { map.setPaintProperty(p + 'fill',    'fill-color',    c.fill);    map.setPaintProperty(p + 'fill',    'fill-opacity',   0.45); }
    if (map.getLayer(p + 'outline')) { map.setPaintProperty(p + 'outline', 'line-color',    c.outline); map.setPaintProperty(p + 'outline', 'line-width',      1); }
    if (map.getLayer(p + 'points'))  { map.setPaintProperty(p + 'points',  'circle-color',  c.circle);  map.setPaintProperty(p + 'points',  'circle-radius',   5); }
    if (map.getLayer(p + 'lines'))   { map.setPaintProperty(p + 'lines',   'line-color',    c.line);    map.setPaintProperty(p + 'lines',   'line-width',      2); }
  } catch(e) {}
}

function resetLegend() { hideLegend(); }

// ── STATS ─────────────────────────────────────────────────────────────────────
function computeStats(attrName, viz) {
  var forceCat = viz === 'categorical', found = null;
  for (var i = 0; i < currentAttributes.length; i++) {
    if (currentAttributes[i].name === attrName) { found = currentAttributes[i]; break; }
  }
  if (found && found.stats) {
    var s    = found.stats;
    var topK = s.top_k || [];
    if (forceCat) return { min: null, max: null, categories: topK.map(function(t) { return String(t.value); }) };
    var numVals = topK.map(function(t) { return parseFloat(t.value); }).filter(function(v) { return !isNaN(v); });
    if (numVals.length && numVals.length >= topK.length * 0.5) {
      var mn = Math.min.apply(null, numVals), mx = Math.max.apply(null, numVals);
      if (mn === mx) { mn = mn * 0.9 || 0; mx = mx * 1.1 || 1; }
      return { min: mn, max: mx, categories: [] };
    }
    return { min: null, max: null, categories: topK.map(function(t) { return String(t.value); }) };
  }
  return statsFromFeatures(attrName, forceCat);
}

function statsFromFeatures(attrName, forceCat) {
  if (!map) return null;
  try {
    var allLayerIds = [];
    Object.values(activeLayers).forEach(function(info) { allLayerIds = allLayerIds.concat(info.layers); });
    var avail = allLayerIds.filter(function(l) {
      try { return map.getLayer(l); } catch(e) { return false; }
    });
    if (!avail.length) return null;

    var feats = map.queryRenderedFeatures({ layers: avail });
    if (!feats || !feats.length) return null;

    var nums = [], cats = [], seen = {};
    feats.forEach(function(f) {
      var v = f.properties && f.properties[attrName];
      if (v === null || v === undefined || v === '') return;
      var s = String(v);
      if (!seen[s]) { seen[s] = true; cats.push(s); }
      var n = parseFloat(v);
      if (!isNaN(n)) nums.push(n);
    });
    if (!cats.length) return null;

    var isNum = nums.length >= cats.length * 0.5;
    if (!isNum || forceCat) return { min: null, max: null, categories: cats };

    var mn = Math.min.apply(null, nums), mx = Math.max.apply(null, nums);
    if (mn === mx) { mn = mn * 0.9 || 0; mx = mx * 1.1 || 1; }
    return { min: mn, max: mx, categories: [] };
  } catch(e) { return null; }
}

// ── COLOR RAMPS ───────────────────────────────────────────────────────────────
var COLOR_RAMPS = {
  blues:    ['#f7fbff','#deebf7','#c6dbef','#9ecae1','#6baed6','#4292c6','#2171b5','#08519c','#08306b'],
  reds:     ['#fff5f0','#fee0d2','#fcbba1','#fc9272','#fb6a4a','#ef3b2c','#cb181d','#a50f15','#67000d'],
  greens:   ['#f7fcf5','#e5f5e0','#c7e9c0','#a1d99b','#74c476','#41ab5d','#238b45','#006d2c','#00441b'],
  oranges:  ['#fff5eb','#fee6ce','#fdd0a2','#fdae6b','#fd8d3c','#f16913','#d94801','#a63603','#7f2704'],
  purples:  ['#fcfbfd','#efedf5','#dadaeb','#bcbddc','#9e9ac8','#807dba','#6a51a3','#54278f','#3f007d'],
  greys:    ['#ffffff','#f0f0f0','#d9d9d9','#bdbdbd','#969696','#737373','#525252','#252525','#000000'],
  rdbu:     ['#b2182b','#d6604d','#f4a582','#fddbc7','#f7f7f7','#d1e5f0','#92c5de','#4393c3','#2166ac'],
  rdylgn:   ['#d73027','#f46d43','#fdae61','#fee08b','#ffffbf','#d9ef8b','#a6d96a','#66bd63','#1a9850'],
  spectral: ['#9e0142','#d53e4f','#f46d43','#fdae61','#fee08b','#e6f598','#abdda4','#66c2a5','#3288bd'],
  viridis:  ['#440154','#482878','#3e4989','#31688e','#26828e','#1f9e89','#35b779','#6ece58','#fde725'],
  magma:    ['#000004','#180f3d','#440f76','#721f81','#9f2f7f','#cd4071','#f1605d','#fd9668','#fcfdbf'],
  plasma:   ['#0d0887','#46039f','#7201a8','#9c179e','#bd3786','#d8576b','#ed7953','#fb9f3a','#f0f921'],
  inferno:  ['#000004','#1b0c41','#4a0c4e','#781c6d','#a52c60','#cf4446','#ed6925','#fb9b06','#fcffa4'],
  rainbow:  ['#6e40aa','#4069cf','#1fa5b8','#4bcc5c','#abe51c','#f5ce0b','#f66000','#d93c11','#b63679'],
  tableau:  ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7','#9c755f'],
  bold:     ['#e41a1c','#377eb8','#4daf4a','#984ea3','#ff7f00','#a65628','#f781bf','#999999','#ffff33'],
  safe:     ['#88ccee','#44aa99','#117733','#332288','#ddcc77','#999933','#cc6677','#882255','#aa4499']
};

function generateHslPalette(n) {
  var colors = [], golden = 137.508;
  for (var i = 0; i < n; i++) {
    var h = (i * golden) % 360;
    var s = 55 + (i % 3) * 12;
    var l = 42 + (i % 4) * 8;
    colors.push('hsl(' + h.toFixed(1) + ',' + s + '%,' + l + '%)');
  }
  return colors;
}

function getColorRamp(scheme, n) {
  var ramp = COLOR_RAMPS[scheme] || COLOR_RAMPS.blues;
  if (!n || n <= ramp.length) return ramp;
  return generateHslPalette(n);
}

function getCategoryColors(scheme, n) {
  var base = COLOR_RAMPS[scheme] || COLOR_RAMPS.blues;
  if (n <= base.length) return base.slice(0, n);
  var hsl    = generateHslPalette(n);
  var result = [];
  for (var i = 0; i < n; i++) {
    result.push(i < base.length ? base[i] : hsl[i]);
  }
  return result;
}

// ── EXPRESSION BUILDERS ───────────────────────────────────────────────────────
function buildChoroplethExpr(attr, stats, scheme) {
  var c = getColorRamp(scheme), mn = stats.min, mx = stats.max;
  if (!isFinite(mn) || !isFinite(mx) || mn === mx) return null;
  var s = (mx - mn) / 8;
  return ['interpolate', ['linear'], ['to-number', ['get', attr]],
    mn,       c[0], mn + s,     c[1], mn + 2*s, c[2], mn + 3*s, c[3], mn + 4*s, c[4],
    mn + 5*s, c[5], mn + 6*s,   c[6], mn + 7*s, c[7], mx,       c[8]];
}

function buildSizeExpr(attr, stats, base) {
  var mn = stats.min, mx = stats.max;
  if (!isFinite(mn) || !isFinite(mx) || mn === mx) return null;
  return ['interpolate', ['linear'], ['to-number', ['get', attr]], mn, base * 0.5, mx, base * 2.5];
}

function buildCategoricalExpr(attr, stats, scheme) {
  var cats = stats.categories || [];
  if (!cats.length) return null;
  var c = getCategoryColors(scheme, cats.length);
  var e = ['match', ['get', attr]];
  cats.forEach(function(x, i) { e.push(x, c[i]); });
  e.push('#aaaaaa');
  return e;
}

// ── LEGEND ────────────────────────────────────────────────────────────────────
function hideLegend() {
  if (!legendEl) return;
  legendEl.classList.remove('visible');
  legendContentEl.innerHTML = '';
  legendEl.removeAttribute('data-mode');
}

function updateLegendSize(attr, stats, layerInfo) {
  if (!legendEl || !legendContentEl) return;
  var mn  = isFinite(stats.min) ? stats.min : 0;
  var mx  = isFinite(stats.max) ? stats.max : 1;
  var col = (layerInfo && layerInfo.colors) ? layerInfo.colors.fill : '#4285f4';
  legendContentEl.innerHTML =
    '<div style="display:flex;flex-direction:column;gap:8px;padding:6px 0;">' +
      '<div style="display:flex;align-items:center;gap:10px;">' +
        '<svg width="26" height="26" style="flex-shrink:0"><circle cx="13" cy="13" r="11" fill="' + col + '" opacity="0.8"/></svg>' +
        '<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-secondary);">' + fmtNum(mx) + '</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:10px;">' +
        '<svg width="26" height="26" style="flex-shrink:0"><circle cx="13" cy="13" r="6.5" fill="' + col + '" opacity="0.8"/></svg>' +
        '<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-secondary);">' + fmtNum((mn + mx) / 2) + '</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:10px;">' +
        '<svg width="26" height="26" style="flex-shrink:0"><circle cx="13" cy="13" r="3" fill="' + col + '" opacity="0.8"/></svg>' +
        '<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-secondary);">' + fmtNum(mn) + '</span>' +
      '</div>' +
    '</div>';
  legendEl.setAttribute('data-mode', 'choropleth');
  legendEl.classList.add('visible');
  legendEl.querySelector('.legend-title').textContent = attr + ' (size)';
}

function updateLegendChoropleth(attr, stats, scheme) {
  if (!legendEl || !legendContentEl) return;
  var c        = getColorRamp(scheme);
  var mn       = stats.min, mx = stats.max;
  var gradient = 'linear-gradient(to bottom, ' + c.slice().reverse().join(', ') + ')';
  legendContentEl.innerHTML =
    '<div class="legend-gradient-wrap">' +
      '<div class="legend-gradient-bar" style="background:' + gradient + '"></div>' +
      '<div class="legend-gradient-labels">' +
        '<span>' + fmtNum(mx) + '</span>' +
        '<span>' + fmtNum((mn + mx) / 2) + '</span>' +
        '<span>' + fmtNum(mn) + '</span>' +
      '</div>' +
    '</div>';
  legendEl.setAttribute('data-mode', 'choropleth');
  legendEl.classList.add('visible');
  legendEl.querySelector('.legend-title').textContent = attr;
}

function updateLegendCategorical(attr, stats, scheme) {
  if (!legendEl || !legendContentEl) return;
  var cats = stats.categories || [];
  var c    = getCategoryColors(scheme, cats.length);
  legendContentEl.innerHTML = '';
  cats.forEach(function(x, i) {
    var row = document.createElement('div');
    row.className = 'legend-item';
    row.innerHTML =
      '<span class="legend-swatch" style="background:' + c[i] + '"></span>' +
      '<span class="legend-cat-label" title="' + x + '">' + x + '</span>';
    legendContentEl.appendChild(row);
  });
  legendEl.setAttribute('data-mode', 'categorical');
  legendEl.classList.add('visible');
  legendEl.querySelector('.legend-title').textContent = attr + ' — ' + cats.length + ' values';
}

function fmtNum(v) {
  if (!isFinite(v))        return '-';
  if (Math.abs(v) >= 1e6)  return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3)  return (v / 1e3).toFixed(1) + 'k';
  return v % 1 === 0 ? v : v.toFixed(2);
}

// ── LABEL RENDERER ────────────────────────────────────────────────────────────
function _canvas()      { return document.getElementById('label-canvas'); }
function _ctx()         { var c = _canvas(); return c ? c.getContext('2d') : null; }

function _resizeCanvas() {
  var c = _canvas(); if (!c) return;
  var m = document.getElementById('map');
  c.width = m.offsetWidth; c.height = m.offsetHeight;
}

function _clearCanvas() {
  var c = _canvas(), ctx = _ctx();
  if (ctx && c) ctx.clearRect(0, 0, c.width, c.height);
}

function _renderLabels() {
  _labelFrame = null;
  var c = _canvas(), ctx = _ctx();
  if (!ctx || !c || !map || !_labelAttr) { _clearCanvas(); return; }

  var mzEl = document.getElementById('labelMinZoom');
  var mz   = mzEl ? parseFloat(mzEl.value) : 0;
  if (map.getZoom() < mz) { _clearCanvas(); return; }

  _resizeCanvas(); _clearCanvas();
  var W = c.width, H = c.height;

  var allLayerIds = [];
  Object.values(activeLayers).forEach(function(info) { allLayerIds = allLayerIds.concat(info.layers); });
  var avail = allLayerIds.filter(function(l) { try { return map.getLayer(l); } catch(e) { return false; } });
  if (!avail.length) return;

  var feats;
  try { feats = map.queryRenderedFeatures({ layers: avail }); } catch(e) { return; }
  if (!feats || !feats.length) return;

  var zs     = Math.max(0.7, Math.min(2.0, 0.5 + map.getZoom() / 12));
  var fs     = Math.round(_labelSize * zs);
  var bgEl   = document.getElementById('labelBg');
  var bgMode = bgEl ? bgEl.value : 'white';

  ctx.font          = '600 ' + fs + 'px system-ui,-apple-system,sans-serif';
  ctx.textAlign     = 'center';
  ctx.textBaseline  = 'middle';

  var seen = {}, candidates = [];
  for (var i = 0; i < feats.length; i++) {
    var f   = feats[i];
    var fid = f.id != null ? String(f.id) : JSON.stringify(f.properties).slice(0, 60);
    if (seen[fid]) continue;
    seen[fid] = true;

    var val = f.properties && f.properties[_labelAttr];
    if (val === null || val === undefined || val === '') continue;

    var text = String(val), px, py;
    try {
      var g = f.geometry, coord;
      if (g.type === 'Point') {
        coord = g.coordinates;
      } else if (g.type === 'Polygon') {
        var ring = g.coordinates[0], sx = 0, sy = 0;
        for (var j = 0; j < ring.length; j++) { sx += ring[j][0]; sy += ring[j][1]; }
        coord = [sx / ring.length, sy / ring.length];
      } else if (g.type === 'MultiPolygon') {
        var best = null, blen = 0;
        for (var p = 0; p < g.coordinates.length; p++) {
          if (g.coordinates[p][0].length > blen) { blen = g.coordinates[p][0].length; best = g.coordinates[p][0]; }
        }
        if (!best) continue;
        var sx = 0, sy = 0;
        for (var j = 0; j < best.length; j++) { sx += best[j][0]; sy += best[j][1]; }
        coord = [sx / best.length, sy / best.length];
      } else if (g.type === 'LineString') {
        coord = g.coordinates[Math.floor(g.coordinates.length / 2)];
      } else if (g.type === 'MultiLineString') {
        var ln = g.coordinates[0];
        coord = ln[Math.floor(ln.length / 2)];
      } else { continue; }

      var pt = map.project(coord); px = pt.x; py = pt.y;
    } catch(e) { continue; }

    if (px < 0 || py < 0 || px > W || py > H) continue;
    var tw = ctx.measureText(text).width;
    candidates.push({ text: text, px: px, py: py, tw: tw, th: fs });
  }

  var PAD = 4, placed = [];
  function overlaps(bx, by, bw, bh) {
    var x1 = bx - bw/2 - PAD, x2 = bx + bw/2 + PAD;
    var y1 = by - bh/2 - PAD, y2 = by + bh/2 + PAD;
    for (var k = 0; k < placed.length; k++) {
      var pl = placed[k];
      if (!(x2 < pl.x1 || x1 > pl.x2 || y2 < pl.y1 || y1 > pl.y2)) return true;
    }
    return false;
  }

  for (var i = 0; i < candidates.length; i++) {
    var cand = candidates[i];
    var tx = cand.px, ty = cand.py, tw = cand.tw, th = cand.th, text = cand.text;
    if (overlaps(tx, ty, tw, th)) continue;
    placed.push({ x1: tx - tw/2 - PAD, x2: tx + tw/2 + PAD, y1: ty - th/2 - PAD, y2: ty + th/2 + PAD });

    if (bgMode !== 'none') {
      var bx = tx - tw/2 - 4, by = ty - th/2 - 3, bw = tw + 8, bh = th + 6, r = bh / 2;
      var fill = bgMode === 'white' ? 'rgba(255,255,255,0.88)'
               : bgMode === 'dark'  ? 'rgba(20,20,20,0.78)'
               : _labelColor + '30';
      ctx.beginPath();
      ctx.moveTo(bx + r, by); ctx.lineTo(bx + bw - r, by); ctx.arcTo(bx + bw, by,    bx + bw, by + bh, r);
      ctx.lineTo(bx + bw, by + bh - r);                     ctx.arcTo(bx + bw, by + bh, bx + bw - r, by + bh, r);
      ctx.lineTo(bx + r,  by + bh);                         ctx.arcTo(bx,      by + bh, bx,    by + bh - r, r);
      ctx.lineTo(bx, by + r);                                ctx.arcTo(bx,      by,      bx + r, by,         r);
      ctx.closePath();
      ctx.fillStyle   = fill;
      ctx.fill();
      ctx.strokeStyle = bgMode === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.07)';
      ctx.lineWidth   = 0.5;
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth   = 3;
      ctx.strokeText(text, tx, ty);
    }
    ctx.fillStyle = bgMode === 'dark' ? '#fff' : _labelColor;
    ctx.fillText(text, tx, ty);
  }
}

function _scheduleRender() {
  if (!_labelFrame) _labelFrame = requestAnimationFrame(_renderLabels);
}

function applyLabels(attr, fontSize, color) {
  _labelAttr  = attr   || null;
  _labelSize  = parseInt(fontSize) || 12;
  _labelColor = color  || '#202124';
  if (!_labelAttr) { _clearCanvas(); return; }
  _scheduleRender();
  if (map && !map._labelsBound) {
    map._labelsBound = true;
    map.on('render',  _scheduleRender);
    map.on('zoomend', _scheduleRender);
  }
}

function _detachLabelRenderer() {
  if (map && map._labelsBound) {
    map.off('render',  _scheduleRender);
    map.off('zoomend', _scheduleRender);
    map._labelsBound = false;
  }
  _clearCanvas();
  _labelAttr = null;
}

// ── GOTO / GEOCODER ───────────────────────────────────────────────────────────
var gotoInput   = document.getElementById('gotoInput');
var gotoBtn     = document.getElementById('gotoBtn');
var gotoResults = document.getElementById('gotoResults');

function _showGeoResults(results) {
  if (!gotoResults) return;
  if (!results || !results.length) {
    gotoResults.innerHTML = '<div class="goto-no-result">No results found</div>';
    gotoResults.classList.add('visible');
    setTimeout(function() { gotoResults.classList.remove('visible'); }, 2000);
    return;
  }
  gotoResults.innerHTML = results.slice(0, 6).map(function(r) {
    var label = r.display_name || (r.lat + ', ' + r.lon);
    if (label.length > 60) label = label.slice(0, 57) + '…';
    return '<div class="goto-result-item" data-lat="' + r.lat + '" data-lon="' + r.lon + '" data-label="' + label + '">' +
             '<span class="goto-result-icon">📍</span>' +
             '<span class="goto-result-text">' + label + '</span>' +
           '</div>';
  }).join('');
  gotoResults.classList.add('visible');
  gotoResults.querySelectorAll('.goto-result-item').forEach(function(el) {
    el.addEventListener('click', function() {
      var lat = parseFloat(el.dataset.lat), lon = parseFloat(el.dataset.lon);
      if (map) map.flyTo({ center: [lon, lat], zoom: 12, speed: 1.4, curve: 1.42 });
      gotoInput.value = el.dataset.label;
      gotoResults.classList.remove('visible');
    });
  });
}

function goToLocation() {
  var input = gotoInput.value.trim();
  if (!input) return;

  // Try lat,lng pattern first
  var m = input.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    var la = parseFloat(m[1]), ln = parseFloat(m[2]);
    if (la >= -90 && la <= 90 && ln >= -180 && ln <= 180) {
      if (map) map.flyTo({ center: [ln, la], zoom: 12, speed: 1.4, curve: 1.42 });
      gotoInput.value = '';
      if (gotoResults) gotoResults.classList.remove('visible');
      return;
    }
  }

  // Nominatim geocode
  gotoBtn.disabled    = true;
  gotoBtn.textContent = '…';
  fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&q=' + encodeURIComponent(input),
    { headers: { 'Accept-Language': 'en' } })
    .then(function(r)    { return r.json(); })
    .then(function(data) {
      gotoBtn.disabled    = false;
      gotoBtn.textContent = 'Go';
      if (data && data.length === 1) {
        if (map) map.flyTo({ center: [parseFloat(data[0].lon), parseFloat(data[0].lat)], zoom: 12, speed: 1.4, curve: 1.42 });
        gotoInput.value = '';
        if (gotoResults) gotoResults.classList.remove('visible');
      } else {
        _showGeoResults(data);
      }
    })
    .catch(function() {
      gotoBtn.disabled    = false;
      gotoBtn.textContent = 'Go';
      if (gotoResults) {
        gotoResults.innerHTML = '<div class="goto-no-result">Search error</div>';
        gotoResults.classList.add('visible');
        setTimeout(function() { gotoResults.classList.remove('visible'); }, 2500);
      }
    });
}

gotoBtn.addEventListener('click', goToLocation);
gotoInput.addEventListener('keypress', function(e) { if (e.key === 'Enter') goToLocation(); });
document.addEventListener('click', function(e) {
  if (!gotoResults) return;
  var box = document.querySelector('.goto-box');
  if (box && !box.contains(e.target)) gotoResults.classList.remove('visible');
});

// ── DARK MODE ─────────────────────────────────────────────────────────────────
var darkToggle = document.getElementById('darkToggle');
if (localStorage.getItem('ucrstar-dark-mode') === 'on') {
  document.body.classList.add('dark');
  darkToggle.innerHTML = '☀️';
}
darkToggle.addEventListener('click', function() {
  var dark = document.body.classList.toggle('dark');
  darkToggle.innerHTML = dark ? '☀️' : '🌙';
  localStorage.setItem('ucrstar-dark-mode', dark ? 'on' : 'off');
});

// ── ZOOM CONTROLS ─────────────────────────────────────────────────────────────
document.getElementById('zoomIn').onclick  = function() { if (map) map.zoomIn(); };
document.getElementById('zoomOut').onclick = function() { if (map) map.zoomOut(); };
searchInput.addEventListener('input', function(e) { renderDatasetList(e.target.value); });

// ── GLOBAL EXPORTS (called from inline HTML handlers) ─────────────────────────
window.selectDataset          = selectDataset;
window.toggleDatasetLayer    = toggleDatasetLayer;
window.removeDatasetLayer    = removeDatasetLayer;
window.selectActiveDataset   = selectActiveDataset;
window.toggleLayerVisibility = toggleLayerVisibility;
window.setLayerOpacity       = setLayerOpacity;
window.clearFilters          = clearFilters;
window.toggleStylePanel      = toggleStylePanel;
window.applyStyle            = applyStyle;
window.downloadDataset       = downloadDataset;

// ── INIT ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', async function() {
  loadDatasets();
  var state          = parseUrlState();
  var urlParams      = new URLSearchParams(window.location.search);
  var datasetsParam  = urlParams.get('datasets');
  var datasetsToLoad = datasetsParam
    ? datasetsParam.split(',').map(decodeURIComponent)
    : (state.dataset ? [state.dataset] : []);
  await initMap(state.center, state.zoom);
  for (var i = 0; i < datasetsToLoad.length; i++) {
    await addDatasetLayer(datasetsToLoad[i]);
  }
});

// ── AI PANEL (Ollama) ─────────────────────────────────────────────────────────
(function() {
  var OLLAMA = 'http://localhost:11434';
  var _hist  = [], _pending = null;

  // Check Ollama status and populate model list
  function ping() {
    fetch(OLLAMA + '/api/tags')
      .then(function(r) {
        var dot = document.getElementById('aiStatusDot');
        if (!dot) return;
        if (r.ok) {
          dot.className = 'ai-status-dot ok';
          dot.title     = 'Ollama en marcha';
          return r.json().then(function(d) {
            if (!d.models || !d.models.length) return;
            var sel = document.getElementById('aiModelSelect');
            if (!sel) return;
            sel.innerHTML = '';
            d.models.forEach(function(m) {
              var o = document.createElement('option');
              o.value = m.name; o.textContent = m.name;
              sel.appendChild(o);
            });
          });
        } else {
          dot.className = 'ai-status-dot err';
          dot.title     = 'Ollama no responde';
        }
      })
      .catch(function() {
        var dot = document.getElementById('aiStatusDot');
        if (dot) { dot.className = 'ai-status-dot err'; dot.title = 'Ollama no encontrado'; }
      });
  }

  window.aiToggle = function() {
    var p = document.getElementById('aiPanel');
    if (!p) return;
    var wasOpen = p.classList.contains('open');
    p.classList.toggle('open');
    if (!wasOpen) ping();
  };

  document.getElementById('aiFab').addEventListener('click', aiToggle);
  document.getElementById('aiIn').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') aiSend();
  });

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function addMsg(type, raw) {
    var box = document.getElementById('aiMsgs');
    if (!box) return null;
    var el  = document.createElement('div');
    el.className = 'ai-msg ' + type;
    var safe = escHtml(raw)
      .replace(/```json([\s\S]*?)```/g, '<pre>$1</pre>')
      .replace(/```([\s\S]*?)```/g,     '<pre>$1</pre>')
      .replace(/\*\*(.*?)\*\*/g,        '<strong>$1</strong>')
      .replace(/`([^`]+)`/g,            '<code>$1</code>')
      .replace(/\n/g,                   '<br>');
    el.innerHTML = safe;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }

  function addMsgHtml(type, html) {
    var box = document.getElementById('aiMsgs');
    if (!box) return null;
    var el  = document.createElement('div');
    el.className = 'ai-msg ' + type;
    el.innerHTML = html;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }

  function getMapContext() {
    if (!currentDataset) return 'No dataset selected.';
    var ctx = 'Dataset: ' + currentDataset + '\n';
    ctx += 'Active layers: ' + Object.keys(activeLayers).join(', ') + '\n';
    ctx += 'Geometry type: ' + (currentGeometryType || 'unknown') + '\n';
    ctx += 'Attributes: ' + getAttributeNames().join(', ') + '\n';
    if (currentAttributes.length) {
      ctx += 'Attribute details:\n';
      currentAttributes.slice(0, 8).forEach(function(a) {
        if (!a.stats) return;
        var top = (a.stats.top_k || []).slice(0, 5).map(function(t) { return String(t.value); }).join(', ');
        ctx += '  - ' + a.name + ': ' + (a.stats.non_null_count || '?') + ' non-null. Sample: ' + top + '\n';
      });
    }
    try {
      var allLids = [];
      Object.values(activeLayers).forEach(function(info) { allLids = allLids.concat(info.layers); });
      var avail = allLids.filter(function(l) { return map && map.getLayer(l); });
      if (avail.length && map) {
        var feats = map.queryRenderedFeatures({ layers: avail });
        if (feats && feats.length) {
          ctx += 'Sample feature: ' + JSON.stringify(feats[0].properties).slice(0, 300) + '\n';
          ctx += 'Visible features: ' + feats.length + '\n';
        }
      }
    } catch(e) {}
    return ctx;
  }

  var SYSTEM = [
    'Eres un asistente experto en visualización GIS para UCR-STAR, un visor de teselas vectoriales con MapLibre GL JS.',
    'Ayuda a los usuarios a explorar conjuntos de datos geoespaciales y diseñar estilos de mapa efectivos.',
    'Responde SIEMPRE en castellano.',
    '',
    'Cuando sugieras un estilo, genera EXACTAMENTE este bloque JSON:',
    '```json',
    '{',
    '  "attribute": "NOMBRE_ATRIBUTO",',
    '  "viz": "choropleth",',
    '  "scheme": "blues",',
    '  "labelAttr": "",',
    '  "labelBg": "white",',
    '  "reason": "una frase explicando el porqué"',
    '}',
    '```',
    'Valores de viz: choropleth | categorical | size',
    'Valores de scheme: blues | reds | greens | oranges | purples | greys | rdbu | rdylgn | spectral | viridis | magma | plasma | inferno | rainbow | tableau | bold | safe',
    'Usa paletas secuenciales (blues/reds/greens) para datos numéricos unidireccionales.',
    'Usa divergentes (rdbu/rdylgn/spectral) cuando haya un punto medio significativo.',
    'Usa perceptuales (viridis/magma/plasma) para datos científicos.',
    'Usa categóricas (tableau/bold/safe) para categorías discretas.',
    'Respuestas concisas, 3-4 frases. Incluye el JSON solo cuando se necesite un estilo.'
  ].join('\n');

  var QUICK = {
    describe: '¿Qué tipo de datos contiene este conjunto de datos? Descríbelo brevemente.',
    suggest:  'Sugiere la mejor visualización para este conjunto de datos. Incluye el bloque JSON con el estilo.',
    best:     '¿Qué atributo produce el mapa de coropletas más informativo? Incluye el JSON.',
    insight:  'Analiza los elementos visibles. ¿Qué revelan los valores de los atributos?',
    anomaly:  '¿Hay valores atípicos o anomalías entre los elementos visibles?'
  };

  window.aiQuick = function(type) {
    if (!currentDataset) { addMsgHtml('info', 'Selecciona un dataset primero.'); return; }
    var prompt = QUICK[type] || type;
    addMsg('user', prompt);
    callOllama(prompt);
  };

  window.aiSend = function() {
    var inp = document.getElementById('aiIn');
    if (!inp) return;
    var msg = inp.value.trim();
    if (!msg) return;
    inp.value = '';
    addMsg('user', msg);
    callOllama(msg);
  };

  async function callOllama(userMsg) {
    var model   = (document.getElementById('aiModelSelect') || { value: 'llama3.2' }).value || 'llama3.2';
    _hist.push({ role: 'user', content: userMsg });

    var thinkEl = addMsgHtml('thinking', '🤖 Pensando con ' + escHtml(model) + '...');
    var btn     = document.getElementById('aiSendBtn');
    if (btn) btn.disabled = true;

    var msgs = [
      { role: 'system',    content: SYSTEM },
      { role: 'user',      content: 'Map context:\n' + getMapContext() },
      { role: 'assistant', content: 'Understood.' }
    ].concat(_hist.slice(-10));

    try {
      var res = await fetch(OLLAMA + '/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: model, messages: msgs, stream: false, options: { temperature: 0.3, num_predict: 800 } })
      });

      if (thinkEl) thinkEl.remove();

      if (!res.ok) {
        var et = '';
        try { var ed = await res.json(); et = ed.error || res.statusText; } catch(e) { et = res.statusText; }
        addMsgHtml('err', 'Ollama error ' + res.status + ': ' + escHtml(et));
        _hist.pop();
        if (btn) btn.disabled = false;
        return;
      }

      var data  = await res.json();
      var reply = (data.message && data.message.content) ? data.message.content : '';
      if (!reply) {
        addMsgHtml('err', 'Empty response.');
        _hist.pop();
        if (btn) btn.disabled = false;
        return;
      }

      _hist.push({ role: 'assistant', content: reply });
      addMsg('bot', reply);
      _pending = null;

      // Extract JSON style suggestion if present
      var jsonMatch = reply.match(/```json\s*([\s\S]*?)```/);
      if (!jsonMatch) {
        var fm = reply.match(/(\{[\s\S]*?"attribute"[\s\S]*?\})/);
        if (fm) jsonMatch = [null, fm[1]];
      }
      var ab = document.getElementById('aiApplyBtn');
      if (jsonMatch && jsonMatch[1]) {
        try {
          _pending = JSON.parse(jsonMatch[1].trim());
          if (ab) ab.style.display = 'block';
        } catch(e) {
          console.warn('JSON parse:', e);
          _pending = null;
        }
      } else {
        if (ab) ab.style.display = 'none';
      }

    } catch(e) {
      if (thinkEl) thinkEl.remove();
      var hint = (e.message.indexOf('fetch') !== -1 || e.message.indexOf('Failed') !== -1)
        ? '<br><small>Ejecuta: <code>OLLAMA_ORIGINS="*" ollama serve</code></small>'
        : '';
      addMsgHtml('err', 'Network error: ' + escHtml(e.message) + hint);
      _hist.pop();
    }

    if (btn) btn.disabled = false;
  }

  window.aiApplyStyle = function() {
    if (!_pending)                                      { addMsgHtml('err', 'No hay ningún estilo pendiente.'); return; }
    if (!map)                                           { addMsgHtml('err', 'El mapa no está listo.'); return; }
    if (!currentDataset || !activeLayers[currentDataset]) { addMsgHtml('err', 'Selecciona un dataset primero.'); return; }

    var s      = _pending;
    var attr   = String(s.attribute  || '').trim();
    var viz    = String(s.viz        || 'choropleth').trim();
    var scheme = String(s.scheme     || 'blues').trim();
    var lAttr  = String(s.labelAttr  || '').trim();
    var lBg    = String(s.labelBg    || 'white').trim();

    if (['choropleth','categorical','size'].indexOf(viz) === -1) viz = 'choropleth';
    var validSchemes = ['blues','reds','greens','oranges','purples','greys','rdbu','rdylgn','spectral','viridis','magma','plasma','inferno','rainbow','tableau','bold','safe'];
    if (validSchemes.indexOf(scheme) === -1) scheme = 'blues';

    // Fuzzy-match attribute name
    var names   = getAttributeNames(), matched = '';
    for (var i = 0; i < names.length; i++) {
      if (names[i].toLowerCase() === attr.toLowerCase()) { matched = names[i]; break; }
    }
    if (!matched) {
      for (var i = 0; i < names.length; i++) {
        if (names[i].toLowerCase().indexOf(attr.toLowerCase()) === 0) { matched = names[i]; break; }
      }
    }
    if (!matched) {
      addMsgHtml('err', 'Atributo <strong>' + escHtml(attr) + '</strong> no encontrado.<br>Disponibles: <strong>' + escHtml(names.slice(0, 8).join(', ')) + '</strong>');
      _pending = null;
      return;
    }

    // Sync UI selects
    function syncSel(id, value) {
      var el = document.getElementById(id);
      if (!el || !value) return;
      var low = value.toLowerCase();
      for (var i = 0; i < el.options.length; i++) {
        if (el.options[i].value === value || el.options[i].value.toLowerCase() === low) {
          el.selectedIndex = i; return;
        }
      }
    }
    syncSel('attributeSelect', matched);
    syncSel('vizType',         viz);
    syncSel('colorScheme',     scheme);
    syncSel('labelSelect',     lAttr);
    syncSel('labelBg',         lBg);

    var sp = document.getElementById('stylePanel');
    if (sp && !sp.classList.contains('visible')) sp.classList.add('visible');

    var stats = computeStats(matched, viz) || statsFromFeatures(matched, viz === 'categorical');
    if (!stats) {
      addMsgHtml('err', 'Sin estadísticas para <strong>' + escHtml(matched) + '</strong>. Acércate al mapa e inténtalo de nuevo.');
      _pending = null;
      return;
    }

    try { _dispatchStyle(matched, viz, stats, scheme); }
    catch(e) { addMsgHtml('err', 'Error de estilo: ' + escHtml(e.message)); _pending = null; return; }

    if (lAttr && names.indexOf(lAttr) !== -1) applyLabels(lAttr, '12', '#202124');

    addMsgHtml('info',
      'Estilo aplicado: <strong>' + escHtml(matched) + '</strong> &middot; ' + viz + ' &middot; ' + scheme +
      (s.reason ? '<br><em>' + escHtml(String(s.reason)) + '</em>' : ''));

    document.getElementById('aiApplyBtn').style.display = 'none';
    _pending = null;
  };
})();