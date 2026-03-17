// ── GLOBALS ───────────────────────────────────────────────────────────────
var map, currentDataset = null, allDatasets = [];
var currentGeometryType = null;
var currentAttributes   = [];
var activePopup         = null;
var urlUpdateTimer      = null;
var sourceLayer         = 'layer0';

var datasetListEl     = document.getElementById('datasetList');
var searchInput       = document.getElementById('searchInput');
var downloadAllBtn    = document.getElementById('downloadAllBtn');
var downloadViewBtn   = document.getElementById('downloadViewBtn');
var stylePanelEl      = document.getElementById('stylePanel');
var attributeSelect   = document.getElementById('attributeSelect');
var labelSelect       = document.getElementById('labelSelect');
var vizTypeSelect     = document.getElementById('vizType');
var colorSchemeSelect = document.getElementById('colorScheme');
var legendEl          = document.getElementById('legend');
var legendContentEl   = document.getElementById('legendContent');

// ── URL STATE ─────────────────────────────────────────────────────────────
function parseUrlState() {
  var params     = new URLSearchParams(window.location.search);
  var hashParams = new URLSearchParams(window.location.hash.slice(1));
  var dataset    = params.get('dataset') || null;
  var center = null, zoom = null;
  var cs = hashParams.get('center');
  if (cs) { var pts = cs.split(',').map(Number); if (pts.length===2 && !isNaN(pts[0])) center=[pts[1],pts[0]]; }
  var zs = hashParams.get('zoom');
  if (zs) zoom = parseFloat(zs);
  return { dataset:dataset, center:center, zoom:zoom };
}

function updateUrl() {
  if (!map) return;
  var c = map.getCenter(), z = map.getZoom();
  var search = currentDataset ? '?dataset='+encodeURIComponent(currentDataset) : '';
  var hash = 'center='+c.lat.toFixed(5)+','+c.lng.toFixed(5)+'&zoom='+z.toFixed(2);
  window.history.replaceState({}, '', window.location.pathname+search+'#'+hash);
}

function scheduleUrlUpdate() { clearTimeout(urlUpdateTimer); urlUpdateTimer=setTimeout(updateUrl,150); }

// ── METADATA ──────────────────────────────────────────────────────────────
var datasetMetadata = {
  'OSM2015/all_objects': { size:'91.6 GB', records:'264 m', geometry:'GEOMETRYCOLLECTION', desc:'All map objects in OpenStreetMap.' },
  'TIGER2018/COUNTY':   { size:'2.3 GB',  records:'3142',  geometry:'POLYGON',    desc:'US County boundaries from TIGER 2018.' },
  'TIGER2018/POINTLM':  { size:'1.8 GB',  records:'100 k', geometry:'POINT',      desc:'Point landmarks: schools, hospitals, airports.' },
  'TIGER2018/ROADS':    { size:'45 GB',   records:'22 m',  geometry:'LINESTRING', desc:'US Road network from TIGER 2018.' }
};

var datasetAttributes = {
  'TIGER2018/COUNTY':  ['ALAND','AWATER','STATEFP','NAME'],
  'TIGER2018/POINTLM': ['MTFCC','NAME'],
  'TIGER2018/ROADS':   ['MTFCC','RTTYP','FULLNAME']
};

// ── LOAD ATTRIBUTES ───────────────────────────────────────────────────────
async function loadAttributes(dataset) {
  try {
    var res = await fetch('/api/datasets/'+encodeURIComponent(dataset)+'/stats');
    if (!res.ok) throw new Error('not found');
    var data = await res.json();
    currentAttributes = Array.isArray(data.attributes) ? data.attributes.filter(function(a){return a.name!=='geometry';}) : [];
    return true;
  } catch(e) { currentAttributes=[]; return false; }
}

// ── LOAD DATASETS ─────────────────────────────────────────────────────────
async function loadDatasets() {
  try {
    var res  = await fetch('/api/datasets');
    var data = await res.json();
    allDatasets = data.datasets || [];
    document.getElementById('datasetCount').textContent = allDatasets.length;
    renderDatasetList();
  } catch(e) {
    datasetListEl.innerHTML = '<div style="padding:40px 20px;color:#d93025;text-align:center;">Server offline</div>';
  }
}

function renderDatasetList(filter) {
  filter = filter || '';
  var filtered = allDatasets.filter(function(d){ return d.toLowerCase().indexOf(filter.toLowerCase())!==-1; });
  if (!filtered.length) { datasetListEl.innerHTML='<div style="padding:40px 20px;color:#9aa0a6;text-align:center;">No datasets found</div>'; return; }
  datasetListEl.innerHTML = filtered.map(function(d){
    return '<div class="dataset-item'+(d===currentDataset?' active':'')+'" onclick="selectDataset(\''+d+'\')">'+d+'</div>';
  }).join('');
}

// ── SELECT DATASET ────────────────────────────────────────────────────────
async function selectDataset(dataset) {
  currentDataset = dataset; _labelAttr = null;
  renderDatasetList(searchInput.value);
  updateDetailPanel();
  await loadAttributes(dataset);
  populateAttributeSelect(); populateLabelSelect();
  await loadMap(); updateUrl();
}

