var map = null;
var currentDataset = null;
var allDatasets = [];
var currentGeometryType = null;
var currentAttributes = [];
var activePopup = null;
var urlUpdateTimer = null;
var sourceLayer = 'layer0';
var _labelAttr = null, _labelSize = 12, _labelColor = '#202124', _labelFrame = null;

var activeLayers = {};

var LAYER_COLORS = [
  { fill:'#4285f4', outline:'#1a73e8', circle:'#4285f4', line:'#4285f4' },
  { fill:'#ea4335', outline:'#c5221f', circle:'#ea4335', line:'#ea4335' },
  { fill:'#34a853', outline:'#1e8e3e', circle:'#34a853', line:'#34a853' },
  { fill:'#fbbc04', outline:'#e37400', circle:'#fbbc04', line:'#fbbc04' },
  { fill:'#9c27b0', outline:'#7b1fa2', circle:'#9c27b0', line:'#9c27b0' },
  { fill:'#00bcd4', outline:'#0097a7', circle:'#00bcd4', line:'#00bcd4' }
];

var searchInput   = document.getElementById('searchInput');
var downloadAllBtn  = document.getElementById('downloadAllBtn');
var downloadViewBtn = document.getElementById('downloadViewBtn');
var legendEl        = document.getElementById('legend');
var legendContentEl = document.getElementById('legendContent');

function parseUrlState() {
  var p  = new URLSearchParams(window.location.search);
  var hp = new URLSearchParams(window.location.hash.slice(1));
  var dataset = p.get('dataset') || null;
  var center = null, zoom = null;
  var cs = hp.get('center');
  if (cs) { var pts = cs.split(',').map(Number); if (pts.length===2&&!isNaN(pts[0])) center=[pts[1],pts[0]]; }
  var zs = hp.get('zoom'); if (zs) zoom = parseFloat(zs);
  return { dataset:dataset, center:center, zoom:zoom };
}

function updateUrl() {
  if (!map) return;
  var c = map.getCenter(), z = map.getZoom();
  var datasets = Object.keys(activeLayers);
  var search = datasets.length ? '?datasets='+datasets.map(encodeURIComponent).join(',') : '';
  var hash = 'center='+c.lat.toFixed(5)+','+c.lng.toFixed(5)+'&zoom='+z.toFixed(2);
  window.history.replaceState({}, '', window.location.pathname+search+'#'+hash);
}
function scheduleUrlUpdate() { clearTimeout(urlUpdateTimer); urlUpdateTimer = setTimeout(updateUrl, 150); }

var datasetMetadata = {
  'OSM2015/all_objects':{ size:'91.6 GB', records:'264 m', geometry:'GEOMETRYCOLLECTION', desc:'All OpenStreetMap objects.' },
  'TIGER2018/COUNTY':  { size:'2.3 GB',  records:'3142',  geometry:'POLYGON',    desc:'US County boundaries.' },
  'TIGER2018/POINTLM': { size:'1.8 GB',  records:'100 k', geometry:'POINT',      desc:'Point landmarks.' },
  'TIGER2018/ROADS':   { size:'45 GB',   records:'22 m',  geometry:'LINESTRING', desc:'US Road network.' }
};
var datasetAttributesFallback = {
  'TIGER2018/COUNTY':  ['ALAND','AWATER','STATEFP','COUNTYFP','NAME'],
  'TIGER2018/POINTLM': ['MTFCC','NAME'],
  'TIGER2018/ROADS':   ['MTFCC','RTTYP','FULLNAME']
};

async function loadAttributes(dataset) {
  try {
    var res = await fetch('/api/datasets/'+encodeURIComponent(dataset)+'/stats');
    if (!res.ok) throw new Error();
    var data = await res.json();
    currentAttributes = Array.isArray(data.attributes)
      ? data.attributes.filter(function(a){ return a.name!=='geometry'; })
      : [];
  } catch(e) { currentAttributes = []; }
}

function getAttributeNames() {
  if (currentAttributes.length) return currentAttributes.map(function(a){ return a.name; });
  return (currentDataset && datasetAttributesFallback[currentDataset]) || [];
}

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
  var filtered = allDatasets.filter(function(d){ return d.toLowerCase().indexOf(filter.toLowerCase())!==-1; });
  if (!filtered.length) {
    listEl.innerHTML = '<div style="padding:40px 20px;color:#9aa0a6;text-align:center;">No datasets found</div>';
    return;
  }
  listEl.innerHTML = filtered.map(function(d){
    var isActive = !!activeLayers[d];
    var idx      = Object.keys(activeLayers).indexOf(d);
    var color    = isActive ? LAYER_COLORS[idx % LAYER_COLORS.length].fill : null;
    return '<div class="dataset-item'+(d===currentDataset?' active':'')+
           (isActive?' loaded':'')+'" onclick="toggleDatasetLayer(\''+d+'\')" title="'+(isActive?'Remove from map':'Add to map')+'">' +
           (isActive ? '<span class="ds-dot" style="background:'+color+'"></span>' : '<span class="ds-dot-empty"></span>') +
           '<span class="ds-name">'+d+'</span>'+
           (isActive ? '<span class="ds-remove" onclick="event.stopPropagation();removeDatasetLayer(\''+d+'\')">×</span>' : '') +
           '</div>';
  }).join('');
}

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
  if (idx >= LAYER_COLORS.length) { alert('Maximum '+LAYER_COLORS.length+' layers at once.'); return; }

  currentDataset = dataset;
  var mapEl = document.getElementById('map');
  mapEl.classList.add('dataset-switching');
  setTimeout(function(){ mapEl.classList.remove('dataset-switching'); }, 400);

  await loadAttributes(dataset);

  var n = dataset.toUpperCase();
  var geomType = n.indexOf('POINTLM')!==-1||n.indexOf('POINT')!==-1 ? 'point'
               : n.indexOf('ROAD')!==-1||n.indexOf('EDGE')!==-1 ? 'line' : 'polygon';
  currentGeometryType = geomType;

  var sl = 'layer0';
  try {
    var r = await fetch('/api/datasets/'+encodeURIComponent(dataset)+'/stats');
    if (r.ok) { var d=await r.json(); if (d.source_layer) sl=d.source_layer; }
  } catch(e){}

  var tileUrl = 'http://127.0.0.1:5000/'+dataset+'/{z}/{x}/{y}.mvt';
  var colors  = LAYER_COLORS[idx % LAYER_COLORS.length];
  var srcId   = 'src-'+idx;
  var prefix  = 'ds'+idx+'-';

  map.addSource(srcId, { type:'vector', tiles:[tileUrl], minzoom:0, maxzoom:14 });

  var addedLayers = [];

  if (geomType==='polygon') {
    map.addLayer({ id:prefix+'fill', type:'fill', source:srcId, 'source-layer':sl,
      filter:['any',['==',['geometry-type'],'Polygon'],['==',['geometry-type'],'MultiPolygon']],
      paint:{ 'fill-color':colors.fill, 'fill-opacity':0.45 } });
    map.addLayer({ id:prefix+'outline', type:'line', source:srcId, 'source-layer':sl,
      filter:['any',['==',['geometry-type'],'Polygon'],['==',['geometry-type'],'MultiPolygon']],
      paint:{ 'line-color':colors.outline, 'line-width':1 } });
    addedLayers = [prefix+'fill', prefix+'outline'];
  } else if (geomType==='point') {
    map.addLayer({ id:prefix+'points', type:'circle', source:srcId, 'source-layer':sl,
      filter:['==',['geometry-type'],'Point'],
      paint:{ 'circle-radius':5, 'circle-color':colors.circle, 'circle-stroke-width':1, 'circle-stroke-color':'rgba(255,255,255,0.5)' } });
    addedLayers = [prefix+'points'];
  } else {
    map.addLayer({ id:prefix+'lines', type:'line', source:srcId, 'source-layer':sl,
      filter:['any',['==',['geometry-type'],'LineString'],['==',['geometry-type'],'MultiLineString']],
      paint:{ 'line-color':colors.line, 'line-width':2 } });
    addedLayers = [prefix+'lines'];
  }

  addedLayers.forEach(function(lid){
    map.on('mouseenter', lid, function(){ map.getCanvas().style.cursor='pointer'; });
    map.on('mouseleave', lid, function(){ map.getCanvas().style.cursor=''; });
  });

  activeLayers[dataset] = { srcId:srcId, prefix:prefix, layers:addedLayers, geomType:geomType, sourceLayer:sl, colorIdx:idx, colors:colors };

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
  info.layers.forEach(function(lid){ try{ map.removeLayer(lid); }catch(e){} });
  try{ map.removeSource(info.srcId); }catch(e){}
  delete activeLayers[dataset];
  if (currentDataset===dataset) {
    var remaining = Object.keys(activeLayers);
    currentDataset = remaining.length ? remaining[remaining.length-1] : null;
    if (currentDataset) {
      var inf = activeLayers[currentDataset];
      currentGeometryType = inf.geomType;
    } else {
      currentGeometryType = null;
      currentAttributes = [];
    }
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
  currentDataset = null; currentAttributes = [];
  searchInput.value = '';
  window.history.replaceState({}, '', window.location.pathname+window.location.hash);
  renderDatasetList();
  updateDetailPanel();
  populateAttributeSelect();
  populateLabelSelect();
  resetLegend();
  updateLayersPanel();
}

function updateDetailPanel() {
  var has = !!currentDataset;
  downloadAllBtn.disabled = downloadViewBtn.disabled = !has;
  if (!has) {
    document.getElementById('detailTitle').textContent = 'Select a dataset';
    ['detailSize','detailRecords','detailGeometry'].forEach(function(id){ document.getElementById(id).textContent='-'; });
    document.getElementById('detailDesc').style.display = 'none';
    return;
  }
  var meta = datasetMetadata[currentDataset] || { size:'-', records:'-', geometry:guessGeometryType(currentDataset), desc:'Vector tile dataset' };
  document.getElementById('detailTitle').textContent    = currentDataset;
  document.getElementById('detailSize').textContent     = meta.size;
  document.getElementById('detailRecords').textContent  = meta.records;
  document.getElementById('detailGeometry').textContent = meta.geometry;
  var descEl = document.getElementById('detailDesc');
  descEl.textContent = meta.desc; descEl.style.display = 'block';
}

function guessGeometryType(name) {
  if (!name) return 'GEOMETRY';
  var n = name.toUpperCase();
  if (n.indexOf('COUNTY')!==-1||n.indexOf('PLACE')!==-1) return 'POLYGON';
  if (n.indexOf('POINT')!==-1) return 'POINT';
  if (n.indexOf('ROAD')!==-1||n.indexOf('EDGE')!==-1) return 'LINESTRING';
  return 'GEOMETRY';
}

function updateLayersPanel() {
  var panel = document.getElementById('layersPanel');
  var keys = Object.keys(activeLayers);
  if (!keys.length) { panel.innerHTML = '<div class="layers-empty">No layers loaded</div>'; return; }
  panel.innerHTML = keys.map(function(ds){
    var info = activeLayers[ds];
    var c = info.colors.fill;
    var isActive = ds===currentDataset;
    return '<div class="layer-row'+(isActive?' layer-active':'')+'" onclick="selectActiveDataset(\''+ds+'\')" title="Click to select for styling">' +
      '<span class="layer-swatch" style="background:'+c+'"></span>' +
      '<span class="layer-name">'+ds+'</span>' +
      '<span class="layer-vis" onclick="event.stopPropagation();toggleLayerVisibility(\''+ds+'\')" title="Toggle visibility">'+
        (info.hidden?'👁':'👁')+
      '</span>' +
      '<span class="layer-opacity-wrap"><input type="range" class="layer-opacity" min="0" max="100" value="'+(info.opacity!==undefined?info.opacity*100:50)+
        '" oninput="event.stopPropagation();setLayerOpacity(\''+ds+'\',this.value/100)"></span>' +
      '<span class="layer-del" onclick="event.stopPropagation();removeDatasetLayer(\''+ds+'\')">×</span>' +
    '</div>';
  }).join('');
}