// ── DETAIL PANEL ──────────────────────────────────────────────────────────
function updateDetailPanel() {
  var has = !!currentDataset;
  downloadAllBtn.disabled = downloadViewBtn.disabled = !has;
  downloadAllBtn.textContent = 'Download All';
  downloadViewBtn.textContent = 'Current View';
  if (!has) {
    document.getElementById('detailTitle').textContent = 'Select a dataset';
    document.getElementById('detailSize').textContent = document.getElementById('detailRecords').textContent = document.getElementById('detailGeometry').textContent = '-';
    document.getElementById('detailDesc').style.display = 'none'; return;
  }
  var meta = datasetMetadata[currentDataset] || { size:'-', records:'-', geometry:getGeometryType(currentDataset), desc:'Vector tile dataset' };
  document.getElementById('detailTitle').textContent    = currentDataset;
  document.getElementById('detailSize').textContent     = meta.size;
  document.getElementById('detailRecords').textContent  = meta.records;
  document.getElementById('detailGeometry').textContent = meta.geometry;
  document.getElementById('detailDesc').textContent     = meta.desc;
  document.getElementById('detailDesc').style.display   = 'block';
}

function getGeometryType(name) {
  if (name.indexOf('COUNTY')!==-1||name.indexOf('PLACE')!==-1) return 'POLYGON';
  if (name.indexOf('POINT')!==-1) return 'POINT';
  if (name.indexOf('ROAD')!==-1||name.indexOf('EDGES')!==-1) return 'LINESTRING';
  return 'GEOMETRY';
}

function clearFilters() {
  currentDataset=null; currentAttributes=[]; searchInput.value='';
  window.history.replaceState({},'',window.location.pathname+window.location.hash);
  renderDatasetList(); updateDetailPanel(); populateAttributeSelect(); populateLabelSelect(); resetLegend(); loadMap();
}

// ── DOWNLOAD ──────────────────────────────────────────────────────────────
function downloadDataset(mode) {
  if (!currentDataset) return;
  var enc = encodeURIComponent(currentDataset), url;
  if (mode==='viewport'&&map) {
    var b=map.getBounds();
    url='/datasets/'+enc+'/features.geojson?mbr='+b.getWest().toFixed(6)+','+b.getSouth().toFixed(6)+','+b.getEast().toFixed(6)+','+b.getNorth().toFixed(6);
  } else { url='/datasets/'+enc+'/features.geojson'; }
  var btn=mode==='viewport'?downloadViewBtn:downloadAllBtn, orig=btn.textContent;
  btn.disabled=true; btn.textContent='⏳ Preparing...';
  var a=document.createElement('a'); a.href=url; a.download=currentDataset.replace(/\//g,'_')+(mode==='viewport'?'_view':'_full')+'.geojson';
  a.style.display='none'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){btn.textContent=orig;btn.disabled=false;},2500);
}

// ── MAP ───────────────────────────────────────────────────────────────────
async function loadMap(initialCenter, initialZoom) {
  if (activePopup) { activePopup.remove(); activePopup=null; }
  var dc = initialCenter||[-98,39], dz = initialZoom||4;
  if (!currentDataset) {
    _detachLabelRenderer();
    if (map) { map.remove(); map=null; }
    map = new maplibregl.Map({
      container:'map',
      style:{ version:8, sources:{ basemap:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256} }, layers:[{id:'basemap',type:'raster',source:'basemap'}] },
      center:dc, zoom:dz
    });
    attachMapEvents(); currentGeometryType=null; return;
  }
  var tileUrl='http://127.0.0.1:5000/'+currentDataset+'/{z}/{x}/{y}.mvt';
  var isPoint=currentDataset.indexOf('POINTLM')!==-1||currentDataset.indexOf('POINT')!==-1;
  var isRoad =currentDataset.indexOf('ROAD')!==-1||currentDataset.indexOf('EDGES')!==-1;
  currentGeometryType = isPoint?'point':isRoad?'line':'polygon';
  sourceLayer='layer0';
  try { var m=await fetch('/api/datasets/'+encodeURIComponent(currentDataset)+'/stats'); if (m.ok){var d=await m.json();if(d.source_layer)sourceLayer=d.source_layer;} } catch(e){}
  var layers=[
    {id:'basemap',type:'raster',source:'basemap'},
    {id:'fill',   type:'fill',  source:'local','source-layer':sourceLayer, filter:['any',['==',['geometry-type'],'Polygon'],['==',['geometry-type'],'MultiPolygon']], paint:{'fill-color':'#4285f4','fill-opacity':0.5}},
    {id:'outline',type:'line',  source:'local','source-layer':sourceLayer, filter:['any',['==',['geometry-type'],'Polygon'],['==',['geometry-type'],'MultiPolygon']], paint:{'line-color':'#1a73e8','line-width':1}},
    {id:'points', type:'circle',source:'local','source-layer':sourceLayer, filter:['==',['geometry-type'],'Point'],      paint:{'circle-radius':5,'circle-color':'#ea4335','circle-stroke-width':1,'circle-stroke-color':'#fff'}},
    {id:'lines',  type:'line',  source:'local','source-layer':sourceLayer, filter:['==',['geometry-type'],'LineString'], paint:{'line-color':'#34a853','line-width':3}}
  ];
  _detachLabelRenderer();
  if (map) { map.remove(); map=null; }
  map = new maplibregl.Map({
    container:'map',
    style:{ version:8, sources:{ basemap:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256}, local:{type:'vector',tiles:[tileUrl],minzoom:0,maxzoom:14} }, layers:layers },
    center:dc, zoom:dz
  });
  map.on('load',function(){ populateAttributeSelect(); populateLabelSelect(); resetToDefaultStyle(); resetLegend(); attachClickHandlers(); });
  attachMapEvents();
}