function selectActiveDataset(dataset) {
  currentDataset = dataset;
  var info = activeLayers[dataset];
  if (info) {
    currentGeometryType = info.geomType;
    loadAttributes(dataset).then(function(){
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
  info.layers.forEach(function(lid){ try{ map.setLayoutProperty(lid,'visibility',vis); }catch(e){} });
  updateLayersPanel();
}

function setLayerOpacity(dataset, val) {
  if (!map || !activeLayers[dataset]) return;
  var info = activeLayers[dataset];
  info.opacity = val;
  info.layers.forEach(function(lid){
    try {
      var layer = map.getLayer(lid);
      if (!layer) return;
      if (layer.type==='fill')   map.setPaintProperty(lid,'fill-opacity',val*0.9);
      if (layer.type==='circle') map.setPaintProperty(lid,'circle-opacity',val);
      if (layer.type==='line')   map.setPaintProperty(lid,'line-opacity',val);
    } catch(e){}
  });
}

function downloadDataset(mode) {
  if (!currentDataset) return;
  var fmtEl = document.getElementById('downloadFormat');
  var fmt = fmtEl ? fmtEl.value : 'geojson';
  var ext = fmt==='csv'?'.csv':fmt==='shp'?'.zip':'.geojson';
  var enc = encodeURIComponent(currentDataset);
  var url;
  if (mode==='viewport'&&map) {
    var b=map.getBounds();
    var mbr=b.getWest().toFixed(6)+','+b.getSouth().toFixed(6)+','+b.getEast().toFixed(6)+','+b.getNorth().toFixed(6);
    url='/datasets/'+enc+'/features.'+fmt+'?mbr='+mbr;
  } else { url='/datasets/'+enc+'/features.'+fmt; }
  var btn=mode==='viewport'?downloadViewBtn:downloadAllBtn;
  var orig=btn.textContent; btn.disabled=true; btn.textContent='⏳ Preparing...';
  var a=document.createElement('a'); a.href=url;
  a.download=currentDataset.replace(/\//g,'_')+(mode==='viewport'?'_view':'_full')+ext;
  a.style.display='none'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ btn.textContent=orig; btn.disabled=false; }, 2500);
}

async function initMap(initialCenter, initialZoom) {
  if (activePopup) { activePopup.remove(); activePopup=null; }
  _detachLabelRenderer();
  if (map) { map.remove(); map=null; }
  activeLayers = {};

  map = new maplibregl.Map({
    container:'map',
    style:{ version:8, sources:{ basemap:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256} },
            layers:[{id:'basemap',type:'raster',source:'basemap'}] },
    center: initialCenter||[-98,39],
    zoom:   initialZoom||4
  });

  map.on('load', function(){
    attachClickHandlers();
    updateLayersPanel();
  });
  map.on('moveend', scheduleUrlUpdate);
  map.on('zoomend', scheduleUrlUpdate);
}

function attachClickHandlers() {
  if (!map) return;
  map.on('click', function(e){
    var allLayerIds = [];
    Object.values(activeLayers).forEach(function(info){ allLayerIds = allLayerIds.concat(info.layers); });
    if (!allLayerIds.length) return;
    var avail = allLayerIds.filter(function(l){ try{ return map.getLayer(l); }catch(x){ return false; } });
    var feats = map.queryRenderedFeatures(e.point, {layers:avail});
    if (!feats||!feats.length) return;
    var props = feats[0].properties;
    if (!props||!Object.keys(props).length) return;
    var rows = Object.entries(props).filter(function(kv){ return kv[0]!=='geometry'&&kv[0].indexOf('_')!==0; });
    if (!rows.length) return;
    var geomType   = feats[0].geometry ? feats[0].geometry.type : '';
    var headerLabel = geomType ? '📍 '+geomType : '📍 Feature Properties';
    var countLabel  = rows.length+' attribute'+(rows.length!==1?'s':'');
    var body = rows.map(function(kv){
      var v=kv[1];
      var vs = v===null||v===undefined ? '<em class="popup-null">null</em>'
             : typeof v==='number' ? '<span class="popup-num">'+v.toLocaleString()+'</span>'
             : String(v);
      return '<div class="popup-row"><span class="popup-key" title="'+kv[0]+'">'+kv[0]+'</span><span class="popup-val">'+vs+'</span></div>';
    }).join('');
    var html='<div class="popup-header"><span>'+headerLabel+'</span><span class="popup-count">'+countLabel+'</span></div>'+
             '<div class="popup-body">'+body+'</div>';
    if (activePopup) activePopup.remove();
    activePopup = new maplibregl.Popup({maxWidth:'360px',closeButton:true}).setLngLat(e.lngLat).setHTML(html).addTo(map);
  });
}

function toggleStylePanel() {
  if (!currentDataset) { alert('Select a dataset first'); return; }
  document.getElementById('stylePanel').classList.toggle('visible');
}

function populateAttributeSelect() {
  var el = document.getElementById('attributeSelect'); if (!el) return;
  el.innerHTML = '<option value="">Default style</option>';
  if (!currentDataset) return;
  getAttributeNames().forEach(function(name){
    var o=document.createElement('option'); o.value=name;
    var attr=currentAttributes.find(function(a){return a.name===name;});
    var cnt=attr&&attr.stats&&attr.stats.non_null_count;
    o.textContent=cnt?name+' ('+cnt.toLocaleString()+' vals)':name;
    el.appendChild(o);
  });
}

function populateLabelSelect() {
  var el=document.getElementById('labelSelect'); if(!el) return;
  el.innerHTML='<option value="">No labels</option>';
  if (!currentDataset) return;
  getAttributeNames().forEach(function(name){
    var o=document.createElement('option');o.value=name;o.textContent=name;el.appendChild(o);
  });
}

function resetToDefaultStyle() {
  if (!map||!currentDataset||!activeLayers[currentDataset]) return;
  var info = activeLayers[currentDataset];
  var c = info.colors;
  var p = info.prefix;
  try {
    if (map.getLayer(p+'fill'))    { map.setPaintProperty(p+'fill','fill-color',c.fill); map.setPaintProperty(p+'fill','fill-opacity',0.45); }
    if (map.getLayer(p+'outline')) { map.setPaintProperty(p+'outline','line-color',c.outline); map.setPaintProperty(p+'outline','line-width',1); }
    if (map.getLayer(p+'points'))  { map.setPaintProperty(p+'points','circle-color',c.circle); map.setPaintProperty(p+'points','circle-radius',5); }
    if (map.getLayer(p+'lines'))   { map.setPaintProperty(p+'lines','line-color',c.line); map.setPaintProperty(p+'lines','line-width',2); }
  } catch(e){}
}

function resetLegend() {
  if (legendEl) legendEl.classList.remove('visible');
  if (legendContentEl) legendContentEl.innerHTML='';
}

function _canvas()  { return document.getElementById('label-canvas'); }
function _ctx()     { var c=_canvas(); return c?c.getContext('2d'):null; }
function _resizeCanvas() {
  var c=_canvas(); if(!c) return;
  var m=document.getElementById('map'); c.width=m.offsetWidth; c.height=m.offsetHeight;
}
function _clearCanvas() {
  var c=_canvas(),ctx=_ctx(); if(ctx&&c) ctx.clearRect(0,0,c.width,c.height);
}

function _renderLabels() {
  _labelFrame=null;
  var c=_canvas(),ctx=_ctx();
  if (!ctx||!c||!map||!_labelAttr){_clearCanvas();return;}
  var mzEl=document.getElementById('labelMinZoom'),mz=mzEl?parseFloat(mzEl.value):0;
  if (map.getZoom()<mz){_clearCanvas();return;}
  _resizeCanvas();_clearCanvas();
  var W=c.width,H=c.height;
  var allLayerIds=[];
  Object.values(activeLayers).forEach(function(info){allLayerIds=allLayerIds.concat(info.layers);});
  var avail=allLayerIds.filter(function(l){try{return map.getLayer(l);}catch(e){return false;}});
  if (!avail.length) return;
  var feats; try{feats=map.queryRenderedFeatures({layers:avail});}catch(e){return;}
  if (!feats||!feats.length) return;
  var zs=Math.max(0.7,Math.min(2.0,0.5+map.getZoom()/12));
  var fs=Math.round(_labelSize*zs);
  var bgEl=document.getElementById('labelBg'),bgMode=bgEl?bgEl.value:'white';
  ctx.font='600 '+fs+'px system-ui,-apple-system,sans-serif';
  ctx.textAlign='center';ctx.textBaseline='middle';
  var seen={},candidates=[];
  for (var i=0;i<feats.length;i++){
    var f=feats[i];
    var fid=f.id!=null?String(f.id):JSON.stringify(f.properties).slice(0,60);
    if (seen[fid]) continue; seen[fid]=true;
    var val=f.properties&&f.properties[_labelAttr];
    if (val===null||val===undefined||val==='') continue;
    var text=String(val),px,py;
    try {
      var g=f.geometry,coord;
      if (g.type==='Point'){coord=g.coordinates;}
      else if(g.type==='Polygon'){var ring=g.coordinates[0],sx=0,sy=0;for(var j=0;j<ring.length;j++){sx+=ring[j][0];sy+=ring[j][1];}coord=[sx/ring.length,sy/ring.length];}
      else if(g.type==='MultiPolygon'){var best=null,blen=0;for(var p=0;p<g.coordinates.length;p++){if(g.coordinates[p][0].length>blen){blen=g.coordinates[p][0].length;best=g.coordinates[p][0];}}if(!best)continue;var sx=0,sy=0;for(var j=0;j<best.length;j++){sx+=best[j][0];sy+=best[j][1];}coord=[sx/best.length,sy/best.length];}
      else if(g.type==='LineString'){coord=g.coordinates[Math.floor(g.coordinates.length/2)];}
      else if(g.type==='MultiLineString'){var ln=g.coordinates[0];coord=ln[Math.floor(ln.length/2)];}
      else continue;
      var pt=map.project(coord);px=pt.x;py=pt.y;
    }catch(e){continue;}
    if(px<0||py<0||px>W||py>H) continue;
    var tw=ctx.measureText(text).width;
    candidates.push({text:text,px:px,py:py,tw:tw,th:fs});
  }
  var PAD=4,placed=[];
  function overlaps(bx,by,bw,bh){var x1=bx-bw/2-PAD,x2=bx+bw/2+PAD,y1=by-bh/2-PAD,y2=by+bh/2+PAD;for(var k=0;k<placed.length;k++){var pl=placed[k];if(!(x2<pl.x1||x1>pl.x2||y2<pl.y1||y1>pl.y2))return true;}return false;}
  for (var i=0;i<candidates.length;i++){
    var cand=candidates[i],tx=cand.px,ty=cand.py,tw=cand.tw,th=cand.th,text=cand.text;
    if(overlaps(tx,ty,tw,th))continue;
    placed.push({x1:tx-tw/2-PAD,x2:tx+tw/2+PAD,y1:ty-th/2-PAD,y2:ty+th/2+PAD});
    if(bgMode!=='none'){
      var bx=tx-tw/2-4,by=ty-th/2-3,bw=tw+8,bh=th+6,r=bh/2;
      var fill=bgMode==='white'?'rgba(255,255,255,0.88)':bgMode==='dark'?'rgba(20,20,20,0.78)':_labelColor+'30';
      ctx.beginPath();ctx.moveTo(bx+r,by);ctx.lineTo(bx+bw-r,by);ctx.arcTo(bx+bw,by,bx+bw,by+bh,r);ctx.lineTo(bx+bw,by+bh-r);ctx.arcTo(bx+bw,by+bh,bx+bw-r,by+bh,r);ctx.lineTo(bx+r,by+bh);ctx.arcTo(bx,by+bh,bx,by+bh-r,r);ctx.lineTo(bx,by+r);ctx.arcTo(bx,by,bx+r,by,r);ctx.closePath();
      ctx.fillStyle=fill;ctx.fill();
      ctx.strokeStyle=bgMode==='dark'?'rgba(255,255,255,0.12)':'rgba(0,0,0,0.07)';ctx.lineWidth=0.5;ctx.stroke();
    }else{ctx.strokeStyle='rgba(255,255,255,0.92)';ctx.lineWidth=3;ctx.strokeText(text,tx,ty);}
    ctx.fillStyle=bgMode==='dark'?'#fff':_labelColor;ctx.fillText(text,tx,ty);
  }
}

function _scheduleRender(){if(!_labelFrame)_labelFrame=requestAnimationFrame(_renderLabels);}

function applyLabels(attr,fontSize,color){
  _labelAttr=attr||null;_labelSize=parseInt(fontSize)||12;_labelColor=color||'#202124';
  if(!_labelAttr){_clearCanvas();return;}
  _scheduleRender();
  if(map&&!map._labelsBound){map._labelsBound=true;map.on('render',_scheduleRender);map.on('zoomend',_scheduleRender);}
}

function _detachLabelRenderer(){
  if(map&&map._labelsBound){map.off('render',_scheduleRender);map.off('zoomend',_scheduleRender);map._labelsBound=false;}
  _clearCanvas();_labelAttr=null;
}

function applyStyle(attrArg, vizArg, schemeArg) {
  if (!map||!currentDataset||!activeLayers[currentDataset]) return;
  var attr   = attrArg   !== undefined ? attrArg   : document.getElementById('attributeSelect').value;
  var viz    = vizArg    !== undefined ? vizArg    : document.getElementById('vizType').value;
  var scheme = schemeArg !== undefined ? schemeArg : document.getElementById('colorScheme').value;
  var lAttr  = document.getElementById('labelSelect').value;
  var lSize  = document.getElementById('labelSize').value || '12';
  var lColor = document.getElementById('labelColor').value || '#202124';

  if (!attr) { resetToDefaultStyle(); resetLegend(); }
  else {
    var stats = computeStats(attr, viz);
    if (!stats) stats = statsFromFeatures(attr, viz==='categorical');
    if (!stats) { resetToDefaultStyle(); resetLegend(); }
    else {
      try { _dispatchStyle(attr, viz, stats, scheme); }
      catch(e){ console.error(e); }
    }
  }
  applyLabels(lAttr, lSize, lColor);
}

function _dispatchStyle(attr, viz, stats, scheme) {
  if (!activeLayers[currentDataset]) return;
  var info = activeLayers[currentDataset];
  var gt = info.geomType;
  if (gt==='polygon') _applyPolygonStyle(attr,viz,stats,scheme,info.prefix);
  else if (gt==='point') _applyPointStyle(attr,viz,stats,scheme,info.prefix);
  else if (gt==='line')  _applyLineStyle(attr,viz,stats,scheme,info.prefix);
}

function _applyPolygonStyle(attr,viz,stats,scheme,prefix){
  if(!map.getLayer(prefix+'fill'))return;
  if(viz==='choropleth'){var e=buildChoroplethExpr(attr,stats,scheme);if(!e)return;map.setPaintProperty(prefix+'fill','fill-color',e);map.setPaintProperty(prefix+'fill','fill-opacity',0.8);if(map.getLayer(prefix+'outline')){map.setPaintProperty(prefix+'outline','line-color',e);map.setPaintProperty(prefix+'outline','line-width',1);}updateLegendChoropleth(attr,stats,scheme);}
  else if(viz==='categorical'){var e=buildCategoricalExpr(attr,stats,scheme);if(!e)return;map.setPaintProperty(prefix+'fill','fill-color',e);map.setPaintProperty(prefix+'fill','fill-opacity',0.8);if(map.getLayer(prefix+'outline')){map.setPaintProperty(prefix+'outline','line-color',e);}updateLegendCategorical(attr,stats,scheme);}
  else{if(!isFinite(stats.min)||!isFinite(stats.max)||stats.min===stats.max)return;map.setPaintProperty(prefix+'fill','fill-opacity',['interpolate',['linear'],['to-number',['get',attr]],stats.min,0.2,stats.max,0.9]);updateLegendChoropleth(attr,stats,scheme);}
}

function _applyPointStyle(attr,viz,stats,scheme,prefix){
  if(!map.getLayer(prefix+'points'))return;
  if(viz==='size'){var e=buildSizeExpr(attr,stats,5);if(!e)return;map.setPaintProperty(prefix+'points','circle-radius',e);updateLegendChoropleth(attr,stats,scheme);}
  else{var isCat=viz==='categorical',e=isCat?buildCategoricalExpr(attr,stats,scheme):buildChoroplethExpr(attr,stats,scheme);if(!e)return;map.setPaintProperty(prefix+'points','circle-color',e);isCat?updateLegendCategorical(attr,stats,scheme):updateLegendChoropleth(attr,stats,scheme);}
}

function _applyLineStyle(attr,viz,stats,scheme,prefix){
  if(!map.getLayer(prefix+'lines'))return;
  if(viz==='size'){var e=buildSizeExpr(attr,stats,3);if(!e)return;map.setPaintProperty(prefix+'lines','line-width',e);updateLegendChoropleth(attr,stats,scheme);}
  else{var isCat=viz==='categorical',e=isCat?buildCategoricalExpr(attr,stats,scheme):buildChoroplethExpr(attr,stats,scheme);if(!e)return;map.setPaintProperty(prefix+'lines','line-color',e);isCat?updateLegendCategorical(attr,stats,scheme):updateLegendChoropleth(attr,stats,scheme);}
}

function computeStats(attrName,viz){
  var forceCat=viz==='categorical',found=null;
  for(var i=0;i<currentAttributes.length;i++){if(currentAttributes[i].name===attrName){found=currentAttributes[i];break;}}
  if(found&&found.stats){
    var s=found.stats,topK=s.top_k||[];
    if(forceCat)return{min:null,max:null,categories:topK.map(function(t){return String(t.value);}).slice(0,8)};
    var numVals=topK.map(function(t){return parseFloat(t.value);}).filter(function(v){return !isNaN(v);});
    if(numVals.length&&numVals.length>=topK.length*0.5){var mn=Math.min.apply(null,numVals),mx=Math.max.apply(null,numVals);if(mn===mx){mn=mn*0.9||0;mx=mx*1.1||1;}return{min:mn,max:mx,categories:[]};}
    return{min:null,max:null,categories:topK.map(function(t){return String(t.value);}).slice(0,8)};
  }
  return statsFromFeatures(attrName,forceCat);
}

function statsFromFeatures(attrName,forceCat){
  if(!map)return null;
  try{
    var allLayerIds=[];
    Object.values(activeLayers).forEach(function(info){allLayerIds=allLayerIds.concat(info.layers);});
    var avail=allLayerIds.filter(function(l){try{return map.getLayer(l);}catch(e){return false;}});
    if(!avail.length)return null;
    var feats=map.queryRenderedFeatures({layers:avail});
    if(!feats||!feats.length)return null;
    var nums=[],cats=[],seen={};
    feats.forEach(function(f){var v=f.properties&&f.properties[attrName];if(v===null||v===undefined||v==='')return;var s=String(v);if(!seen[s]){seen[s]=true;cats.push(s);}var n=parseFloat(v);if(!isNaN(n))nums.push(n);});
    if(!cats.length)return null;
    var isNum=nums.length>=cats.length*0.5;
    if(!isNum||forceCat)return{min:null,max:null,categories:cats.slice(0,8)};
    var mn=Math.min.apply(null,nums),mx=Math.max.apply(null,nums);
    if(mn===mx){mn=mn*0.9||0;mx=mx*1.1||1;}
    return{min:mn,max:mx,categories:[]};
  }catch(e){return null;}
}

function getColorRamp(scheme){
  var r={blues:['#eff3ff','#bdd7e7','#6baed6','#3182bd','#08519c'],reds:['#fee5d9','#fcae91','#fb6a4a','#de2d26','#a50f15'],greens:['#e5f5e0','#a1d99b','#74c476','#31a354','#006d2c'],viridis:['#440154','#414487','#2a788e','#22a884','#7ad151'],rainbow:['#440154','#3b528b','#21918c','#5ec962','#fde725']};
  return r[scheme]||r.blues;
}

function buildChoroplethExpr(attr,stats,scheme){var c=getColorRamp(scheme),mn=stats.min,mx=stats.max;if(!isFinite(mn)||!isFinite(mx)||mn===mx)return null;var s=(mx-mn)/4;return['interpolate',['linear'],['to-number',['get',attr]],mn,c[0],mn+s,c[1],mn+2*s,c[2],mn+3*s,c[3],mx,c[4]];}
function buildSizeExpr(attr,stats,base){var mn=stats.min,mx=stats.max;if(!isFinite(mn)||!isFinite(mx)||mn===mx)return null;return['interpolate',['linear'],['to-number',['get',attr]],mn,base*0.5,mx,base*2.5];}
function buildCategoricalExpr(attr,stats,scheme){var c=getColorRamp(scheme),cats=stats.categories||[];if(!cats.length)return null;var e=['match',['get',attr]];cats.forEach(function(x,i){e.push(x,c[i%c.length]);});e.push('#aaaaaa');return e;}

function updateLegendChoropleth(attr,stats,scheme){
  if(!legendEl||!legendContentEl)return;
  var c=getColorRamp(scheme),mn=stats.min,mx=stats.max,s=(mx-mn)/4;
  legendContentEl.innerHTML='';
  [mn,mn+s,mn+2*s,mn+3*s,mx].forEach(function(v,i){var row=document.createElement('div');row.className='legend-item';row.innerHTML='<div class="legend-color" style="background:'+c[i]+'"></div><span>'+v.toFixed(2)+'</span>';legendContentEl.appendChild(row);});
  legendEl.classList.add('visible');legendEl.querySelector('.legend-title').textContent=attr;
}

function updateLegendCategorical(attr,stats,scheme){
  if(!legendEl||!legendContentEl)return;
  var c=getColorRamp(scheme);legendContentEl.innerHTML='';
  (stats.categories||[]).forEach(function(x,i){var row=document.createElement('div');row.className='legend-item';row.innerHTML='<div class="legend-color" style="background:'+c[i%c.length]+'"></div><span>'+x+'</span>';legendContentEl.appendChild(row);});
  legendEl.classList.add('visible');legendEl.querySelector('.legend-title').textContent=attr;
}

searchInput.addEventListener('input',function(e){renderDatasetList(e.target.value);});
document.getElementById('zoomIn').onclick  = function(){if(map)map.zoomIn();};
document.getElementById('zoomOut').onclick = function(){if(map)map.zoomOut();};

window.addEventListener('load', async function(){
  loadDatasets();
  var state = parseUrlState();
  var center = state.center, zoom = state.zoom;
  var urlParams = new URLSearchParams(window.location.search);
  var datasetsParam = urlParams.get('datasets');
  var datasetsToLoad = datasetsParam ? datasetsParam.split(',').map(decodeURIComponent) : (state.dataset ? [state.dataset] : []);
  await initMap(center, zoom);
  for (var i=0;i<datasetsToLoad.length;i++) {
    await addDatasetLayer(datasetsToLoad[i]);
  }
});

var gotoInput   = document.getElementById('gotoInput');
var gotoBtn     = document.getElementById('gotoBtn');
var gotoResults = document.getElementById('gotoResults');

function _showGeoResults(results){
  if(!gotoResults)return;
  if(!results||!results.length){gotoResults.innerHTML='<div class="goto-no-result">No results found</div>';gotoResults.classList.add('visible');setTimeout(function(){gotoResults.classList.remove('visible');},2000);return;}
  gotoResults.innerHTML=results.slice(0,6).map(function(r){var label=r.display_name||(r.lat+', '+r.lon);if(label.length>60)label=label.slice(0,57)+'…';return'<div class="goto-result-item" data-lat="'+r.lat+'" data-lon="'+r.lon+'" data-label="'+label+'"><span class="goto-result-icon">📍</span><span class="goto-result-text">'+label+'</span></div>';}).join('');
  gotoResults.classList.add('visible');
  gotoResults.querySelectorAll('.goto-result-item').forEach(function(el){el.addEventListener('click',function(){var lat=parseFloat(el.dataset.lat),lon=parseFloat(el.dataset.lon);if(map)map.flyTo({center:[lon,lat],zoom:12,speed:1.4,curve:1.42});gotoInput.value=el.dataset.label;gotoResults.classList.remove('visible');});});
}

function goToLocation(){
  var input=gotoInput.value.trim();if(!input)return;
  var m=input.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if(m){var la=parseFloat(m[1]),ln=parseFloat(m[2]);if(la>=-90&&la<=90&&ln>=-180&&ln<=180){if(map)map.flyTo({center:[ln,la],zoom:12,speed:1.4,curve:1.42});gotoInput.value='';if(gotoResults)gotoResults.classList.remove('visible');return;}}
  var btn=gotoBtn;btn.disabled=true;btn.textContent='…';
  fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&q='+encodeURIComponent(input),{headers:{'Accept-Language':'en'}})
    .then(function(r){return r.json();})
    .then(function(data){btn.disabled=false;btn.textContent='Go';if(data&&data.length===1){if(map)map.flyTo({center:[parseFloat(data[0].lon),parseFloat(data[0].lat)],zoom:12,speed:1.4,curve:1.42});gotoInput.value='';if(gotoResults)gotoResults.classList.remove('visible');}else{_showGeoResults(data);}})
    .catch(function(){btn.disabled=false;btn.textContent='Go';if(gotoResults){gotoResults.innerHTML='<div class="goto-no-result">Search error</div>';gotoResults.classList.add('visible');setTimeout(function(){gotoResults.classList.remove('visible');},2500);}});
}

gotoBtn.addEventListener('click',goToLocation);
gotoInput.addEventListener('keypress',function(e){if(e.key==='Enter')goToLocation();});
document.addEventListener('click',function(e){if(!gotoResults)return;var box=document.querySelector('.goto-box');if(box&&!box.contains(e.target))gotoResults.classList.remove('visible');});

var darkToggle=document.getElementById('darkToggle');
if(localStorage.getItem('ucrstar-dark-mode')==='on'){document.body.classList.add('dark');darkToggle.innerHTML='☀️';}
darkToggle.addEventListener('click',function(){var d=document.body.classList.toggle('dark');darkToggle.innerHTML=d?'☀️':'🌙';localStorage.setItem('ucrstar-dark-mode',d?'on':'off');});

window.toggleDatasetLayer  = toggleDatasetLayer;
window.removeDatasetLayer  = removeDatasetLayer;
window.selectActiveDataset = selectActiveDataset;
window.toggleLayerVisibility = toggleLayerVisibility;
window.setLayerOpacity     = setLayerOpacity;
window.clearFilters        = clearFilters;
window.toggleStylePanel    = toggleStylePanel;
window.applyStyle          = applyStyle;
window.downloadDataset     = downloadDataset;

(function(){
  var OLLAMA='http://localhost:11434';
  var _hist=[],_pending=null;

  function ping(){fetch(OLLAMA+'/api/tags').then(function(r){var dot=document.getElementById('aiStatusDot');if(!dot)return;if(r.ok){dot.className='ai-status-dot ok';dot.title='Ollama running';return r.json().then(function(d){if(!d.models||!d.models.length)return;var sel=document.getElementById('aiModelSelect');if(!sel)return;sel.innerHTML='';d.models.forEach(function(m){var o=document.createElement('option');o.value=m.name;o.textContent=m.name;sel.appendChild(o);});})}else{dot.className='ai-status-dot err';dot.title='Ollama not responding';}}).catch(function(){var dot=document.getElementById('aiStatusDot');if(dot){dot.className='ai-status-dot err';dot.title='Ollama not found';}});}

  window.aiToggle=function(){var p=document.getElementById('aiPanel');if(!p)return;var wasOpen=p.classList.contains('open');p.classList.toggle('open');if(!wasOpen)ping();};
  document.getElementById('aiFab').addEventListener('click',aiToggle);
  document.getElementById('aiIn').addEventListener('keydown',function(e){if(e.key==='Enter')aiSend();});

  function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function addMsg(type,raw){var box=document.getElementById('aiMsgs');if(!box)return null;var el=document.createElement('div');el.className='ai-msg '+type;var safe=escHtml(raw).replace(/```json([\s\S]*?)```/g,'<pre>$1</pre>').replace(/```([\s\S]*?)```/g,'<pre>$1</pre>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\n/g,'<br>');el.innerHTML=safe;box.appendChild(el);box.scrollTop=box.scrollHeight;return el;}
  function addMsgHtml(type,html){var box=document.getElementById('aiMsgs');if(!box)return null;var el=document.createElement('div');el.className='ai-msg '+type;el.innerHTML=html;box.appendChild(el);box.scrollTop=box.scrollHeight;return el;}

  function getMapContext(){
    if(!currentDataset)return'No dataset selected.';
    var ctx='Dataset: '+currentDataset+'\n';
    ctx+='Active layers: '+Object.keys(activeLayers).join(', ')+'\n';
    ctx+='Geometry type: '+(currentGeometryType||'unknown')+'\n';
    ctx+='Attributes: '+getAttributeNames().join(', ')+'\n';
    if(currentAttributes.length){ctx+='Attribute details:\n';currentAttributes.slice(0,8).forEach(function(a){if(!a.stats)return;var top=(a.stats.top_k||[]).slice(0,5).map(function(t){return String(t.value);}).join(', ');ctx+='  - '+a.name+': '+(a.stats.non_null_count||'?')+' non-null. Sample: '+top+'\n';});}
    try{var allLids=[];Object.values(activeLayers).forEach(function(info){allLids=allLids.concat(info.layers);});var avail=allLids.filter(function(l){return map&&map.getLayer(l);});if(avail.length&&map){var feats=map.queryRenderedFeatures({layers:avail});if(feats&&feats.length){ctx+='Sample feature: '+JSON.stringify(feats[0].properties).slice(0,300)+'\n';ctx+='Visible features: '+feats.length+'\n';}}}catch(e){}
    return ctx;
  }

  var SYSTEM=['You are an expert GIS visualization assistant for UCR-STAR, a MapLibre GL JS vector tile viewer.','Help users explore geospatial datasets and design effective map styles.','','When suggesting a style, output EXACTLY this JSON block:','```json','{','  "attribute": "ATTRIBUTE_NAME",','  "viz": "choropleth",','  "scheme": "blues",','  "labelAttr": "",','  "labelBg": "white",','  "reason": "one sentence"','}','```','viz values: choropleth | categorical | size','scheme values: blues | reds | greens | viridis | rainbow','Keep explanations to 3-4 sentences. Only include JSON when a style is needed.'].join('\n');

  var QUICK={describe:'What kind of data does this dataset contain?',suggest:'Suggest the best visualization for this dataset. Include the JSON style block.',best:'Which attribute makes the most informative choropleth? Include the JSON.',insight:'Analyze the visible features. What do the attribute values reveal?',anomaly:'Identify any outliers or anomalies in the visible features.'};

  window.aiQuick=function(type){if(!currentDataset){addMsgHtml('info','Please select a dataset first.');return;}var prompt=QUICK[type]||type;addMsg('user',prompt);callOllama(prompt);};
  window.aiSend=function(){var inp=document.getElementById('aiIn');if(!inp)return;var msg=inp.value.trim();if(!msg)return;inp.value='';addMsg('user',msg);callOllama(msg);};

  async function callOllama(userMsg){
    var model=(document.getElementById('aiModelSelect')||{value:'llama3.2'}).value||'llama3.2';
    _hist.push({role:'user',content:userMsg});
    var thinkEl=addMsgHtml('thinking','🤖 Thinking with '+escHtml(model)+'...');
    var btn=document.getElementById('aiSendBtn');if(btn)btn.disabled=true;
    var msgs=[{role:'system',content:SYSTEM},{role:'user',content:'Map context:\n'+getMapContext()},{role:'assistant',content:'Understood.'}].concat(_hist.slice(-10));
    try{
      var res=await fetch(OLLAMA+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:model,messages:msgs,stream:false,options:{temperature:0.3,num_predict:800}})});
      if(thinkEl)thinkEl.remove();
      if(!res.ok){var et='';try{var ed=await res.json();et=ed.error||res.statusText;}catch(e){et=res.statusText;}addMsgHtml('err','Ollama error '+res.status+': '+escHtml(et));_hist.pop();if(btn)btn.disabled=false;return;}
      var data=await res.json();
      var reply=(data.message&&data.message.content)?data.message.content:'';
      if(!reply){addMsgHtml('err','Empty response.');_hist.pop();if(btn)btn.disabled=false;return;}
      _hist.push({role:'assistant',content:reply});
      addMsg('bot',reply);
      _pending=null;
      var jsonMatch=reply.match(/```json\s*([\s\S]*?)```/);
      if(!jsonMatch){var fm=reply.match(/(\{[\s\S]*?"attribute"[\s\S]*?\})/);if(fm)jsonMatch=[null,fm[1]];}
      if(jsonMatch&&jsonMatch[1]){try{_pending=JSON.parse(jsonMatch[1].trim());var ab=document.getElementById('aiApplyBtn');if(ab)ab.style.display='block';}catch(e){console.warn('JSON parse:',e);_pending=null;}}
      else{var ab=document.getElementById('aiApplyBtn');if(ab)ab.style.display='none';}
    }catch(e){
      if(thinkEl)thinkEl.remove();
      var hint=e.message.indexOf('fetch')!==-1||e.message.indexOf('Failed')!==-1?'<br><small>Run: <code>OLLAMA_ORIGINS="*" ollama serve</code></small>':'';
      addMsgHtml('err','Network error: '+escHtml(e.message)+hint);_hist.pop();
    }
    if(btn)btn.disabled=false;
  }

  window.aiApplyStyle=function(){
    if(!_pending){addMsgHtml('err','No style to apply yet.');return;}
    if(!map){addMsgHtml('err','Map not ready.');return;}
    if(!currentDataset||!activeLayers[currentDataset]){addMsgHtml('err','Select a dataset first.');return;}
    var s=_pending;
    var attr=String(s.attribute||'').trim(),viz=String(s.viz||'choropleth').trim(),scheme=String(s.scheme||'blues').trim(),lAttr=String(s.labelAttr||'').trim(),lBg=String(s.labelBg||'white').trim();
    if(['choropleth','categorical','size'].indexOf(viz)===-1)viz='choropleth';
    if(['blues','reds','greens','viridis','rainbow'].indexOf(scheme)===-1)scheme='blues';
    var names=getAttributeNames(),matched='';
    for(var i=0;i<names.length;i++){if(names[i].toLowerCase()===attr.toLowerCase()){matched=names[i];break;}}
    if(!matched){for(var i=0;i<names.length;i++){if(names[i].toLowerCase().indexOf(attr.toLowerCase())===0){matched=names[i];break;}}}
    if(!matched){addMsgHtml('err','Attribute <strong>'+escHtml(attr)+'</strong> not found.<br>Available: <strong>'+escHtml(names.slice(0,8).join(', '))+'</strong>');_pending=null;return;}
    function syncSel(id,value){var el=document.getElementById(id);if(!el||!value)return;var low=value.toLowerCase();for(var i=0;i<el.options.length;i++){if(el.options[i].value===value||el.options[i].value.toLowerCase()===low){el.selectedIndex=i;return;}}}
    syncSel('attributeSelect',matched);syncSel('vizType',viz);syncSel('colorScheme',scheme);syncSel('labelSelect',lAttr);syncSel('labelBg',lBg);
    var sp=document.getElementById('stylePanel');if(sp&&!sp.classList.contains('visible'))sp.classList.add('visible');
    var stats=computeStats(matched,viz);if(!stats)stats=statsFromFeatures(matched,viz==='categorical');
    if(!stats){addMsgHtml('err','No stats for <strong>'+escHtml(matched)+'</strong>. Zoom in and try again.');_pending=null;return;}
    try{_dispatchStyle(matched,viz,stats,scheme);}catch(e){addMsgHtml('err','Style error: '+escHtml(e.message));_pending=null;return;}
    if(lAttr&&names.indexOf(lAttr)!==-1)applyLabels(lAttr,'12','#202124');
    addMsgHtml('info','Style applied: <strong>'+escHtml(matched)+'</strong> &middot; '+viz+' &middot; '+scheme+(s.reason?'<br><em>'+escHtml(String(s.reason))+'</em>':''));
    document.getElementById('aiApplyBtn').style.display='none';
    _pending=null;
  };
})();