function attachMapEvents() {
  if (!map) return;
  map.on('moveend',scheduleUrlUpdate); map.on('zoomend',scheduleUrlUpdate);
}

// ── CLICK POPUP ───────────────────────────────────────────────────────────
var CLICKABLE_LAYERS=['fill','points','lines'];

function attachClickHandlers() {
  if (!map) return;
  CLICKABLE_LAYERS.forEach(function(l){
    if (!map.getLayer(l)) return;
    map.on('mouseenter',l,function(){map.getCanvas().style.cursor='pointer';});
    map.on('mouseleave',l,function(){map.getCanvas().style.cursor='';});
  });
  map.on('click',function(e){
    var avail=CLICKABLE_LAYERS.filter(function(l){return map.getLayer(l);});
    var features=map.queryRenderedFeatures(e.point,{layers:avail});
    if (!features||!features.length) return;
    var props=features[0].properties;
    if (!props||!Object.keys(props).length) return;
    var rows=Object.entries(props).filter(function(kv){return kv[0]!=='geometry'&&kv[0].indexOf('_')!==0;}).slice(0,30);
    if (!rows.length) return;
    var body=rows.map(function(kv){
      return '<div class="popup-row"><span class="popup-key" title="'+kv[0]+'">'+kv[0]+'</span><span class="popup-val">'+(kv[1]!=null?kv[1]:'<em style="opacity:.5">null</em>')+'</span></div>';
    }).join('');
    var html='<div class="popup-header">📍 Feature Properties</div><div class="popup-body">'+body+'</div>';
    if (activePopup) activePopup.remove();
    activePopup=new maplibregl.Popup({maxWidth:'340px',closeButton:true}).setLngLat(e.lngLat).setHTML(html).addTo(map);
  });
}

// ── STYLE PANEL ───────────────────────────────────────────────────────────
function toggleStylePanel() {
  if (!currentDataset){alert('Select a dataset first');return;}
  stylePanelEl.classList.toggle('visible');
}

function getAttributeNames() {
  if (currentAttributes.length) return currentAttributes.map(function(a){return a.name;});
  return datasetAttributes[currentDataset]||[];
}

function populateAttributeSelect() {
  if (!attributeSelect) return;
  attributeSelect.innerHTML='<option value="">Default style</option>';
  if (!currentDataset) return;
  if (currentAttributes.length) {
    currentAttributes.forEach(function(attr){
      var o=document.createElement('option'); o.value=attr.name;
      var c=attr.stats&&attr.stats.non_null_count;
      o.textContent=c?attr.name+' ('+c.toLocaleString()+' vals)':attr.name;
      attributeSelect.appendChild(o);
    });
  } else {
    (datasetAttributes[currentDataset]||[]).forEach(function(a){var o=document.createElement('option');o.value=a;o.textContent=a;attributeSelect.appendChild(o);});
  }
}

function populateLabelSelect() {
  if (!labelSelect) return;
  labelSelect.innerHTML='<option value="">No labels</option>';
  if (!currentDataset) return;
  getAttributeNames().forEach(function(n){var o=document.createElement('option');o.value=n;o.textContent=n;labelSelect.appendChild(o);});
}

function resetToDefaultStyle() {
  if (!map||!currentDataset) return;
  try {
    if (map.getLayer('fill'))    {map.setPaintProperty('fill','fill-color','#4285f4');map.setPaintProperty('fill','fill-opacity',0.5);}
    if (map.getLayer('outline')) {map.setPaintProperty('outline','line-color','#1a73e8');map.setPaintProperty('outline','line-width',1);}
    if (map.getLayer('points'))  {map.setPaintProperty('points','circle-color','#ea4335');map.setPaintProperty('points','circle-radius',5);}
    if (map.getLayer('lines'))   {map.setPaintProperty('lines','line-color','#34a853');map.setPaintProperty('lines','line-width',3);}
  } catch(e){}
}

function resetLegend() { if (legendEl){legendEl.classList.remove('visible');legendContentEl.innerHTML='';} }

// ── CANVAS LABELS ─────────────────────────────────────────────────────────
var _labelAttr=null, _labelSize=12, _labelColor='#202124', _labelFrame=null;
var _lcanvas=document.getElementById('label-canvas');
var _lctx=_lcanvas?_lcanvas.getContext('2d'):null;

function _resizeLabelCanvas() {
  if (!_lcanvas) return;
  var el=document.getElementById('map');
  _lcanvas.width=el.offsetWidth; _lcanvas.height=el.offsetHeight;
}

function _clearLabels() { if (_lctx&&_lcanvas) _lctx.clearRect(0,0,_lcanvas.width,_lcanvas.height); }

function _renderLabels() {
  _labelFrame=null;
  if (!_lctx||!_lcanvas||!map||!_labelAttr){_clearLabels();return;}
  var mze=document.getElementById('labelMinZoom'), mz=mze?parseFloat(mze.value):0;
  if (map.getZoom()<mz){_clearLabels();return;}
  _resizeLabelCanvas(); _clearLabels();
  var W=_lcanvas.width, H=_lcanvas.height;
  var al=['fill','points','lines'].filter(function(l){try{return map.getLayer(l);}catch(e){return false;}});
  if (!al.length) return;
  var features; try{features=map.queryRenderedFeatures({layers:al});}catch(e){return;}
  if (!features||!features.length) return;
  var zs=Math.max(0.7,Math.min(2.0,0.5+map.getZoom()/12));
  var fs=Math.round(_labelSize*zs);
  var bge=document.getElementById('labelBg'), bgMode=bge?bge.value:'white';
  var ctx=_lctx;
  ctx.font='600 '+fs+'px system-ui,-apple-system,sans-serif';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  var seen={}, candidates=[];
  for (var i=0;i<features.length;i++) {
    var f=features[i];
    var fid=f.id!=null?String(f.id):JSON.stringify(f.properties).slice(0,60);
    if (seen[fid]) continue; seen[fid]=true;
    var val=f.properties&&f.properties[_labelAttr];
    if (val===null||val===undefined||val==='') continue;
    var text=String(val), px, py;
    try {
      var g=f.geometry, coord;
      if (g.type==='Point') { coord=g.coordinates; }
      else if (g.type==='Polygon') {
        var ring=g.coordinates[0], sx=0, sy=0;
        for (var j=0;j<ring.length;j++){sx+=ring[j][0];sy+=ring[j][1];}
        coord=[sx/ring.length,sy/ring.length];
      } else if (g.type==='MultiPolygon') {
        var best=null, bestLen=0;
        for (var p=0;p<g.coordinates.length;p++){if(g.coordinates[p][0].length>bestLen){bestLen=g.coordinates[p][0].length;best=g.coordinates[p][0];}}
        if (!best) continue;
        var sx=0,sy=0; for (var j=0;j<best.length;j++){sx+=best[j][0];sy+=best[j][1];}
        coord=[sx/best.length,sy/best.length];
      } else if (g.type==='LineString') {
        coord=g.coordinates[Math.floor(g.coordinates.length/2)];
      } else if (g.type==='MultiLineString') {
        var line=g.coordinates[0]; coord=line[Math.floor(line.length/2)];
      } else { continue; }
      var pt=map.project(coord); px=pt.x; py=pt.y;
    } catch(e){continue;}
    if (px<0||py<0||px>W||py>H) continue;
    var tw=ctx.measureText(text).width;
    candidates.push({text:text,px:px,py:py,tw:tw,th:fs});
  }
  candidates.sort(function(a,b){return b.text.length-a.text.length;});
  var PAD=4, placed=[];
  function overlaps(bx,by,bw,bh){
    var x1=bx-bw/2-PAD,x2=bx+bw/2+PAD,y1=by-bh/2-PAD,y2=by+bh/2+PAD;
    for (var k=0;k<placed.length;k++){var p=placed[k];if(!(x2<p.x1||x1>p.x2||y2<p.y1||y1>p.y2))return true;}
    return false;
  }
  for (var i=0;i<candidates.length;i++) {
    var c=candidates[i], tx=c.px, ty=c.py, tw=c.tw, th=c.th, text=c.text;
    if (overlaps(tx,ty,tw,th)) continue;
    placed.push({x1:tx-tw/2-PAD,x2:tx+tw/2+PAD,y1:ty-th/2-PAD,y2:ty+th/2+PAD});
    if (bgMode!=='none') {
      var bx=tx-tw/2-4, by=ty-th/2-3, bw=tw+8, bh=th+6, r=bh/2;
      var fill=bgMode==='white'?'rgba(255,255,255,0.88)':bgMode==='dark'?'rgba(20,20,20,0.78)':_labelColor+'30';
      ctx.beginPath();
      ctx.moveTo(bx+r,by); ctx.lineTo(bx+bw-r,by); ctx.arcTo(bx+bw,by,bx+bw,by+bh,r);
      ctx.lineTo(bx+bw,by+bh-r); ctx.arcTo(bx+bw,by+bh,bx+bw-r,by+bh,r);
      ctx.lineTo(bx+r,by+bh); ctx.arcTo(bx,by+bh,bx,by+bh-r,r);
      ctx.lineTo(bx,by+r); ctx.arcTo(bx,by,bx+r,by,r); ctx.closePath();
      ctx.fillStyle=fill; ctx.fill();
      ctx.strokeStyle=bgMode==='dark'?'rgba(255,255,255,0.12)':'rgba(0,0,0,0.07)';
      ctx.lineWidth=0.5; ctx.stroke();
    } else {
      ctx.strokeStyle='rgba(255,255,255,0.92)'; ctx.lineWidth=3; ctx.strokeText(text,tx,ty);
    }
    ctx.fillStyle=bgMode==='dark'?'#ffffff':_labelColor;
    ctx.fillText(text,tx,ty);
  }
}

function _scheduleRender(){if(!_labelFrame)_labelFrame=requestAnimationFrame(_renderLabels);}

function applyLabels(attr,fontSize,color){
  _labelAttr=attr||null; _labelSize=parseInt(fontSize)||12; _labelColor=color||'#202124';
  if (!_labelAttr){_clearLabels();return;}
  _scheduleRender();
  if (map&&!map._labelsBound){
    map._labelsBound=true;
    map.on('render',_scheduleRender); map.on('zoomend',_scheduleRender);
  }
}

function _detachLabelRenderer(){
  if (map&&map._labelsBound){map.off('render',_scheduleRender);map.off('zoomend',_scheduleRender);map._labelsBound=false;}
  _clearLabels(); _labelAttr=null;
}

// ── APPLY STYLE ───────────────────────────────────────────────────────────
function applyStyle(){
  if (!map||!currentDataset) return;
  var attr=attributeSelect.value, viz=vizTypeSelect.value, scheme=colorSchemeSelect.value;
  var lAttr=labelSelect.value, lSize=document.getElementById('labelSize').value;
  var lColor=document.getElementById('labelColor').value;
  if (!attr){resetToDefaultStyle();resetLegend();}
  else {
    var stats=viz==='categorical'?getAttributeStats(attr,{forceCategorical:true}):getAttributeStats(attr);
    if (!stats){alert('No data available for that attribute.');return;}
    try {
      if      (currentGeometryType==='polygon') _applyPolygonStyle(attr,viz,stats,scheme);
      else if (currentGeometryType==='point')   _applyPointStyle(attr,viz,stats,scheme);
      else if (currentGeometryType==='line')    _applyLineStyle(attr,viz,stats,scheme);
    } catch(e){console.error(e);alert('Error applying style.');}
  }
  applyLabels(lAttr,lSize,lColor);
}

function _applyPolygonStyle(attr,viz,stats,scheme){
  if (!map.getLayer('fill')) return;
  if (viz==='choropleth'){
    var e=buildChoroplethExpression(attr,stats,scheme); if(!e)return;
    map.setPaintProperty('fill','fill-color',e); map.setPaintProperty('fill','fill-opacity',0.8);
    if(map.getLayer('outline')){map.setPaintProperty('outline','line-color',e);map.setPaintProperty('outline','line-width',1);}
    updateLegendChoropleth(attr,stats,scheme);
  } else if (viz==='categorical'){
    var e=buildCategoricalExpression(attr,stats,scheme); if(!e)return;
    map.setPaintProperty('fill','fill-color',e); map.setPaintProperty('fill','fill-opacity',0.8);
    if(map.getLayer('outline')){map.setPaintProperty('outline','line-color',e);map.setPaintProperty('outline','line-width',1);}
    updateLegendCategorical(attr,stats,scheme);
  } else {
    map.setPaintProperty('fill','fill-opacity',['interpolate',['linear'],['to-number',['get',attr]],stats.min,0.3,stats.max,0.9]);
    var ce=buildChoroplethExpression(attr,stats,scheme);
    if(ce&&map.getLayer('outline'))map.setPaintProperty('outline','line-color',ce);
    updateLegendChoropleth(attr,stats,scheme);
  }
}

function _applyPointStyle(attr,viz,stats,scheme){
  if (!map.getLayer('points')) return;
  if (viz==='size'){var e=buildSizeExpression(attr,stats,5);if(!e)return;map.setPaintProperty('points','circle-radius',e);updateLegendChoropleth(attr,stats,scheme);}
  else {var isCat=viz==='categorical',e=isCat?buildCategoricalExpression(attr,stats,scheme):buildChoroplethExpression(attr,stats,scheme);if(!e)return;map.setPaintProperty('points','circle-color',e);isCat?updateLegendCategorical(attr,stats,scheme):updateLegendChoropleth(attr,stats,scheme);}
}

function _applyLineStyle(attr,viz,stats,scheme){
  if (!map.getLayer('lines')) return;
  if (viz==='size'){var e=buildSizeExpression(attr,stats,3);if(!e)return;map.setPaintProperty('lines','line-width',e);updateLegendChoropleth(attr,stats,scheme);}
  else {var isCat=viz==='categorical',e=isCat?buildCategoricalExpression(attr,stats,scheme):buildChoroplethExpression(attr,stats,scheme);if(!e)return;map.setPaintProperty('lines','line-color',e);isCat?updateLegendCategorical(attr,stats,scheme):updateLegendChoropleth(attr,stats,scheme);}
}

// ── STATS ─────────────────────────────────────────────────────────────────
function getAttributeStats(attrName,opts){
  opts=opts||{}; var fc=opts.forceCategorical||false, attr=null;
  for (var i=0;i<currentAttributes.length;i++){if(currentAttributes[i].name===attrName){attr=currentAttributes[i];break;}}
  if (!attr||!attr.stats) return null;
  var stats=attr.stats, topK=stats.top_k||[];
  if (fc) return {min:null,max:null,count:stats.non_null_count!=null?stats.non_null_count:topK.length,categories:topK.map(function(t){return String(t.value);}).slice(0,8)};
  var fv=topK.length?String(topK[0].value):'', isNum=/^\d+(\.\d+)?$/.test(fv);
  if (isNum){var vals=topK.map(function(t){return parseFloat(t.value);}).filter(function(v){return !isNaN(v);});if(!vals.length)return null;return {min:Math.min.apply(null,vals),max:Math.max.apply(null,vals),count:stats.non_null_count!=null?stats.non_null_count:vals.length,categories:[]};}
  return {min:null,max:null,count:stats.non_null_count!=null?stats.non_null_count:topK.length,categories:topK.map(function(t){return String(t.value);}).slice(0,8)};
}

function getColorRamp(scheme){
  var r={reds:['#fee5d9','#fcae91','#fb6a4a','#de2d26','#a50f15'],greens:['#e5f5e0','#a1d99b','#74c476','#31a354','#006d2c'],viridis:['#440154','#414487','#2a788e','#22a884','#7ad151'],rainbow:['#440154','#3b528b','#21918c','#5ec962','#fde725'],blues:['#eff3ff','#bdd7e7','#6baed6','#3182bd','#08519c']};
  return r[scheme]||r.blues;
}

function buildChoroplethExpression(attr,stats,scheme){
  var c=getColorRamp(scheme),mn=stats.min,mx=stats.max;
  if(!isFinite(mn)||!isFinite(mx)||mn===mx)return null;
  var s=(mx-mn)/4;
  return ['interpolate',['linear'],['to-number',['get',attr]],mn,c[0],mn+s,c[1],mn+2*s,c[2],mn+3*s,c[3],mx,c[4]];
}

function buildSizeExpression(attr,stats,base){
  var mn=stats.min,mx=stats.max; if(!isFinite(mn)||!isFinite(mx)||mn===mx)return null;
  return ['interpolate',['linear'],['to-number',['get',attr]],mn,base*0.6,mx,base*2.2];
}

function buildCategoricalExpression(attr,stats,scheme){
  var c=getColorRamp(scheme),cats=stats.categories||[]; if(!cats.length)return null;
  var e=['match',['get',attr]]; cats.forEach(function(x,i){e.push(x,c[i%c.length]);}); e.push('#d3d3d3'); return e;
}

function updateLegendChoropleth(attr,stats,scheme){
  legendContentEl.innerHTML=''; var c=getColorRamp(scheme),mn=stats.min,mx=stats.max,s=(mx-mn)/4;
  [mn,mn+s,mn+2*s,mn+3*s,mx].forEach(function(v,i){
    var el=document.createElement('div'); el.className='legend-item';
    el.innerHTML='<div class="legend-color" style="background:'+c[i]+'"></div><span>'+v.toFixed(2)+'</span>';
    legendContentEl.appendChild(el);
  });
  legendEl.classList.add('visible'); legendEl.querySelector('.legend-title').textContent=attr;
}

function updateLegendCategorical(attr,stats,scheme){
  legendContentEl.innerHTML=''; var c=getColorRamp(scheme);
  (stats.categories||[]).forEach(function(x,i){
    var el=document.createElement('div'); el.className='legend-item';
    el.innerHTML='<div class="legend-color" style="background:'+c[i%c.length]+'"></div><span>'+x+'</span>';
    legendContentEl.appendChild(el);
  });
  legendEl.classList.add('visible'); legendEl.querySelector('.legend-title').textContent=attr;
}

// ── INIT ──────────────────────────────────────────────────────────────────
searchInput.addEventListener('input',function(e){renderDatasetList(e.target.value);});
document.getElementById('zoomIn').onclick  = function(){if(map)map.zoomIn();};
document.getElementById('zoomOut').onclick = function(){if(map)map.zoomOut();};

window.addEventListener('load', async function(){
  loadDatasets();
  var state=parseUrlState();
  if (state.dataset){
    currentDataset=state.dataset; updateDetailPanel();
    await loadAttributes(state.dataset); populateAttributeSelect(); populateLabelSelect();
  }
  await loadMap(state.center,state.zoom);
});

var gotoInput=document.getElementById('gotoInput'), gotoBtn=document.getElementById('gotoBtn');
function goToLocation(){
  var input=gotoInput.value.trim(); if(!input)return;
  var m=input.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m){var la=parseFloat(m[1]),ln=parseFloat(m[2]);if(la>=-90&&la<=90&&ln>=-180&&ln<=180){if(map)map.flyTo({center:[ln,la],zoom:12});gotoInput.value='';return;}}
  fetch('https://nominatim.openstreetmap.org/search?format=json&q='+encodeURIComponent(input))
    .then(function(r){return r.json();})
    .then(function(d){if(d&&d.length){if(map)map.flyTo({center:[parseFloat(d[0].lon),parseFloat(d[0].lat)],zoom:12});gotoInput.value='';}else alert('Location not found');})
    .catch(function(e){alert('Error searching location');});
}
gotoBtn.addEventListener('click',goToLocation);
gotoInput.addEventListener('keypress',function(e){if(e.key==='Enter')goToLocation();});

var darkToggle=document.getElementById('darkToggle');
if (localStorage.getItem('ucrstar-dark-mode')==='on'){document.body.classList.add('dark');darkToggle.innerHTML='☀️';}
darkToggle.addEventListener('click',function(){
  var d=document.body.classList.toggle('dark');
  darkToggle.innerHTML=d?'☀️':'🌙';
  localStorage.setItem('ucrstar-dark-mode',d?'on':'off');
});

window.selectDataset=selectDataset; window.clearFilters=clearFilters;
window.toggleStylePanel=toggleStylePanel; window.applyStyle=applyStyle;
window.downloadDataset=downloadDataset;

// ═══════════════════════════════════════════════════════════════════════════
// OLLAMA AI STYLE ASSISTANT
// ═══════════════════════════════════════════════════════════════════════════
(function(){
  var OLLAMA  = 'http://localhost:11434';
  var _hist   = [];
  var _pending= null;

  function ping() {
    fetch(OLLAMA+'/api/tags')
      .then(function(r){
        var dot=document.getElementById('aiStatusDot');
        if (r.ok) {
          dot.className='ai-status-dot ok'; dot.title='Ollama is running';
          return r.json().then(function(data){
            if (!data.models||!data.models.length) return;
            var sel=document.getElementById('aiModelSelect');
            sel.innerHTML='';
            data.models.forEach(function(m){
              var o=document.createElement('option'); o.value=m.name; o.textContent=m.name; sel.appendChild(o);
            });
          });
        } else {
          dot.className='ai-status-dot err'; dot.title='Ollama not responding ('+r.status+')';
        }
      })
      .catch(function(){
        var dot=document.getElementById('aiStatusDot');
        if (dot){dot.className='ai-status-dot err';dot.title='Ollama not found at localhost:11434';}
      });
  }

  window.aiToggle=function(){
    var p=document.getElementById('aiPanel');
    var wasOpen=p.classList.contains('open');
    p.classList.toggle('open');
    if (!wasOpen) ping();
  };
  document.getElementById('aiFab').addEventListener('click',aiToggle);
  document.getElementById('aiIn').addEventListener('keydown',function(e){if(e.key==='Enter')aiSend();});

  function addMsg(type,content){
    var box=document.getElementById('aiMsgs');
    if (!box) return null;
    var el=document.createElement('div');
    el.className='ai-msg '+type;
    var safe=content
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/```json([\s\S]*?)```/g,'<pre>$1</pre>')
      .replace(/```([\s\S]*?)```/g,'<pre>$1</pre>')
      .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
      .replace(/`([^`]+)`/g,'<code>$1</code>')
      .replace(/\n/g,'<br>');
    el.innerHTML=safe;
    box.appendChild(el); box.scrollTop=box.scrollHeight;
    return el;
  }

  function getCtx(){
    if (!currentDataset) return 'No dataset selected.';
    var ctx='Dataset: '+currentDataset+'\n';
    ctx+='Geometry type: '+(currentGeometryType||'unknown')+'\n';
    ctx+='Attributes: '+getAttributeNames().join(', ')+'\n';
    if (currentAttributes&&currentAttributes.length){
      ctx+='Attribute details:\n';
      currentAttributes.slice(0,8).forEach(function(a){
        if (!a.stats) return;
        var top=(a.stats.top_k||[]).slice(0,5).map(function(t){return String(t.value);}).join(', ');
        ctx+='  - '+a.name+': '+(a.stats.non_null_count||'?')+' non-null values. Top: '+top+'\n';
      });
    }
    try {
      var avail=['fill','points','lines'].filter(function(l){return map&&map.getLayer(l);});
      if (avail.length&&map){
        var feats=map.queryRenderedFeatures({layers:avail});
        if (feats&&feats.length){
          ctx+='Sample feature properties: '+JSON.stringify(feats[0].properties).slice(0,400)+'\n';
          ctx+='Approx. visible features: '+feats.length+'\n';
        }
      }
    } catch(e){}
    return ctx;
  }

  var SYSTEM=[
    'You are an expert GIS data visualization assistant integrated into UCR-STAR,',
    'a vector tile map viewer built with MapLibre GL JS.',
    'You help users understand spatial datasets and design effective map styles.',
    '',
    'When the user asks for a style, ALWAYS include this exact JSON block:',
    '```json',
    '{',
    '  "attribute": "<attr_name>",',
    '  "viz": "choropleth",',
    '  "scheme": "blues",',
    '  "labelAttr": "",',
    '  "labelBg": "white",',
    '  "reason": "short sentence"',
    '}',
    '```',
    'Valid values for viz: choropleth, categorical, size',
    'Valid values for scheme: blues, reds, greens, viridis, rainbow',
    'Valid values for labelBg: white, dark, color, none',
    '',
    'Answer in English. At most 4 sentences outside the JSON.',
    'Only include the JSON when the user asks for or needs a style.',
    'If the user only asks about the data, answer without JSON.'
  ].join('\n');

  var QUICK={
    describe:'What kind of data does this dataset contain? What patterns or insights might an analyst find?',
    suggest: 'What is the best way to visualize this dataset? Suggest attribute, viz type, and color scheme. Include the JSON.',
    best:    'Which numeric attribute would make the best choropleth map and why? Provide the JSON.',
    insight: 'Analyze the features currently visible on the map. What do the attribute values tell us about this area?',
    anomaly: 'Are there any outliers or anomalies in the visible data? Describe what you find.'
  };

  window.aiQuick=function(type){
    if (!currentDataset){addMsg('info','Please select a dataset from the list first.');return;}
    var p=QUICK[type]||type; addMsg('user',p); callOllama(p);
  };

  window.aiSend=function(){
    var el=document.getElementById('aiIn'), msg=el?el.value.trim():'';
    if (!msg) return; el.value=''; addMsg('user',msg); callOllama(msg);
  };

  async function callOllama(userMsg){
    var model=(document.getElementById('aiModelSelect')||{}).value||'llama3.2';
    _hist.push({role:'user',content:userMsg});
    var thinkEl=addMsg('thinking','🤖 Thinking with '+model+'...');
    var btn=document.getElementById('aiSendBtn');
    if (btn) btn.disabled=true;

    var msgs=[
      {role:'system',  content:SYSTEM},
      {role:'user',    content:'Current map context:\n'+getCtx()},
      {role:'assistant',content:'Understood, ready to help.'}
    ].concat(_hist.slice(-10));

    try {
      var res=await fetch(OLLAMA+'/api/chat',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          model:model,
          messages:msgs,
          stream:false,
          options:{temperature:0.3, num_predict:800}
        })
      });

      if (thinkEl) thinkEl.remove();

      if (!res.ok){
        var et=''; try{var ed=await res.json();et=ed.error||res.statusText;}catch(e){et=res.statusText;}
        addMsg('err','Ollama error '+res.status+': '+et+'<br><small>Is <code>ollama serve</code> running?</small>');
        _hist.pop(); if (btn) btn.disabled=false; return;
      }

      var data=await res.json();
      var reply=(data.message&&data.message.content)?data.message.content:'';
      if (!reply){addMsg('err','Empty response. Try a different model.');_hist.pop();if(btn)btn.disabled=false;return;}

      _hist.push({role:'assistant',content:reply});
      addMsg('bot',reply);

      var raw=reply.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
      var m=raw.match(/```json([\s\S]*?)```/);
      if (m){
        try{
          _pending=JSON.parse(m[1].trim());
          var ab=document.getElementById('aiApplyBtn');
          if (ab) ab.style.display='block';
        } catch(e){_pending=null;console.warn('AI: JSON parse error',e);}
      } else {
        _pending=null;
        var ab=document.getElementById('aiApplyBtn');
        if (ab) ab.style.display='none';
      }

    } catch(e){
      if (thinkEl) thinkEl.remove();
      var hint=e.message.indexOf('fetch')!==-1||e.message.indexOf('NetworkError')!==-1
        ?'<br><small>Make sure Ollama is running: <code>ollama serve</code><br>'+
         'If you see a CORS error: <code>OLLAMA_ORIGINS="*" ollama serve</code></small>':'';
      addMsg('err','Network error: '+e.message+hint);
      _hist.pop();
    }
    if (btn) btn.disabled=false;
  }

  window.aiApplyStyle=function(){
    if (!_pending||!map||!currentDataset) return;
    var s=_pending;
    function sel(id,val){
      if (val===undefined||val===null) return;
      var el=document.getElementById(id); if(!el)return;
      var str=String(val);
      for (var i=0;i<el.options.length;i++){if(el.options[i].value===str){el.selectedIndex=i;return;}}
      for (var i=0;i<el.options.length;i++){if(el.options[i].value.indexOf(str)===0){el.selectedIndex=i;return;}}
    }
    sel('attributeSelect',s.attribute||'');
    sel('vizType',        s.viz||'choropleth');
    sel('colorScheme',    s.scheme||'blues');
    sel('labelSelect',    s.labelAttr||'');
    sel('labelBg',        s.labelBg||'white');
    applyStyle();
    addMsg('info','✓ Style applied! Fine-tune it in the 🎨 panel.');
    var ab=document.getElementById('aiApplyBtn');
    if (ab) ab.style.display='none';
    _pending=null;
  };

})();