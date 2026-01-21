const TOTAL_SAT_51_120 = 1415;
function normalizeSostenimiento(v){
  return (v ?? "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().toUpperCase();
}
function isFiscalOnly(v){
  const s = normalizeSostenimiento(v);
  if (!s) return false;
  // Acepta 'FISCAL' y variantes, excluye 'FISCOMISIONAL'
  if (s.includes("FISCOMISIONAL")) return false;
  return s.includes("FISCAL");
}

function getSostenimientoStyle(sostenimiento, opts = {}){
  // Colores solicitados:
  // Fiscal: rojo | Fiscomisional: verde | Municipal: amarillo | Particular: negro | Excluidos (1–50): azul
  const excluded = !!opts.excluded;
  if (excluded) {
    return { fill: '#2563eb', stroke: '#0b1220' }; // azul
  }
  const s = normalizeSostenimiento(sostenimiento);
  if (s.includes('FISCOMISIONAL')) return { fill: '#22c55e', stroke: '#064e3b' };
  if (s.includes('MUNICIPAL')) return { fill: '#facc15', stroke: '#713f12' };
  if (s.includes('PARTICULAR')) return { fill: '#111827', stroke: '#e5e7eb' };
  if (s.includes('FISCAL')) return { fill: '#f85149', stroke: '#7f1d1d' };
  return { fill: '#94a3b8', stroke: '#334155' };
}

function isExcludedGroup1to50(row){
  const g = (row?.grupoDece ?? row?.grupo_DECE ?? row?.Grupo_DECE ?? '').toString();
  if (/\b(1)\s*a\s*50\b/i.test(g) || /grupo\s*de\s*1\s*a\s*50/i.test(g)) return true;
  const n = Number(row?.students);
  return Number.isFinite(n) && n <= 50;
}

function normalizeDistrictCode(v){
  const raw = (v ?? "").toString().toUpperCase().trim();
  if (!raw) return "";
  const m = raw.match(/(\d{1,2})\s*D\s*(\d{1,2})/);
  if (m){
    const p = m[1].padStart(2,"0");
    const d = m[2].padStart(2,"0");
    return `${p}D${d}`;
  }
  return raw.replace(/\s+/g,"");
}


/*************************************************
 * DECE Coverage App - v6.0 ENHANCED
 * ✅ Botón Exportar Resultados (Excel, CSV, JSON)
 * ✅ Spatial Join completo
 * ✅ Animaciones Núcleo-Satélite
 * ✅ Popups dinámicos funcionales
 *************************************************/

let map;
const layers = {
  nucleos: L.featureGroup(),
  nucleosOther: L.featureGroup(),
  satellites: L.featureGroup(),
  satellitesUncovered: L.featureGroup(),  // Nueva capa para satélites SIN cobertura (rojos)
  satellitesOrphanBuffers: L.featureGroup(),  // Nueva capa para satélites dentro de buffers B# (huérfanos)
  satellitesOther: L.featureGroup(),
  satellitesExcluded: L.featureGroup(),
  buffers: L.featureGroup(),
  bufferHandles: L.featureGroup(), // Handles de arrastre para buffers (más confiable que mousedown en canvas)
  bufferLabels: L.featureGroup(), // Etiquetas para buffers huérfanos (B1, B2, ...)
  connections: L.featureGroup(),
  animations: L.featureGroup()
};

// === Parámetros de distancia ===
// Requisito: si supera 7.5 km, NO hay atención.
// Nota: el modelo de atención es únicamente FISCAL NÚCLEO → FISCAL SATÉLITE (sin asignaciones “forzadas” fuera del corte).
const BUFFER_RADIUS_M = 7500; // 7.5 km
const ORPHAN_WARNING_DISTANCE_M = 7500; // 7.5 km: umbral para marcar fuera de alcance
const ORPHAN_BUFFER_NUCLEO_MAX_M = 7000; // 7.0 km: máximo satélite→núcleo (solo fiscales/seleccionados) para cubrir buffers B#
const ORPHAN_MAX_DISTANCE_M = 7000; // corte duro: no conectar si supera 7.0 km

// === Parámetros de tiempo (metodología) ===
// En el Modelo DECE se recomienda que el desplazamiento no supere 1 hora.
// En esta app, por defecto se usa una estimación por velocidad promedio (configurable) y se mantiene
// el corte espacial (km). Si deseas tiempos reales por red vial, puedes integrar OSRM.
const MAX_TRAVEL_MIN = 60;
const DEFAULT_AVG_SPEED_KMPH = 25; // estimación conservadora (ajústalo según territorio)
let avgSpeedKmph = DEFAULT_AVG_SPEED_KMPH;
try {
  const v = parseFloat(localStorage.getItem('avgSpeedKmph') || '');
  if (Number.isFinite(v) && v > 1) avgSpeedKmph = v;
} catch(_) {}

function estimateTravelMinutes(distMeters) {
  const km = distMeters / 1000;
  const h = km / Math.max(1, avgSpeedKmph);
  return h * 60;
}

function setAvgSpeedKmph(v){
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 1) return;
  avgSpeedKmph = n;
  try { localStorage.setItem('avgSpeedKmph', String(n)); } catch(_) {}
}

const ECUADOR_CENTER = [-1.831239, -78.183406];
// Renderers separados para evitar que al arrastrar un buffer se “redibuje” todo el canvas
// (y se perciba que desaparecen núcleos/satélites por rendimiento).
// - Marcadores (muchos): canvas
// - Buffers (pocos): canvas separado (no fuerza redibujar marcadores)
// - Conexiones (muchas líneas): canvas
const canvasRenderer = L.canvas({ padding: 0.5 });        // marcadores
// Buffers como SVG: hit-detection y arrastre MUCHO más confiable (y no repinta el canvas de puntos).
// Dejamos `bufferRenderer` (canvas) por compatibilidad, pero los buffers se renderizan con `buffersRenderer` (SVG).
const bufferRenderer = L.canvas({ padding: 0.05 });       // (legacy) buffers en canvas
const connectionRenderer = L.canvas({ padding: 0.5 });    // conexiones
const buffersRenderer = L.svg({ padding: 0.1 });          // buffers (SVG)
const connectionsRenderer = L.canvas({ padding: 0.5 });   // líneas
const GRID_CELL_DEG = 0.10;
const BUFFER_SELECTION_POLICY = "cover";
const TARGET_COVERAGE = 0.97;
const MAX_BUFFERS = 220;
const MIN_SATS_PER_BUFFER = 3;
const TOP_N_BUFFERS = 120;
const ENABLE_NETWORK_ANIMATION = true;
const MAX_CONNECTIONS_FOR_ANIM = 6000;
const ASSUMED_SPEED_KMH = 30;

// === Herramienta de medición (Regla) ===
let measureMode = false;
let measurePoints = [];
let measureLine = null;
let measureMarkers = [];
let measureLabelMarker = null;
let editMode = false;
// Modo “Manito” (Pan) para desplazar el mapa con click+arrastre (estilo GIS)
let panMode = true;                 // por defecto ON
let panMouseDown = false;           // para cursor grabbing

// En modo edición, el arrastre del mapa suele “robarse” el drag de los buffers (especialmente con renderer canvas).
// Solución: deshabilitar map.dragging mientras editMode=true y habilitarlo temporalmente con la tecla ESPACIO.
let editPanKeyDown = false;
let editPanKeyHandlersBound = false;
let addMode = false;
let deleteMode = false;
let editableBuffers = new Map();
let customBuffers = [];
let customBufferCounter = 0;
// Mostrar u ocultar líneas de conexión (desactivado por defecto por coherencia visual)
const SHOW_CONNECTION_LINES = false;

let globalData = null;
let metricsPanel = null;
let hasUnsavedChanges = false;


// ========== CONEXIONES DE SATÉLITES DESATENDIDOS ==========
let satelliteConnections = new Map(); // si -> {ni, distance, animated}
let connectionStats = {
  total: 0,
  connected: 0,
  orphans: 0,
  coverageImprovement: 0
};


// ========== ANÁLISIS DE HUÉRFANOS (AGREGADO) ==========
let orphanAnalysis = {
  forcedAssignments: new Map(), // si -> {ni, distance}
  orphanSatellites: new Set(),
  unservedSatellites: new Map(), // si -> {ni, distance} (más cercano, pero > 7km)

  orphanNucleos: new Set(),
  stats: {
    total: 0,
    normalCovered: 0,
    forcedCovered: 0,
    unserved: 0,
    normalPercent: 0,
    totalPercent: 0
  }
};

// ========== BUFFERS HUÉRFANOS (SATÉLITES SIN NÚCLEO DENTRO DEL RADIO) ==========
// Definición: buffer que contiene >=1 satélite y 0 núcleos dentro de 7 km.
let orphanBuffersState = {
  aliasById: new Map(), // bufferId -> 'B1'
  list: [] // lista para exportación
};
let orphanBufferCoverageState = {
  byBufferId: new Map(), // bufferId -> { bestNi, nucleoAmie, nucleoNombre, nucleoSostenimiento, coveredSatellites, totalSatellites, avgKm, maxKm }
  satAssignments: new Map(), // si -> { ni, distanceMeters, bufferId }
  satInsideOrphan: new Map() // si -> bufferId (si está dentro de un buffer B#)
};

function getCustomBufferLabel(buffer) {
  return buffer?.orphanAlias ? buffer.orphanAlias : (buffer?.name || buffer?.id || 'Buffer');
}

function refreshOrphanBufferLabels() {
  // Limpia y vuelve a dibujar SOLO etiquetas para buffers huérfanos
  try {
    layers.bufferLabels?.clearLayers?.();
  } catch (_) {}

  orphanBuffersState.list.forEach(b => {
    if (!Number.isFinite(b.centerLat) || !Number.isFinite(b.centerLng)) return;
    const html = `
      <div style="
        width:28px;height:28px;border-radius:999px;
        background:rgba(163,113,247,0.92);
        border:2px solid rgba(255,255,255,0.9);
        color:#fff;font-weight:800;font-size:12px;
        display:flex;align-items:center;justify-content:center;
        box-shadow:0 2px 6px rgba(0,0,0,0.25);
      ">${escapeHTML(b.alias)}</div>
    `;
    const icon = L.divIcon({ className: 'orphan-buffer-label', html, iconSize: [28, 28], iconAnchor: [14, 14] });
    L.marker([b.centerLat, b.centerLng], { icon, interactive: false, keyboard: false }).addTo(layers.bufferLabels);
  });
}


function getSelectedFiscalNucleoCandidates() {
  if (!globalData) return [];
  const { nucleos, selected } = globalData;

  const candidates = [];
  (selected || []).forEach(ni => {
    const nuc = nucleos?.[ni];
    if (!nuc) return;
    // globalData ya viene filtrado a fiscales, pero dejamos el check por seguridad
    if (!isFiscalInstitution(nuc)) return;
    const pos = getCurrentNucleoLatLng(ni, nuc);
    candidates.push({
      ni,
      amie: nuc.amie || '',
      name: nuc.name || `Núcleo ${ni}`,
      sostenimiento: nuc.sostenimiento || '',
      lat: pos.lat,
      lng: pos.lng
    });
  });
  return candidates;
}

function recomputeOrphanBufferCoverage() {
  // Recalcular cobertura de buffers huérfanos (B#) hacia núcleos fiscales seleccionados (≤ 7 km).
  orphanBufferCoverageState.byBufferId = new Map();
  orphanBufferCoverageState.satAssignments = new Map();
  orphanBufferCoverageState.satInsideOrphan = new Map();

  if (!globalData || !Array.isArray(orphanBuffersState?.list) || !orphanBuffersState.list.length) return;

  const { satellites } = globalData;
  const nucCandidates = getSelectedFiscalNucleoCandidates();
  if (!nucCandidates.length) return;

  orphanBuffersState.list.forEach(ob => {
    const bufferId = ob.bufferId;

    const bufferObj = (customBuffers || []).find(b => b.id === bufferId);
    const center = bufferObj?.circle?.getLatLng?.() || (Number.isFinite(ob.centerLat) ? { lat: ob.centerLat, lng: ob.centerLng } : null);
    if (!center) return;

    // satélites dentro del buffer (7 km)
    const satsInBuffer = [];
    satellites.forEach((sat, si) => {
      // ✅ SOLO satélites fiscales elegibles participan en cobertura de buffers huérfanos
      if (!isFiscalInstitution(sat) || !isSatellite51to120(sat)) return;
      const d = haversineMeters(center.lat, center.lng, sat.lat, sat.lng);
      if (d <= BUFFER_RADIUS_M) {
        satsInBuffer.push({ sat, si });
        if (!orphanBufferCoverageState.satInsideOrphan.has(si)) orphanBufferCoverageState.satInsideOrphan.set(si, bufferId);
      }
    });

    const totalSatellites = satsInBuffer.length;
    if (!totalSatellites) {
      const emptyRec = { bestNi: null, nucleoAmie: '', nucleoNombre: '', nucleoSostenimiento: '', coveredSatellites: 0, totalSatellites: 0, avgKm: '', maxKm: '' };
      orphanBufferCoverageState.byBufferId.set(bufferId, emptyRec);
      if (bufferObj) bufferObj.coverage = emptyRec;
      return;
    }

    // Asignación por satélite: núcleo fiscal seleccionado más cercano dentro de 7 km
    const perNucleo = new Map(); // ni -> {count, sumDist, maxDist}
    let coveredSatellites = 0;

    satsInBuffer.forEach(({ sat, si }) => {
      let best = null;
      let bestDist = Infinity;

      for (const n of nucCandidates) {
        const dist = haversineMeters(n.lat, n.lng, sat.lat, sat.lng);
        if (dist < bestDist) { bestDist = dist; best = n; }
      }

      const travelMin = estimateTravelMinutes(bestDist);
      if (best && Number.isFinite(bestDist) && bestDist <= ORPHAN_BUFFER_NUCLEO_MAX_M && travelMin <= MAX_TRAVEL_MIN) {
        coveredSatellites++;
        orphanBufferCoverageState.satAssignments.set(si, { ni: best.ni, distanceMeters: bestDist, travelMinutes: travelMin, bufferId });

        if (!perNucleo.has(best.ni)) perNucleo.set(best.ni, { count: 0, sumDist: 0, maxDist: 0, sumMin: 0, maxMin: 0 });
        const agg = perNucleo.get(best.ni);
        agg.count += 1;
        agg.sumDist += bestDist;
        agg.sumMin += travelMin;
        if (bestDist > agg.maxDist) agg.maxDist = bestDist;
        if (travelMin > agg.maxMin) agg.maxMin = travelMin;
      }
    });

    // Elegir el núcleo "dominante" del buffer: más satélites cubiertos; empate: menor distancia promedio
    let bestNi = null;
    let bestCount = -1;
    let bestAvg = Infinity;
    let bestMax = 0;
    let bestAvgMin = Infinity;
    let bestMaxMin = 0;

    perNucleo.forEach((agg, ni) => {
      const avg = agg.count ? (agg.sumDist / agg.count) : Infinity;
      if (agg.count > bestCount || (agg.count === bestCount && avg < bestAvg)) {
        bestNi = ni;
        bestCount = agg.count;
        bestAvg = avg;
        bestMax = agg.maxDist;
      }
    });

    const nuc = (bestNi != null) ? (globalData.nucleos?.[bestNi] || null) : null;
    const rec = {
      bestNi,
      nucleoAmie: nuc?.amie || '',
      nucleoNombre: nuc?.name || (bestNi != null ? `Núcleo ${bestNi}` : ''),
      nucleoSostenimiento: nuc?.sostenimiento || '',
      coveredSatellites,
      totalSatellites,
      avgKm: Number.isFinite(bestAvg) ? (bestAvg / 1000).toFixed(2) : '',
      maxKm: Number.isFinite(bestMax) ? (bestMax / 1000).toFixed(2) : '',
      avgMin: Number.isFinite(bestAvgMin) ? (bestAvgMin).toFixed(0) : '',
      maxMin: Number.isFinite(bestMaxMin) ? (bestMaxMin).toFixed(0) : ''
    };

    orphanBufferCoverageState.byBufferId.set(bufferId, rec);
    if (bufferObj) bufferObj.coverage = rec;
  });
}

function updateOrphanBuffers() {
  // Recalcula alias B1..Bn con orden estable Norte→Sur y Oeste→Este.
  if (!globalData) {
    orphanBuffersState.aliasById = new Map();
    orphanBuffersState.list = [];
    orphanBufferCoverageState.byBufferId = new Map();
    orphanBufferCoverageState.satAssignments = new Map();
    orphanBufferCoverageState.satInsideOrphan = new Map();
    refreshOrphanBufferLabels();
    return;
  }

  const candidates = [];
  (customBuffers || []).forEach(buffer => {
    const pos = buffer?.circle?.getLatLng?.();
    if (!pos) return;
    // ✅ Para identificar buffers huérfanos usamos SOLO satélites fiscales (no 1–50) y núcleos fiscales
    const m = calculateBufferMetricsDetailed(pos, BUFFER_RADIUS_M, {
      onlyFiscalSatellites: true,
      onlyFiscalNucleos: true,
      excludeGroup1to50: true,
      onlySatellite51to120: true
    });
    if ((m?.satellitesCount || 0) > 0 && (m?.nucleosCount || 0) === 0) {
      candidates.push({
        buffer,
        bufferId: buffer.id,
        centerLat: pos.lat,
        centerLng: pos.lng,
        satellitesCount: m.satellitesCount,
        totalStudents: m.totalStudents
      });
    }
  });

  // Orden estable: Norte→Sur (lat desc), Oeste→Este (lng asc)
  candidates.sort((a, b) => {
    if (b.centerLat !== a.centerLat) return b.centerLat - a.centerLat;
    return a.centerLng - b.centerLng;
  });

  const aliasById = new Map();
  const list = candidates.map((c, i) => {
    const alias = `B${i + 1}`;
    aliasById.set(c.bufferId, alias);
    return {
      alias,
      bufferId: c.bufferId,
      centerLat: c.centerLat,
      centerLng: c.centerLng,
      satellitesCount: c.satellitesCount,
      totalStudents: c.totalStudents
    };
  });

  // Aplicar alias a buffers custom (sin destruir su nombre original)
  (customBuffers || []).forEach(b => {
    b.orphanAlias = aliasById.get(b.id) || null;
  });

  orphanBuffersState.aliasById = aliasById;
  orphanBuffersState.list = list;
  recomputeOrphanBufferCoverage();
  refreshOrphanBufferLabels();
}

let animationLines = [];
let _connectionAnimTimer = null;
let _initialized = false;
let autoSaveTimer = null;
let analyzeOrphansTimer = null;

const STORAGE_KEY = 'dece_buffers_state';
const BACKUP_KEY = 'dece_buffers_backup';

// ==================== STORAGE MEJORADO ====================
/**
 * Valida que las coordenadas sean válidas para Ecuador
 */
function validateBufferCoordinates(lat, lng) {
  // Ecuador está aproximadamente entre -5° y 2° de latitud, -92° y -75° de longitud
  return !isNaN(lat) && !isNaN(lng) &&
         lat >= -5 && lat <= 2 &&
         lng >= -92 && lng <= -75;
}

/**
 * Guarda el estado completo de los buffers con validación
 */
function saveBuffersState() {
  const state = {
    editableBuffers: [],
    customBuffers: [],
    timestamp: new Date().toISOString(),
    version: '6.2'
  };

  // Guardar buffers editables con validación de coordenadas
  editableBuffers.forEach((data, ni) => {
    const pos = data.circle.getLatLng();
    
    // Validar que las coordenadas sean válidas
    if (isNaN(pos.lat) || isNaN(pos.lng)) {
      console.error(`❌ Coordenadas inválidas para buffer ${ni}`);
      return;
    }
    
    state.editableBuffers.push({
      ni: ni,
      currentLat: pos.lat,
      currentLng: pos.lng,
      originalLat: data.originalPos.lat,
      originalLng: data.originalPos.lng,
      nucleoName: data.nucleo.name || `Núcleo ${ni}`
    });
  });

  // Guardar buffers personalizados
  customBuffers.forEach(buffer => {
    const pos = buffer.circle.getLatLng();
    
    if (isNaN(pos.lat) || isNaN(pos.lng)) {
      console.error(`❌ Coordenadas inválidas para buffer personalizado ${buffer.id}`);
      return;
    }
    
    state.customBuffers.push({
      id: buffer.id,
      lat: pos.lat,
      lng: pos.lng,
      name: buffer.name,
      originalLat: buffer.originalPos?.lat || pos.lat,
      originalLng: buffer.originalPos?.lng || pos.lng
    });
  });

  try {
    // Crear backup antes de guardar
    const existingState = localStorage.getItem(STORAGE_KEY);
    if (existingState) {
      localStorage.setItem(BACKUP_KEY, existingState);
    }
    
    // Guardar nuevo estado
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    hasUnsavedChanges = false;
    updateSaveButtonState();
    
    console.log(`💾 Estado guardado: ${state.editableBuffers.length} buffers editables, ${state.customBuffers.length} personalizados`);
    showNotification("💾 Cambios guardados exitosamente", "success");
    
    return true;
  } catch (e) {
    console.error("❌ Error al guardar:", e);
    showNotification("❌ Error al guardar: " + e.message, "error");
    return false;
  }
}

/**
 * Carga el estado guardado con validación robusta
 */
function loadBuffersState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    
    if (!saved) {
      console.log("ℹ️ No hay estado guardado previo");
      return null;
    }
    
    const state = JSON.parse(saved);
    
    // Validar estructura del estado
    if (!state.editableBuffers && !state.customBuffers) {
      console.warn("⚠️ Estado guardado tiene formato inválido");
      return null;
    }
    
    // Validar cada buffer guardado
    let validBuffers = 0;
    let invalidBuffers = 0;
    
    if (state.editableBuffers) {
      state.editableBuffers.forEach(buf => {
        if (validateBufferCoordinates(buf.currentLat, buf.currentLng)) {
          validBuffers++;
        } else {
          invalidBuffers++;
          console.warn(`⚠️ Buffer inválido: ${buf.ni || 'desconocido'}`);
        }
      });
    }
    
    if (state.customBuffers) {
      state.customBuffers.forEach(buf => {
        if (validateBufferCoordinates(buf.lat, buf.lng)) {
          validBuffers++;
        } else {
          invalidBuffers++;
          console.warn(`⚠️ Buffer personalizado inválido: ${buf.id || 'desconocido'}`);
        }
      });
    }
    
    console.log(`✅ Estado cargado: ${validBuffers} buffers válidos, ${invalidBuffers} inválidos`);
    if (state.timestamp) {
      console.log(`📅 Guardado el: ${state.timestamp}`);
    }
    
    return state;
    
  } catch (e) {
    console.error("❌ Error al cargar estado:", e);
    showNotification("⚠️ Error al cargar estado guardado", "error");
    return null;
  }
}

/**
 * Limpia el estado guardado con confirmación
 */
function clearBuffersState() {
  if (!confirm("¿Estás seguro de que quieres reiniciar TODAS las posiciones de los buffers?")) {
    return;
  }
  
  try {
    localStorage.removeItem(STORAGE_KEY);
    hasUnsavedChanges = false;
    updateSaveButtonState();
    showNotification("✅ Estado reiniciado. Recarga la página para ver los cambios.", "info");
  } catch (e) {
    showNotification("❌ Error al limpiar estado", "error");
  }
}

/**
 * Restaura el estado desde el backup
 */
function restoreFromBackup() {
  try {
    const backup = localStorage.getItem(BACKUP_KEY);
    
    if (!backup) {
      showNotification("⚠️ No hay backup disponible", "error");
      return false;
    }
    
    if (!confirm("¿Restaurar al estado anterior? Perderás los cambios actuales.")) {
      return false;
    }
    
    localStorage.setItem(STORAGE_KEY, backup);
    showNotification("✅ Backup restaurado. Recarga la página.", "success");
    return true;
    
  } catch (e) {
    console.error("❌ Error al restaurar backup:", e);
    showNotification("❌ Error al restaurar backup", "error");
    return false;
  }
}

/**
 * Exporta el estado completo a un archivo JSON
 */
function exportBuffersState() {
  const state = {
    editableBuffers: [],
    customBuffers: [],
    timestamp: new Date().toISOString(),
    version: '6.2',
    metadata: {
      totalBuffers: editableBuffers.size + customBuffers.length,
      editableCount: editableBuffers.size,
      customCount: customBuffers.length
    }
  };

  editableBuffers.forEach((data, ni) => {
    const pos = data.circle.getLatLng();
    state.editableBuffers.push({
      ni: ni,
      currentLat: pos.lat,
      currentLng: pos.lng,
      originalLat: data.originalPos.lat,
      originalLng: data.originalPos.lng,
      nucleoName: data.nucleo.name || `Núcleo ${ni}`,
      moved: pos.lat !== data.originalPos.lat || pos.lng !== data.originalPos.lng
    });
  });

  customBuffers.forEach(buffer => {
    const pos = buffer.circle.getLatLng();
    state.customBuffers.push({
      id: buffer.id,
      lat: pos.lat,
      lng: pos.lng,
      name: buffer.name,
      originalLat: buffer.originalPos?.lat || pos.lat,
      originalLng: buffer.originalPos?.lng || pos.lng
    });
  });

  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dece-buffers-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  
  showNotification("✅ Estado exportado exitosamente", "success");
}

/**
 * Importa el estado desde un archivo JSON
 */
function importBuffersState(file) {
  if (!file) return;
  
  const reader = new FileReader();
  
  reader.onload = function(e) {
    try {
      const state = JSON.parse(e.target.result);
      
      // Validar estructura
      if (!state.editableBuffers && !state.customBuffers) {
        showNotification("❌ Archivo inválido", "error");
        return;
      }
      
      if (!confirm("¿Importar este estado? Se perderán los cambios actuales.")) {
        return;
      }
      
      // Guardar en localStorage
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      showNotification("✅ Estado importado. Recarga la página.", "success");
      
    } catch (err) {
      console.error("Error al importar:", err);
      showNotification("❌ Error al importar archivo", "error");
    }
  };
  
  reader.readAsText(file);
}

function markAsChanged() { 
  hasUnsavedChanges = true; 
  updateSaveButtonState(); 
  
  // Auto-guardar después de 2 segundos sin cambios
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    if (hasUnsavedChanges) {
      saveBuffersState();
      console.log("💾 Auto-guardado ejecutado");
    }
  }, 2000);
}

// Función de debouncing para analyzeOrphans (mejora rendimiento)
function debounceAnalyzeOrphans() {
  if (analyzeOrphansTimer) clearTimeout(analyzeOrphansTimer);
  analyzeOrphansTimer = setTimeout(() => {
    analyzeOrphans();
  }, 300);
}

function updateSaveButtonState() {
  const btn = document.getElementById('btnSaveChanges');
  if (btn) btn.classList.toggle('has-changes', hasUnsavedChanges);
}

// ==================== EXPORT FUNCTIONS ====================
function showExportModal() {
  const exportData = performSpatialJoin();
  if (!exportData || exportData.buffers.length === 0) { showNotification("❌ No hay buffers para exportar", "error"); return; }
  
  const modal = document.createElement('div');
  modal.className = 'export-modal';
  modal.innerHTML = `
    <div class="export-panel">
      <div class="export-header">
        <h3>📤 Exportar Resultados</h3>
        <button class="close-btn" onclick="this.closest('.export-modal').remove()">×</button>
      </div>
      <div class="export-content">
        <div class="export-summary">
          <h4>📊 Resumen del Análisis Espacial</h4>
          <div class="summary-grid">
            <div class="summary-card"><div class="summary-icon">🎯</div><div class="summary-value">${exportData.summary.totalBuffers}</div><div class="summary-label">Buffers Totales</div></div>
            <div class="summary-card"><div class="summary-icon">🏫</div><div class="summary-value">${exportData.summary.totalAMIEs}</div><div class="summary-label">AMIEs Cubiertas</div></div>
            <div class="summary-card"><div class="summary-icon">🏛️</div><div class="summary-value">${exportData.summary.totalNucleos}</div><div class="summary-label">Núcleos</div></div>
            <div class="summary-card"><div class="summary-icon">📍</div><div class="summary-value">${exportData.summary.totalSatellites}</div><div class="summary-label">Satélites</div></div>
            <div class="summary-card"><div class="summary-icon">👥</div><div class="summary-value">${exportData.summary.totalStudents.toLocaleString()}</div><div class="summary-label">Estudiantes</div></div>
            <div class="summary-card"><div class="summary-icon">📈</div><div class="summary-value">${exportData.summary.coveragePercent}%</div><div class="summary-label">Cobertura</div></div>
          </div>
        </div>
        <div class="export-options">
          <h4>📁 Formato de exportación</h4>
          <div class="export-buttons">
            <button class="export-btn excel" onclick="exportToExcel()"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>Excel (.xlsx)</span></button>
            <button class="export-btn csv" onclick="exportToCSV()"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>CSV (.csv)</span></button>
            <button class="export-btn json" onclick="exportToJSON()"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>JSON (.json)</span></button>
          </div>
        </div>
        <div class="export-preview">
          <h4>👁️ Vista previa</h4>
          <div class="preview-table-container">
            <table class="preview-table">
              <thead><tr><th>Buffer</th><th>Tipo</th><th>AMIEs</th><th>Núcleos</th><th>Satélites</th><th>Estudiantes</th></tr></thead>
              <tbody>
                ${exportData.buffers.slice(0, 5).map(b => `<tr><td>${b.bufferName}</td><td><span class="type-badge ${b.isCustom ? 'custom' : 'original'}">${b.isCustom ? 'Personalizado' : 'Original'}</span></td><td>${b.totalAMIEs}</td><td>${b.nucleosCount}</td><td>${b.satellitesCount}</td><td>${b.totalStudents.toLocaleString()}</td></tr>`).join('')}
                ${exportData.buffers.length > 5 ? `<tr class="more-rows"><td colspan="6">... y ${exportData.buffers.length - 5} buffers más</td></tr>` : ''}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  setTimeout(() => modal.classList.add('show'), 10);
  window._exportData = exportData;
}

function performSpatialJoin() {
  if (!globalData) return null;

  // Asegurar alias B1..Bn actualizado antes de exportar
  updateOrphanBuffers();

  const { nucleos, satellites } = globalData;
  const allInstitutions = [...nucleos.map(n => ({...n, type: 'nucleo'})), ...satellites.map(s => ({...s, type: 'satellite'}))];
  const buffers = [];
  let totalAMIEsCovered = new Set();
  let totalStudentsCovered = 0;
  
  editableBuffers.forEach((data, ni) => {
    const bufferPos = data.circle.getLatLng();
    const result = spatialJoinBuffer(bufferPos, BUFFER_RADIUS_M, allInstitutions);
    result.institutions.forEach(inst => { if (inst.amie) totalAMIEsCovered.add(inst.amie); });
    totalStudentsCovered += result.totalStudents;
    buffers.push({
      bufferId: `buffer_nucleo_${ni}`,
      bufferName: data.nucleo.name || `Núcleo ${ni}`,
      nucleoAmie: data.nucleo.amie || '',
      nucleoNombre: data.nucleo.name || `Núcleo ${ni}`,
      nucleoSostenimiento: data.nucleo.sostenimiento || '',
      orphanAlias: '',
      isOrphanBuffer: false,
      isCustom: false,
      centerLat: bufferPos.lat, centerLng: bufferPos.lng, radiusMeters: BUFFER_RADIUS_M,
      originalLat: data.nucleo.lat, originalLng: data.nucleo.lng,
      wasMoved: bufferPos.lat !== data.nucleo.lat || bufferPos.lng !== data.nucleo.lng,
      totalAMIEs: result.institutions.length, nucleosCount: result.nucleosCount, satellitesCount: result.satellitesCount,
      totalStudents: result.totalStudents, institutions: result.institutions
    });
  });
  
  customBuffers.forEach(buffer => {
    const bufferPos = buffer.circle.getLatLng();
    const result = spatialJoinBuffer(bufferPos, BUFFER_RADIUS_M, allInstitutions);
    result.institutions.forEach(inst => { if (inst.amie) totalAMIEsCovered.add(inst.amie); });
    totalStudentsCovered += result.totalStudents;

    // (Nuevo) Si el buffer es huérfano (B#), intentar asociarlo a un núcleo fiscal seleccionado (por satélites ≤ 7 km)
    const cov = (buffer?.orphanAlias)
      ? (orphanBufferCoverageState?.byBufferId?.get?.(buffer.id) || buffer.coverage || null)
      : null;
    const covNi = (cov && cov.bestNi != null && cov.coveredSatellites > 0) ? cov.bestNi : null;
    const covNuc = (covNi != null) ? (nucleos?.[covNi] || null) : null;

    buffers.push({
      bufferId: buffer.id,
      bufferName: getCustomBufferLabel(buffer),
      bufferOriginalName: buffer.name,
      nucleoAmie: covNuc?.amie || '',
      nucleoNombre: covNuc?.name || (cov?.nucleoNombre || ''),
      nucleoSostenimiento: covNuc?.sostenimiento || (cov?.nucleoSostenimiento || ''),
      coberturaSatellites7km: cov ? cov.coveredSatellites : '',
      coberturaSatellitesTotal: cov ? cov.totalSatellites : '',
      coberturaAvgKm: cov?.avgKm || '',
      coberturaMaxKm: cov?.maxKm || '',
      orphanAlias: buffer.orphanAlias || '',
      isOrphanBuffer: !!buffer.orphanAlias,
      isCustom: true,
      centerLat: bufferPos.lat, centerLng: bufferPos.lng, radiusMeters: BUFFER_RADIUS_M,
      originalLat: buffer.originalPos.lat, originalLng: buffer.originalPos.lng,
      wasMoved: bufferPos.lat !== buffer.originalPos.lat || bufferPos.lng !== buffer.originalPos.lng,
      totalAMIEs: result.institutions.length, nucleosCount: result.nucleosCount, satellitesCount: result.satellitesCount,
      totalStudents: result.totalStudents, institutions: result.institutions
    });
  });
  
  const allSatellites = buffers.reduce((sum, b) => sum + b.satellitesCount, 0);

  // ============================
  // Extra para EXPORTAR RESULTADOS (satélites cubiertos / sin cobertura / conexiones extendidas)
  // ============================
  const activeCenters = getActiveCoverageCenters();
  const centerInfos = activeCenters.map(c => {
    if (c.kind === 'nucleo') {
      const nuc = nucleos?.[c.ni];
      return {
        ...c,
        label: nuc?.name || `Núcleo ${c.ni}`,
        amie: nuc?.amie || '',
        kindName: 'Núcleo'
      };
    }
    if (c.kind === 'custom') {
      const b = customBuffers?.find(x => x.id === c.id);
      return {
        ...c,
        label: getCustomBufferLabel(b) || c.id || 'Buffer personalizado',
        amie: '',
        kindName: 'Personalizado'
      };
    }
    return { ...c, label: 'Buffer', amie: '', kindName: String(c.kind || 'Buffer') };
  });

  // ✅ Exportamos SOLO satélites fiscales (y no excluidos 1–50), coherente con el modelo
  const satellitesAllExport = (satellites || []).map((sat, si) => {
    if (!isFiscalInstitution(sat) || isExcludedGroup1to50(sat)) return null;
    let nearest = { dist: Infinity, center: null };
    for (const c of centerInfos) {
      const d = haversineMeters(c.lat, c.lng, sat.lat, sat.lng);
      if (d < nearest.dist) nearest = { dist: d, center: c };
    }
    let covered = Number.isFinite(nearest.dist) && nearest.dist <= BUFFER_RADIUS_M;

    // (Nuevo) Si está dentro de un buffer huérfano B#, la cobertura depende del núcleo fiscal seleccionado (≤ 7 km)
    const orphanBid = orphanBufferCoverageState?.satInsideOrphan?.get?.(si);
    if (orphanBid) {
      covered = !!orphanBufferCoverageState?.satAssignments?.get?.(si);
    }

    const forced = orphanAnalysis?.forcedAssignments?.get?.(si) || null;
    const forcedNuc = (forced && Number.isFinite(forced.ni)) ? (nucleos?.[forced.ni] || null) : null;
    const forcedLabel = forcedNuc ? (forcedNuc.name || `Núcleo ${forced.ni}`) : '';
    const forcedAmie = forcedNuc ? (forcedNuc.amie || '') : '';
    const forcedDistance = forced ? forced.distance : null;
    const extended = Number.isFinite(forcedDistance) && forcedDistance > ORPHAN_WARNING_DISTANCE_M;

    return {
      si,
      amie: sat.amie || '',
      name: sat.name || '',
      sostenimiento: sat.sostenimiento || '',
      students: sat.students || 0,
      distrito: sat.dist || '',
      zona: sat.zona ?? null,
      provincia: sat.provincia || '',
      canton: sat.canton || '',
      lat: sat.lat,
      lng: sat.lng,
      covered,
      nearestBuffer: nearest.center ? {
        kind: nearest.center.kind,
        kindName: nearest.center.kindName,
        label: nearest.center.label,
        amie: nearest.center.amie || '',
        distanceMeters: Math.round(nearest.dist),
        distanceKm: (nearest.dist / 1000).toFixed(2)
      } : null,
      forcedAssignment: forced ? {
        ni: forced.ni,
        nucleoName: forcedLabel,
        nucleoAmie: forcedAmie,
        distanceMeters: Math.round(forcedDistance || 0),
        distanceKm: ((forcedDistance || 0) / 1000).toFixed(2),
        extended
      } : null
    };
  }).filter(Boolean);

  const satellitesCoveredExport = satellitesAllExport.filter(s => s.covered);
  const satellitesUncoveredExport = satellitesAllExport.filter(s => !s.covered);
  const satellitesExtendedExport = satellitesAllExport.filter(s => s.forcedAssignment?.extended);

  const orphanNucleosList = Array.from(orphanAnalysis?.orphanNucleos || []).map(ni => {
    const nuc = nucleos?.[ni];
    const pos = nuc ? getCurrentNucleoLatLng(ni, nuc) : null;
    return {
      ni,
      amie: nuc?.amie || '',
      name: nuc?.name || `Núcleo ${ni}`,
      sostenimiento: nuc?.sostenimiento || '',
      distrito: nuc?.dist || '',
      lat: pos?.lat ?? nuc?.lat ?? null,
      lng: pos?.lng ?? nuc?.lng ?? null
    };
  });

  // (Nuevo) Export de buffers huérfanos con núcleo fiscal asignado (si existe ≤ 7 km)
  const orphanBuffersExport = (orphanBuffersState?.list || []).map(b => {
    const cov = orphanBufferCoverageState?.byBufferId?.get?.(b.bufferId) || null;
    return {
      ...b,
      nucleoAmie: cov?.nucleoAmie || '',
      nucleoNombre: cov?.nucleoNombre || '',
      nucleoSostenimiento: cov?.nucleoSostenimiento || '',
      coberturaSatellites7km: (cov && Number.isFinite(cov.coveredSatellites)) ? cov.coveredSatellites : '',
      coberturaSatellitesTotal: (cov && Number.isFinite(cov.totalSatellites)) ? cov.totalSatellites : '',
      coberturaAvgKm: cov?.avgKm || '',
      coberturaMaxKm: cov?.maxKm || ''
    };
  });

  return {
    exportDate: new Date().toISOString(),
    summary: {
      totalBuffers: buffers.length, originalBuffers: buffers.filter(b => !b.isCustom).length,
      customBuffers: buffers.filter(b => b.isCustom).length, totalAMIEs: totalAMIEsCovered.size,
      totalNucleos: new Set(buffers.flatMap(b => b.institutions.filter(i => i.type === 'nucleo').map(i => i.amie))).size,
      totalSatellites: allSatellites, totalStudents: totalStudentsCovered,
      // ✅ Cobertura = satélites fiscales cubiertos / satélites fiscales totales
      coveragePercent: satellitesAllExport.length > 0 ? ((satellitesCoveredExport.length / satellitesAllExport.length) * 100).toFixed(1) : 0
    },
    buffers,
    satellitesSummary: {
      total: satellitesAllExport.length,
      covered: satellitesCoveredExport.length,
      uncovered: satellitesUncoveredExport.length,
      extendedConnections: satellitesExtendedExport.length
    },
    satellitesAll: satellitesAllExport,
    satellitesUncovered: satellitesUncoveredExport,
    satellitesExtended: satellitesExtendedExport,
    orphanNucleos: orphanNucleosList,
    orphanBuffers: orphanBuffersExport
  };
}

function spatialJoinBuffer(center, radius, institutions) {
  const result = { institutions: [], nucleosCount: 0, satellitesCount: 0, totalStudents: 0 };
  institutions.forEach(inst => {
    const dist = haversineMeters(center.lat, center.lng, inst.lat, inst.lng);
    if (dist <= radius) {
      result.institutions.push({
        amie: inst.amie || '', name: inst.name || '', type: inst.type, typeName: inst.type === 'nucleo' ? 'Núcleo' : 'Satélite',
        codGDECE: (inst.codGDECE ?? inst.code), lat: inst.lat, lng: inst.lng, distanceMeters: Math.round(dist),
        distanceKm: (dist / 1000).toFixed(2),
        travelMinEst: estimateTravelMinutes(dist).toFixed(0), students: inst.students || 0, distrito: inst.dist || '',
        sostenimiento: inst.sostenimiento || ''
      });
      if (inst.type === 'nucleo') result.nucleosCount++; else result.satellitesCount++;
      result.totalStudents += inst.students || 0;
    }
  });
  result.institutions.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return result;
}


// ==================== EXPORT HELPERS (Registros_GIEE) ====================
function buildGIEEAssignmentsForExport() {
  // Devuelve Map por AMIE con:
  // - deceNucleo: '1' si tiene cobertura (o es núcleo), '0' si NO (se mostrará como '-' en Excel)
  // - amieNucleo: AMIE del núcleo asignado/más cercano (según estado actual del mapa)
  const res = {
    deceNucleoByAmie: new Map(),
    amieNucleoByAmie: new Map()
  };

  if (!globalData || !globalData.nucleos || !globalData.satellites) return res;

  // Asegurar B1..Bn / cobertura huérfanos actualizada
  try { updateOrphanBuffers(); } catch (e) {}

  const { nucleos, satellites } = globalData;

  // Marcar núcleos (self)
  nucleos.forEach((n, ni) => {
    const amie = String(n?.amie || '').trim();
    if (!amie) return;
    res.deceNucleoByAmie.set(amie, '1');
    res.amieNucleoByAmie.set(amie, amie);
  });

  // Índice dinámico de núcleos fiscales seleccionados (los únicos que otorgan cobertura)
  const activeCenters = getActiveNucleoCentersOnly(); // [{kind:'nucleo', ni, lat, lng}]
  const activeGrid = buildPointGrid(activeCenters);

  // Helper: núcleo seleccionado más cercano (sin corte), para referencia cuando esté fuera de 7.5 km
  function closestSelectedNucleoNoCut(lat, lng) {
    let best = null;
    let bestDist = Infinity;
    for (const c of activeCenters) {
      if (c?.kind !== 'nucleo' || !Number.isFinite(c?.ni)) continue;
      const d = haversineMeters(c.lat, c.lng, lat, lng);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best ? { ni: best.ni, distance: bestDist } : null;
  }

  // Asignación por satélite (según lógica del mapa)
  satellites.forEach((sat, si) => {
    const satAmie = String(sat?.amie || '').trim();
    if (!satAmie) return;

    let covered = false;
    let ni = null;

    // 1) Si está dentro de un buffer huérfano B#, la cobertura depende de asignación a núcleo fiscal seleccionado (≤ 7 km)
    const orphanBid = orphanBufferCoverageState?.satInsideOrphan?.get?.(si);
    if (orphanBid) {
      const assign = orphanBufferCoverageState?.satAssignments?.get?.(si);
      if (assign && Number.isFinite(assign.ni)) {
        ni = assign.ni;
        covered = true;
      } else {
        covered = false;
      }
    } else {
      // 2) Cobertura real por buffer de núcleo fiscal seleccionado (posición actual)
      const hit = findClosestInGridWithin(activeGrid, sat.lat, sat.lng, BUFFER_RADIUS_M, 1);
      if (hit && hit.point?.kind === 'nucleo' && Number.isFinite(hit.point.ni)) {
        ni = hit.point.ni;
        covered = true;
      }
    }

    // 3) Si no está cubierto, usar núcleo fiscal seleccionado más cercano (para llenar AMIE_NUCLEO)
    if (ni == null) {
      const tooFar = orphanAnalysis?.unservedSatellites?.get?.(si);
      if (tooFar && Number.isFinite(tooFar.ni)) {
        ni = tooFar.ni;
      } else {
        const near = closestSelectedNucleoNoCut(sat.lat, sat.lng);
        if (near) ni = near.ni;
      }
    }

    // Guardar resultado por AMIE
    res.deceNucleoByAmie.set(satAmie, covered ? '1' : '0');
    if (ni != null && nucleos?.[ni]?.amie) {
      res.amieNucleoByAmie.set(satAmie, String(nucleos[ni].amie || '').trim());
    }
  });

  return res;
}



function buildCoverageZonesRowsForExport() {
  try {
    if (!globalData?.nucleos || !globalData?.satellites) return [];
    const nucleos = globalData.nucleos;
    const satellites = globalData.satellites;
    const selected = globalData.selected || new Set();

    const selectedIdx = Array.from(selected);
    if (!selectedIdx.length) return [];

    const nodes = selectedIdx.map((ni) => {
      const n = nucleos[ni];
      if (!n) return null;
      const buf = editableBuffers.get(ni);
      const pos = buf?.currentPos;
      return {
        ni,
        amie: String(n.amie || '').trim(),
        students: Number(n.students || 0),
        lat: (pos?.lat ?? n.lat),
        lng: (pos?.lng ?? n.lng)
      };
    }).filter(Boolean);

    if (!nodes.length) return [];

    // Union-Find por solape de buffers (distancia entre centros <= 2R)
    const parent = nodes.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const union = (a, b) => {
      a = find(a); b = find(b);
      if (a !== b) parent[b] = a;
    };

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const d = haversineMeters(nodes[i].lat, nodes[i].lng, nodes[j].lat, nodes[j].lng);
        if (d <= (2 * BUFFER_RADIUS_M)) union(i, j);
      }
    }

    const groups = new Map();
    nodes.forEach((node, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(node);
    });

    // Orden estable (norte->sur)
    const groupArr = Array.from(groups.values()).map((g) => {
      const clat = g.reduce((s, x) => s + x.lat, 0) / g.length;
      const clng = g.reduce((s, x) => s + x.lng, 0) / g.length;
      return { g, clat, clng };
    }).sort((a, b) => (b.clat - a.clat) || (a.clng - b.clng));

    const rows = [];
    let k = 1;

    for (const item of groupArr) {
      const g = item.g;
      // En caso de múltiples núcleos solapados, tomamos SOLO 1 núcleo: el de mayor concentración estudiantil
      const primary = g.reduce((best, cur) => {
        if (!best) return cur;
        return (Number(cur?.students || 0) > Number(best?.students || 0)) ? cur : best;
      }, null);
      const primaryAmie = String(primary?.amie || '').trim();

      const satSet = new Set();
      for (let si = 0; si < satellites.length; si++) {
        const s = satellites[si];
        if (!s) continue;
        // satellites ya es fiscal 51–120
        for (const node of g) {
          const d = haversineMeters(s.lat, s.lng, node.lat, node.lng);
          if (d <= BUFFER_RADIUS_M) { satSet.add(String(s.amie || '').trim()); break; }
        }
      }

      const satAmies = Array.from(satSet).filter(Boolean).sort();

      // Regla de limpieza: si es un único núcleo sin satélites, no lo exportamos como zona
      if (g.length === 1 && satAmies.length === 0) continue;

      // Salida VERTICAL (1 satélite por fila), espejo a lo que se ve en el mapa
      // - ZONA_ID solo en la primera fila
      // - AMIE_NUCLEOS_DENTRO_DEL_BUFFER repite el núcleo elegido (mayor estudiantes)
      // - TOTAL_NUCLEOS se fija en 1 porque se exporta un único núcleo “representante”
      // - SATELITES_FISCALES es un AMIE por fila
      if (satAmies.length === 0) {
        rows.push({
          ZONA_ID: `Z${k}`,
          AMIE_NUCLEOS_DENTRO_DEL_BUFFER: primaryAmie,
          TOTAL_NUCLEOS: 1,
          SATELITES_FISCALES: '',
        });
      } else {
        satAmies.forEach((sa, idx) => {
          rows.push({
            ZONA_ID: idx === 0 ? `Z${k}` : '',
            AMIE_NUCLEOS_DENTRO_DEL_BUFFER: primaryAmie,
            TOTAL_NUCLEOS: 1,
            SATELITES_FISCALES: sa,
          });
        });
      }
      k++;
    }

    return rows;
  } catch (e) {
    console.warn('[WARN] buildCoverageZonesRowsForExport falló:', e);
    return [];
  }
}

function buildBuffersBRowsForExport() {
  try {
    const rows = [];
    const list = orphanBuffersState?.list || [];
    if (!list.length || !globalData?.satellites) return rows;

    const satellites = globalData.satellites;
    const satInside = orphanBufferCoverageState?.satInsideOrphan;
    const bufToSat = new Map();

    if (satInside && typeof satInside.forEach === 'function') {
      satInside.forEach((bufferId, si) => {
        const s = satellites[si];
        const amie = String(s?.amie || '').trim();
        if (!amie) return;
        if (!bufToSat.has(bufferId)) bufToSat.set(bufferId, []);
        bufToSat.get(bufferId).push(amie);
      });
    }

    const aliasNum = (a) => {
      const m = String(a || '').match(/(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    };

    const sorted = list.slice().sort((a, b) =>
      (aliasNum(a.alias) - aliasNum(b.alias)) || String(a.alias).localeCompare(String(b.alias))
    );

    // Salida VERTICAL (1 satélite por fila) y SOLO 3 columnas:
    // BUFFER_ALIAS | SATELITES_FISCALES | TOTAL_SATELITES
    for (const ob of sorted) {
      const amies = bufToSat.get(ob.bufferId) || [];
      const uniq = Array.from(new Set(amies)).sort();
      const alias = String(ob.alias || ob.bufferId);

      if (!uniq.length) {
        rows.push({
          BUFFER_ALIAS: alias,
          SATELITES_FISCALES: '',
          TOTAL_SATELITES: 0
        });
        continue;
      }

      uniq.forEach((amie) => {
        rows.push({
          BUFFER_ALIAS: alias,
          SATELITES_FISCALES: amie,
          TOTAL_SATELITES: 1
        });
      });
    }

    return rows;
  } catch (e) {
    console.warn('[WARN] buildBuffersBRowsForExport falló:', e);
    return [];
  }
}

function exportToExcel() {
  try {
    const rawRows = window._rawRowsForExport || [];
    if (!Array.isArray(rawRows) || !rawRows.length) {
      showNotification("No hay datos para exportar.", "warning");
      return;
    }
    if (!window.XLSX) {
      showNotification("Falta la librería XLSX (SheetJS).", "error");
      return;
    }

    // =======================
    // Exportación coherente con lo visible en el mapa
    // - Corrige columnas: "DECE NUCLEO" ya no duplica AMIE_NUCLEO
    // - Respeta capas activas (checks) al momento de exportar
    // - Agrega hoja "Vista_Mapa" (entendible) + "Resumen"
    // =======================

    // Asignaciones según estado actual del mapa (buffers, selección, B#)
    const gieeAssign = buildGIEEAssignmentsForExport();

    // Análisis espacial (distancias / buffer más cercano) para hoja entendible
    // Siempre recalcular al exportar para que sea ESPEJO del estado actual del mapa (buffers movidos, etc.)
    const analysis = performSpatialJoin();
    window._exportData = analysis;
    const satByAmie = new Map();
    (analysis?.satellitesAll || []).forEach(s => {
      const a = String(s?.amie || '').trim();
      if (a) satByAmie.set(a, s);
    });

    // Estado de capas (lo que el usuario tiene encendido en el mapa)
    const getChecked = (id, fallback=true) => {
      const el = document.getElementById(id);
      return el ? !!el.checked : fallback;
    };
    const vis = {
      nucleosFiscal: getChecked('toggleNucleos', true),
      nucleosOther: getChecked('toggleNucleosOther', true),
      satCovered: getChecked('toggleSatellites', true),
      satOrphans: getChecked('toggleSatellitesUncovered', true),
      satOrphanBuffers: getChecked('toggleSatellitesOrphanBuffers', true),
      satOther: getChecked('toggleSatellitesOther', true),
      satExcluded: getChecked('toggleSatellitesExcluded', true)
    };

    // Índice rápido AMIE -> índice de satélite en globalData (para detectar si está dentro de un buffer huérfano B#)
    const satIndexByAmie = new Map();
    try {
      (globalData?.satellites || []).forEach((s, si) => {
        const a = String(s?.amie || '').trim();
        if (a) satIndexByAmie.set(a, si);
      });
    } catch(_) {}

    const toDash = (v) => {
      if (v === null || v === undefined) return '-';
      const s = String(v).trim();
      if (s === '' || s.toLowerCase() === 'nan') return '-';
      return s;
    };

    const isSatelliteRow = (r) => {
      const c = String(r?.coordDeceRaw ?? r?.code ?? '').trim();
      if (c === '') return false;
      const n = Number(c);
      return n === 0 || n === 2; // satélite
    };

    // Clasifica una fila según la simbología del mapa (para filtrar/exportar)
    function classifyForMap(r){
      const sat = isSatelliteRow(r);
      const fiscal = isFiscalInstitution(r);
      const excluded = isExcludedGroup1to50(r);
      if (!sat) {
        return fiscal ? 'NUCLEO_FISCAL' : 'NUCLEO_OTRO';
      }
      if (excluded) return 'EXCLUIDO_1_50';
      if (!fiscal) return 'SAT_OTRO';

      const a = String(r?.amie || '').trim();
      const si = satIndexByAmie.get(a);
      const orphanBid = (Number.isFinite(si)) ? orphanBufferCoverageState?.satInsideOrphan?.get?.(si) : null;
      if (orphanBid) return 'SAT_BUFFER_B';

      const dece = gieeAssign.deceNucleoByAmie.get(a);
      return dece === '1' ? 'SAT_CUBIERTO' : 'SAT_HUERFANO';
    }

    function isVisibleCategory(cat){
      switch(cat){
        case 'NUCLEO_FISCAL': return !!vis.nucleosFiscal;
        case 'NUCLEO_OTRO': return !!vis.nucleosOther;
        case 'SAT_CUBIERTO': return !!vis.satCovered;
        case 'SAT_HUERFANO': return !!vis.satOrphans;
        case 'SAT_BUFFER_B': return !!vis.satOrphanBuffers;
        case 'SAT_OTRO': return !!vis.satOther;
        case 'EXCLUIDO_1_50': return !!vis.satExcluded;
        default: return true;
      }
    }

    const catLabel = {
      NUCLEO_FISCAL: 'Núcleo (Fiscal)',
      NUCLEO_OTRO: 'Núcleo (Otros sostenimientos)',
      SAT_CUBIERTO: 'Satélite (Fiscal) CON Cobertura (Núcleo)',
      SAT_HUERFANO: 'Satélite Huérfano (Fuera de Núcleo)',
      SAT_BUFFER_B: 'Satélite (Fiscal) en Buffers B#',
      SAT_OTRO: 'Satélite (Otros sostenimientos)',
      EXCLUIDO_1_50: 'Excluido (Grupo DECE 1–50)'
    };

    // Helper: extraer asignación "bonita" para Vista_Mapa
    function buildMapExplainRow(r){
      const amie = String(r?.amie || '').trim();
      const cat = classifyForMap(r);
      const satInfo = satByAmie.get(amie);

      // Si el satélite está dentro de un Buffer Huérfano (Alias B#), capturar el alias.
      // Estos buffers están compuestos únicamente por IE satélites (sin núcleo dentro del buffer).
      let orphanBid = null;
      let orphanAlias = null;
      try {
        const si = satIndexByAmie.get(amie);
        orphanBid = (Number.isFinite(si)) ? orphanBufferCoverageState?.satInsideOrphan?.get?.(si) : null;
        if (orphanBid) {
          orphanAlias = orphanBuffersState?.aliasById?.get?.(orphanBid) || null;
          if (!orphanAlias) {
            const ob = orphanBuffersState?.list?.find?.(x => x.bufferId === orphanBid);
            orphanAlias = ob?.alias || null;
          }
        }
      } catch(_) {}

      const deceN = gieeAssign.deceNucleoByAmie.get(amie);
      const amieN = gieeAssign.amieNucleoByAmie.get(amie);

      const nearest = satInfo?.nearestBuffer;
      const forced = satInfo?.forcedAssignment;

      const estado = (cat === 'SAT_CUBIERTO') ? 'CUBIERTO (≤7.5 km)' :
                    (cat === 'SAT_BUFFER_B') ? (deceN === '1' ? 'B# ASIGNADO (≤7 km al núcleo)' : 'B# SIN ASIGNACIÓN') :
                    (cat === 'SAT_HUERFANO') ? 'SIN COBERTURA' :
                    (cat === 'EXCLUIDO_1_50') ? 'EXCLUIDO' :
                    (cat === 'SAT_OTRO') ? 'NO FISCAL' :
                    (cat.startsWith('NUCLEO')) ? 'NÚCLEO' : '-';

      // Distancia que mostramos: si hay nearestBuffer úsala; si hay forced (extendida), úsala aparte
      const distKm = nearest?.distanceKm || (forced?.distanceKm || '-');
      const bufferRef = nearest ? `${nearest.kindName}: ${nearest.label}` : (forced?.nucleoName ? `Núcleo: ${forced.nucleoName}` : '-');

      // Personalización solicitada: en "CATEGORIA_MAPA" mostrar el Alias B# cuando aplique
      const categoriaMapa = (cat === 'SAT_BUFFER_B' && orphanBid)
        ? `Buffer ${orphanAlias || orphanBid} (solo satélites)`
        : (catLabel[cat] || cat);

      return {
        AMIE: amie || '-',
        NOMBRE_IE: toDash(r?.name),
        TIPO: isSatelliteRow(r) ? 'Satélite' : 'Núcleo',
        SOSTENIMIENTO: toDash(r?.sostenimiento),
        GRUPO_DECE: toDash(r?.grupoDece),
        CATEGORIA_MAPA: categoriaMapa,
        ESTADO_COBERTURA: estado,
        DECE_NUCLEO: (deceN === '1' || deceN === '0') ? deceN : toDash(r?.deceNucleoRaw ?? r?.deceNucleo),
        AMIE_NUCLEO: (cat === 'SAT_HUERFANO') ? '' : ((cat === 'SAT_BUFFER_B' && orphanBid && deceN === '0') ? String(orphanAlias || orphanBid) : (amieN ? String(amieN).trim() : toDash(r?.amieNucleo))),
        DISTANCIA_KM: distKm,
        REFERENCIA: bufferRef,
        CONEXION_EXTENDIDA: forced?.extended ? 'SI' : 'NO'
      };
    }

    const headers = [
      'AMIE','DISTRITO','Sostenimiento','Jurisdicción','IE_Fiscales','Jornadas','Grupo_DECE',
      'COD_GDECE','COORD_DECE','PO_ProfDECE','DECE NUCLEO','AMIE_NUCLEO'
    ];

    // 1) Hoja Registros_GIEE (formato oficial) — filtrada según capas activas
    const rows = rawRows
      .filter(r => isVisibleCategory(classifyForMap(r)))
      .map(r => {
      const amie = String(r.amie || '').trim();

      // Valores base del CSV
      const distrito = toDash(r.dist);
      const sost = toDash(r.sostenimiento);
      const juris = toDash(r.jurisdiccion);
      const ieFisc = toDash(r.ieFiscalesRaw ?? (r.ieFiscales ? '1' : ''));
      const jornadas = toDash(r.jornadasRaw ?? r.jornadas);
      const grupo = toDash(r.grupoDece);
      const cod = toDash(r.codGDECE ?? r.codGDECE);
      const coord = toDash(r.coordDeceRaw ?? r.code);
      const po = toDash(r.profDeceRaw ?? r.profDece);

      // Por defecto: lo que venga en el CSV
      let amieN = String(r.amieNucleo || '').trim();
      let deceN = String(r.deceNucleoRaw ?? r.deceNucleo ?? '').trim();

      // Si es satélite fiscal (51–120), completar desde el estado actual del mapa
      if (amie && isSatelliteRow(r) && isFiscalInstitution(r) && isSatellite51to120(r) && !isExcludedGroup1to50(r)) {
        const d = gieeAssign.deceNucleoByAmie.get(amie);
        if (d === '1' || d === '0') deceN = d;
        const amieNFromMap = gieeAssign.amieNucleoByAmie.get(amie);
        if (amieNFromMap) amieN = String(amieNFromMap).trim();
      }
      // PATCH CALIDAD:
      // - Satélite huérfano: AMIE_NUCLEO debe quedar vacío (no usar el valor del CSV)
      // - Satélite en Buffer B# sin asignación: colocar el alias B# (ej. B4) como referencia
      const catMap = classifyForMap(r);
      if (catMap === 'SAT_HUERFANO') {
        amieN = '';
      } else if (catMap === 'SAT_BUFFER_B' && deceN === '0') {
        try {
          const si = satIndexByAmie.get(amie);
          const obid = (Number.isFinite(si)) ? orphanBufferCoverageState?.satInsideOrphan?.get?.(si) : null;
          if (obid) {
            const oalias = orphanBuffersState?.aliasById?.get?.(obid) || (orphanBuffersState?.list?.find?.(x => x.bufferId === obid)?.alias) || null;
            amieN = String(oalias || obid);
          }
        } catch(_) {}
      }


      // Si es núcleo, siempre es "1" y su AMIE
      if (amie && !isSatelliteRow(r)) {
        deceN = '1';
        amieN = amie;
      }

      return [
        toDash(amie),
        distrito,
        sost,
        juris,
        ieFisc,
        jornadas,
        grupo,
        cod,
        coord,
        po,
        toDash(deceN),
        toDash(amieN)
      ];
    });

    // 2) Hoja Vista_Mapa (entendible)
    const explainRows = rawRows
      .filter(r => isVisibleCategory(classifyForMap(r)))
      .map(r => buildMapExplainRow(r));

    // 3) Resumen
    const counts = explainRows.reduce((acc, r) => {
      acc[r.CATEGORIA_MAPA] = (acc[r.CATEGORIA_MAPA] || 0) + 1;
      return acc;
    }, {});
    const resumen = [
      ['Exportado el', new Date().toLocaleString()],
      ['Capas activas (exportadas)', ''],
      ['Núcleos (Fiscal)', vis.nucleosFiscal ? 'SI' : 'NO'],
      ['Núcleos (Otros)', vis.nucleosOther ? 'SI' : 'NO'],
      ['Satélites (Fiscal) con cobertura', vis.satCovered ? 'SI' : 'NO'],
      ['Satélites Huérfanos', vis.satOrphans ? 'SI' : 'NO'],
      ['Satélites en Buffers B#', vis.satOrphanBuffers ? 'SI' : 'NO'],
      ['Satélites (Otros)', vis.satOther ? 'SI' : 'NO'],
      ['Excluidos (1–50)', vis.satExcluded ? 'SI' : 'NO'],
      ['',''],
      ['Conteo por categoría', 'Registros']
    ].concat(Object.entries(counts).map(([k,v]) => [k, v]));

    // Exportación reducida: SOLO 2 hojas (Cobertura_Zonas y Buffers_B)
    const wb = XLSX.utils.book_new();

    // 1) Hoja Cobertura_Zonas (salida vertical 1 satélite por fila)
    const zonasRows = buildCoverageZonesRowsForExport();
    const wsZonas = XLSX.utils.json_to_sheet(zonasRows);
    XLSX.utils.book_append_sheet(wb, wsZonas, 'Cobertura_Zonas');

    // 2) Hoja Buffers_B (satélites fiscales contenidos en Buffers B#)
    const bRows = buildBuffersBRowsForExport();
    const wsB = XLSX.utils.json_to_sheet(bRows);
    XLSX.utils.book_append_sheet(wb, wsB, 'Buffers_B');


    const d = new Date();
    const pad = (n) => String(n).padStart(2,'0');
    const fname = `Resultados_prototipo_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.xlsx`;

    XLSX.writeFile(wb, fname);
    showNotification("✅ Exportación lista (Cobertura_Zonas + Buffers_B).", "success");
  } catch (e) {
    console.error("[EXPORT] Error:", e);
    showNotification("Error al exportar. Revisa la consola.", "error");
  }
}

function exportToCSV() {
  const data = window._exportData;
  if (!data) return;
  showNotification("📄 Generando CSV...", "info");
  const headers = ['Buffer_ID','Buffer_Nombre','Buffer_Tipo','Buffer_AliasHuerfano','Nucleo_AMIE','Nucleo_Nombre','Nucleo_Sostenimiento','Buffer_Lat','Buffer_Lng','AMIE','Institucion_Nombre','Institucion_Sostenimiento','Institucion_Tipo','COD_GDECE','Inst_Lat','Inst_Lng','Distancia_m','Distancia_km','Estudiantes','Distrito'];
  const rows = [];
  data.buffers.forEach(buffer => buffer.institutions.forEach(inst => rows.push([
    buffer.bufferId,
    `"${String(buffer.bufferName || '').replace(/"/g,'""')}"`,
    buffer.isCustom ? 'Personalizado' : 'Original',
    `"${String(buffer.orphanAlias || '').replace(/"/g,'""')}"`,
    `"${String(buffer.nucleoAmie || '').replace(/"/g,'""')}"`,
    `"${String(buffer.nucleoNombre || '').replace(/"/g,'""')}"`,
    `"${String(buffer.nucleoSostenimiento || '').replace(/"/g,'""')}"`,
    buffer.centerLat,
    buffer.centerLng,
    `"${String(inst.amie || '').replace(/"/g,'""')}"`,
    `"${String(inst.name || '').replace(/"/g,'""')}"`,
    `"${String(inst.sostenimiento || '').replace(/"/g,'""')}"`,
    `"${String(inst.typeName || '').replace(/"/g,'""')}"`,
    `"${String(inst.codGDECE || '').replace(/"/g,'""')}"`,
    inst.lat,
    inst.lng,
    inst.distanceMeters,
    inst.distanceKm,
    inst.travelMinEst,
    inst.students,
    `"${String(inst.distrito || '').replace(/"/g,'""')}"`
  ].join(','))));
  downloadFile([headers.join(','), ...rows].join('\\n'), `DECE_Analysis_BUFFERS_${formatDateForFilename()}.csv`, 'text/csv;charset=utf-8;');

  // CSV adicional: resumen de satélites (uno por registro)
  if (Array.isArray(data.satellitesAll) && data.satellitesAll.length) {
    const satHeaders = ['AMIE','Nombre','Sostenimiento','Estudiantes','Distrito','Zona','Provincia','Cantón','Lat','Lng','Cubierto','BufferMasCercano','TipoBuffer','DistBufferM','DistBufferKm','ConexionForzada','NucleoAsignado','AMIE_NucleoAsignado','DistForzadaM','DistForzadaKm','Extendida>7km'];
    const satRows = data.satellitesAll.map(s => ([
      `"${String(s.amie || '').replace(/"/g,'""')}"`,
      `"${String(s.name || '').replace(/"/g,'""')}"`,
      `"${String(s.sostenimiento || '').replace(/"/g,'""')}"`,
      s.students || 0,
      `"${String(s.distrito || '').replace(/"/g,'""')}"`,
      `"${String(s.zona ?? '').replace(/"/g,'""')}"`,
      `"${String(s.provincia || '').replace(/"/g,'""')}"`,
      `"${String(s.canton || '').replace(/"/g,'""')}"`,
      s.lat, s.lng,
      s.covered ? 'SI' : 'NO',
      `"${String(s.nearestBuffer?.label || '').replace(/"/g,'""')}"`,
      `"${String(s.nearestBuffer?.kindName || '').replace(/"/g,'""')}"`,
      s.nearestBuffer?.distanceMeters ?? '',
      s.nearestBuffer?.distanceKm ?? '',
      s.forcedAssignment ? 'SI' : 'NO',
      `"${String(s.forcedAssignment?.nucleoName || '').replace(/"/g,'""')}"`,
      `"${String(s.forcedAssignment?.nucleoAmie || '').replace(/"/g,'""')}"`,
      s.forcedAssignment?.distanceMeters ?? '',
      s.forcedAssignment?.distanceKm ?? '',
      s.forcedAssignment?.extended ? 'SI' : 'NO'
    ].join(',')));
    downloadFile([satHeaders.join(','), ...satRows].join('\\n'), `DECE_Analysis_SATELITES_${formatDateForFilename()}.csv`, 'text/csv;charset=utf-8;');
  }

  // CSV adicional: buffers huérfanos (B1, B2, ...)
  if (Array.isArray(data.orphanBuffers) && data.orphanBuffers.length) {
    const oHeaders = ['Alias','Buffer_ID','Lat_Centro','Lng_Centro','Satélites','Estudiantes'];
    const oRows = data.orphanBuffers.map(o => [
      `"${String(o.alias || '').replace(/"/g,'""')}"`,
      `"${String(o.bufferId || '').replace(/"/g,'""')}"`,
      o.centerLat,
      o.centerLng,
      o.satellitesCount,
      o.totalStudents
    ].join(','));
    downloadFile([oHeaders.join(','), ...oRows].join('\\n'), `DECE_Analysis_BUFFERS_HUERFANOS_${formatDateForFilename()}.csv`, 'text/csv;charset=utf-8;');
  }
  showNotification("✅ CSV descargado", "success");
  document.querySelector('.export-modal')?.remove();
}

function exportToJSON() {
  const data = window._exportData;
  if (!data) return;
  showNotification("📋 Generando JSON...", "info");
  downloadFile(JSON.stringify(data, null, 2), `DECE_Analysis_${formatDateForFilename()}.json`, 'application/json');
  showNotification("✅ JSON descargado", "success");
  document.querySelector('.export-modal')?.remove();
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function formatDateForFilename() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
}

window.showExportModal = showExportModal;
window.exportToExcel = exportToExcel;
window.exportToCSV = exportToCSV;
window.exportToJSON = exportToJSON;

// ==================== COVERAGE ====================
function completeCoverage() {
  if (!globalData) { showNotification("❌ Espera a que carguen los datos", "error"); return; }
  showNotification("🔄 Completando cobertura...", "info");
  const uncovered = findUncoveredSatellites();
  if (uncovered.length === 0) { showNotification("✅ ¡Cobertura completa!", "success"); return; }
  const newBuffers = createOptimalBuffers(uncovered);
  newBuffers.forEach(pos => createCustomBuffer(pos.lat, pos.lng));
  setTimeout(() => {
    const stillUncovered = findUncoveredSatellites();
    const coverage = ((globalData.satellites.length - stillUncovered.length) / globalData.satellites.length * 100).toFixed(1);
    analyzeOrphans();
    showNotification(`✅ Cobertura: ${coverage}%. ${newBuffers.length} buffers agregados.`, stillUncovered.length === 0 ? "success" : "info");
    markAsChanged();
  }, 300);
}

function findUncoveredSatellites() {
  if (!globalData) return [];
  return globalData.satellites.filter((sat, index) => {
    let covered = false;
    editableBuffers.forEach(data => { if (haversineMeters(sat.lat, sat.lng, data.circle.getLatLng().lat, data.circle.getLatLng().lng) <= BUFFER_RADIUS_M) covered = true; });
    if (!covered) customBuffers.forEach(buffer => { if (haversineMeters(sat.lat, sat.lng, buffer.circle.getLatLng().lat, buffer.circle.getLatLng().lng) <= BUFFER_RADIUS_M) covered = true; });
    return !covered;
  }).map((sat, index) => ({ ...sat, index }));
}

function createOptimalBuffers(uncoveredSatellites) {
  const minDistance = BUFFER_RADIUS_M * 1.5;
  let numClusters = Math.min(Math.ceil(uncoveredSatellites.length / 5), uncoveredSatellites.length);
  let centroids = [];
  const usedIndices = new Set();
  for (let i = 0; i < numClusters; i++) {
    let idx; do { idx = Math.floor(Math.random() * uncoveredSatellites.length); } while (usedIndices.has(idx));
    usedIndices.add(idx);
    centroids.push({ lat: uncoveredSatellites[idx].lat, lng: uncoveredSatellites[idx].lng });
  }
  for (let iter = 0; iter < 10; iter++) {
    const clusters = Array.from({ length: numClusters }, () => []);
    uncoveredSatellites.forEach(sat => {
      let minDist = Infinity, closest = 0;
      centroids.forEach((c, ci) => { const d = haversineMeters(sat.lat, sat.lng, c.lat, c.lng); if (d < minDist) { minDist = d; closest = ci; } });
      clusters[closest].push(sat);
    });
    centroids = clusters.filter(c => c.length > 0).map(cluster => ({
      lat: cluster.reduce((s, sat) => s + sat.lat, 0) / cluster.length,
      lng: cluster.reduce((s, sat) => s + sat.lng, 0) / cluster.length
    }));
  }
  return centroids.filter(c => {
    let tooClose = false;
    editableBuffers.forEach(data => { if (haversineMeters(c.lat, c.lng, data.circle.getLatLng().lat, data.circle.getLatLng().lng) < minDistance) tooClose = true; });
    if (!tooClose) customBuffers.forEach(buffer => { if (haversineMeters(c.lat, c.lng, buffer.circle.getLatLng().lat, buffer.circle.getLatLng().lng) < minDistance) tooClose = true; });
    return !tooClose;
  });
}

function showUncoveredInstitutions() {
  const uncovered = findUncoveredSatellites();
  if (uncovered.length === 0) { showNotification("✅ ¡Todas cubiertas!", "success"); return; }
  const modal = document.createElement('div');
  modal.className = 'uncovered-modal';
  modal.innerHTML = `<div class="uncovered-panel"><div class="uncovered-header"><h3>⚠️ Sin Cobertura</h3><button class="close-btn" onclick="this.closest('.uncovered-modal').remove()">×</button></div><div class="uncovered-content"><div class="uncovered-summary"><div class="summary-item"><span class="summary-number">${uncovered.length}</span><span class="summary-label">Instituciones</span></div><div class="summary-item"><span class="summary-number">${uncovered.reduce((s, sat) => s + (sat.students || 0), 0).toLocaleString()}</span><span class="summary-label">Estudiantes</span></div></div><div class="uncovered-actions"><button class="btn-action-modal" onclick="completeCoverage(); this.closest('.uncovered-modal').remove();">🔧 Completar Cobertura</button></div><div class="uncovered-list">${uncovered.slice(0, 20).map((sat, idx) => `<div class="uncovered-item" onclick="map.flyTo([${sat.lat}, ${sat.lng}], 13)"><div class="uncovered-item-number">${idx + 1}</div><div class="uncovered-item-info"><div class="uncovered-item-name">${escapeHTML(sat.name)}</div><div class="uncovered-item-details">👥 ${sat.students || 0}</div></div></div>`).join('')}${uncovered.length > 20 ? `<div class="more-rows">... y ${uncovered.length - 20} más</div>` : ''}</div></div></div>`;
  document.body.appendChild(modal);
  setTimeout(() => modal.classList.add('show'), 10);
}

window.showUncoveredInstitutions = showUncoveredInstitutions;
window.completeCoverage = completeCoverage;

// ==================== INIT ====================
document.addEventListener("DOMContentLoaded", () => {
  if (_initialized) return;
  _initialized = true;
  initMap();
  setupControls();
  setupEditControls();
  loadCSV();
});

function initMap() {
  map = L.map("map", { center: ECUADOR_CENTER, zoom: 7, zoomControl: true, preferCanvas: true, renderer: canvasRenderer });
  // Medición (Regla)
  map.on('click', onMeasureClick);
  map.on('dblclick', onMeasureDblClick);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  L.control.layers({ "OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"), "Satélite": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}") }).addTo(map);

  // Por defecto: mostrar solo lo relevante para el análisis (Fiscal + excluidos).
  // Otros sostenimientos quedan disponibles en el panel de capas, pero apagados.
  [
    layers.buffers,
    layers.bufferHandles,
    layers.bufferLabels,
    layers.animations,
    layers.nucleos,
    layers.satellites,
    layers.satellitesUncovered,
    layers.satellitesExcluded
  ].forEach(layer => layer.addTo(map));

  // Modo Manito: cursor grab + handlers
  bindPanCursorHandlers();
  setPanMode(true);

}

function clearMeasure(){
  if (measureLine) { try { map.removeLayer(measureLine); } catch(e) {} measureLine = null; }
  measureMarkers.forEach(m => { try { map.removeLayer(m); } catch(e) {} });
  measureMarkers = [];
  if (measureLabelMarker) { try { map.removeLayer(measureLabelMarker); } catch(e) {} measureLabelMarker = null; }
  measurePoints = [];
}

function formatDistance(meters){
  if (!Number.isFinite(meters)) return "0 m";
  if (meters < 1000) return `${meters.toFixed(0)} m`;
  return `${(meters/1000).toFixed(2)} km`;
}

function updateMeasureLabel(){
  if (!measurePoints.length) return;
  let total = 0;
  for (let i=1;i<measurePoints.length;i++){
    total += map.distance(measurePoints[i-1], measurePoints[i]);
  }
  const last = measurePoints[measurePoints.length-1];
  const html = `<div class="measure-label"><div><b>${formatDistance(total)}</b></div><div class="muted">Click: añadir punto • Doble click: terminar</div></div>`;
  const icon = L.divIcon({ className: "", html, iconSize: null });
  if (!measureLabelMarker){
    measureLabelMarker = L.marker(last, { icon, interactive:false }).addTo(map);
  } else {
    measureLabelMarker.setLatLng(last);
    measureLabelMarker.setIcon(icon);
  }
}

function onMeasureClick(e){
  if (!measureMode) return;
  const p = e.latlng;
  measurePoints.push(p);

  const mk = L.circleMarker(p, { radius: 5, weight: 2, fillOpacity: 1 }).addTo(map);
  measureMarkers.push(mk);

  if (!measureLine){
    measureLine = L.polyline([p], { weight: 3, dashArray: "6,8" }).addTo(map);
  } else {
    measureLine.addLatLng(p);
  }
  updateMeasureLabel();
}

function onMeasureDblClick(e){
  if (!measureMode) return;
  measureMode = false;
  document.getElementById("btnMeasure")?.classList.remove("active");
  map.getContainer().style.cursor = "";
  try { map.doubleClickZoom?.enable(); } catch(e2) {}
  if (e && e.originalEvent) e.originalEvent.preventDefault();
}

function toggleMeasureMode(){
  measureMode = !measureMode;
  const btn = document.getElementById("btnMeasure");
  if (measureMode){
    clearMeasure();
    btn?.classList.add("active");
    map.getContainer().style.cursor = "crosshair";
    try { map.doubleClickZoom?.disable(); } catch(e) {}
  } else {
    btn?.classList.remove("active");
    map.getContainer().style.cursor = "";
    try { map.doubleClickZoom?.enable(); } catch(e) {}
    // Si quieres limpiar al salir, descomenta:
    // clearMeasure();
  }
  updatePanInteraction();
}


function anyToolModeActive(){
  return !!(editMode || addMode || deleteMode || measureMode);
}

function updatePanInteraction(){
  if (!map) return;
  const el = map.getContainer();
  const toolActive = anyToolModeActive();

  const allowPanNow = (!toolActive && panMode) || (toolActive && editPanKeyDown);

  // Dragging: solo cuando se permite panear (modo normal pan, o ESPACIO durante herramientas)
  try {
    if (allowPanNow) map.dragging.enable();
    else map.dragging.disable();
  } catch(e) {}

  // Cursor CSS (no pisar el cursor de herramientas como crosshair / not-allowed)
  if (allowPanNow) {
    el.classList.add("cursor-grab");
  } else {
    el.classList.remove("cursor-grab", "cursor-grabbing");
  }
}

function setPanMode(on){
  panMode = !!on;
  const btn = document.getElementById("btnPan");
  if (panMode) btn?.classList.add("active");
  else btn?.classList.remove("active");
  updatePanInteraction();
}

function bindPanCursorHandlers(){
  if (window.__decePanCursorHandlersBound) return;
  window.__decePanCursorHandlersBound = true;

  const el = map.getContainer();

  // grabbing mientras se arrastra el mapa
  el.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    const toolActive = anyToolModeActive();
    const allowPanNow = (!toolActive && panMode) || (toolActive && editPanKeyDown);
    if (!allowPanNow) return;
    panMouseDown = true;
    el.classList.add("cursor-grabbing");
  }, true);

  document.addEventListener("mouseup", () => {
    if (!panMouseDown) return;
    panMouseDown = false;
    el.classList.remove("cursor-grabbing");
  }, true);
}


function setupEditControls() {
  // Manito (Pan): desplazar mapa libremente (cuando no estás en herramientas).
  document.getElementById("btnPan")?.addEventListener("click", (e) => {
    e?.preventDefault?.();
    // Apagar herramientas para evitar conflictos
    if (editMode) toggleEditMode();
    if (addMode) toggleAddMode();
    if (deleteMode) toggleDeleteMode();
    if (measureMode) toggleMeasureMode();
    setPanMode(true);
    showNotification("🖐️ Modo Manito: arrastra para desplazarte", "info");
  });

  document.getElementById("btnEditBuffers")?.addEventListener("click", toggleEditMode);
  // Regla (medición m/km)
  document.getElementById("btnMeasure")?.addEventListener("click", (e) => {
    e?.preventDefault?.();
    // Evitar conflicto con modos de edición
    if (editMode) toggleEditMode();
    if (addMode) toggleAddMode();
    if (deleteMode) toggleDeleteMode();
    toggleMeasureMode();
  });
  document.getElementById("btnAddBuffers")?.addEventListener("click", toggleAddMode);
  document.getElementById("btnDeleteBuffers")?.addEventListener("click", toggleDeleteMode);
  document.getElementById("btnSaveChanges")?.addEventListener("click", saveBuffersState);
  document.getElementById("btnCompleteCoverage")?.addEventListener("click", completeCoverage);
  document.getElementById("btnExportResults")?.addEventListener("click", showExportModal);
  document.getElementById("btnExportResultsPanel")?.addEventListener("click", showExportModal);
}

function toggleEditMode() {
  editMode = !editMode;
  const btn = document.getElementById("btnEditBuffers");
  if (editMode && addMode) toggleAddMode();
  if (editMode && measureMode) toggleMeasureMode();
  if (editMode) { btn?.classList.add("active"); enableBufferEditing(); showNotification("🖊️ Modo edición activado", "info"); }
  else { btn?.classList.remove("active"); disableBufferEditing(); closeMetricsPanel(); showNotification("Modo edición desactivado", "info"); }
  updatePanInteraction();
}

function toggleAddMode() {
  addMode = !addMode;
  const btn = document.getElementById("btnAddBuffers");
  if (addMode && editMode) toggleEditMode();
  if (addMode && deleteMode) toggleDeleteMode();
  if (addMode && measureMode) toggleMeasureMode();
  if (addMode) { btn?.classList.add("active"); map.getContainer().style.cursor = 'crosshair'; map.on('click', onMapClickAddBuffer); showNotification("➕ Click en mapa para crear buffer", "info"); }
  else { btn?.classList.remove("active"); map.getContainer().style.cursor = ''; map.off('click', onMapClickAddBuffer); }
  updatePanInteraction();
}

function toggleDeleteMode() {
  deleteMode = !deleteMode;
  const btn = document.getElementById("btnDeleteBuffers");
  if (deleteMode && editMode) toggleEditMode();
  if (deleteMode && addMode) toggleAddMode();
  if (deleteMode && measureMode) toggleMeasureMode();
  if (deleteMode) { 
    btn?.classList.add("active"); 
    map.getContainer().style.cursor = 'not-allowed'; 
    enableDeleteMode();
    showNotification("🗑️ Click en un buffer para eliminarlo", "info"); 
  } else { 
    btn?.classList.remove("active"); 
    map.getContainer().style.cursor = ''; 
    disableDeleteMode();
  }
  updatePanInteraction();
}

function enableDeleteMode() {
  // Hacer los buffers personalizados clickeables para eliminar
  customBuffers.forEach(buffer => {
    buffer.circle.off('click');
    buffer.circle.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (deleteMode) {
        if (confirm(`¿Eliminar "${buffer.name}"?`)) {
          deleteCustomBuffer(buffer.id);
        }
      }
    });
    buffer.circle.setStyle({ color: '#f85149', fillColor: '#f85149' });
  });
  
  // También para buffers editables (núcleos) - mostrar que no se pueden eliminar
  editableBuffers.forEach((data, ni) => {
    data.circle.off('click');
    data.circle.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (deleteMode) {
        showNotification("⚠️ Los buffers de núcleo no se pueden eliminar, solo mover", "error");
      }
    });
  });
}

function disableDeleteMode() {
  // Restaurar comportamiento normal de los buffers personalizados
  customBuffers.forEach(buffer => {
    buffer.circle.off('click');
    buffer.circle.on('click', (e) => { L.DomEvent.stopPropagation(e); showBufferPopup(buffer, true); });
    buffer.circle.setStyle({ color: '#a371f7', fillColor: '#a371f7' });
  });
  
  // Restaurar buffers editables
  editableBuffers.forEach((data, ni) => {
    data.circle.off('click');
    circle.on('click', (e) => { L.DomEvent.stopPropagation(e); showBufferPopup(editableBuffers.get(ni), false); });
  });
}

function onMapClickAddBuffer(e) { if (addMode) createCustomBuffer(e.latlng.lat, e.latlng.lng); }

function createCustomBuffer(lat, lng) {
  customBufferCounter++;
  // SVG renderer = arrastre/selección confiable sin repintar el canvas de puntos
  const circle = L.circle([lat, lng], { radius: BUFFER_RADIUS_M, color: '#a371f7', fillColor: '#a371f7', weight: 2, opacity: 0.7, fillOpacity: 0.15, renderer: buffersRenderer });
  circle.addTo(layers.buffers);
  setBufferInteractivity(circle, !!editMode);
const buffer = { id: `custom_${customBufferCounter}`, circle, lat, lng, originalPos: { lat, lng }, currentPos: { lat, lng }, isCustom: true, isDragging: false, name: `Buffer Personalizado #${customBufferCounter}` };
  customBuffers.push(buffer);
  markAsChanged();
  circle.on('click', (e) => { L.DomEvent.stopPropagation(e); showBufferPopup(buffer, true); });
  const metrics = calculateBufferMetrics({ lat, lng }, BUFFER_RADIUS_M);
  showNotification(`✓ Buffer creado: ${metrics.iesCount} IEs`, "info");
  setTimeout(() => analyzeOrphans(), 100);
  if (editMode) makeBufferDraggable(circle, buffer, true);
}

window.createCustomBuffer = createCustomBuffer;

// ==================== POPUPS ====================
function showBufferPopup(bufferData, isCustom = false) {
  const pos = bufferData.circle.getLatLng();
  const metrics = calculateBufferMetricsDetailed(pos, BUFFER_RADIUS_M);
  const title = isCustom
    ? (bufferData?.orphanAlias ? `${bufferData.orphanAlias}` : getCustomBufferLabel(bufferData))
    : (bufferData.nucleo?.name || 'Buffer');
  const orphanTag = (isCustom && bufferData?.orphanAlias) ? `<div class="popup-row"><span class="popup-label">Etiqueta:</span><span class="popup-value" style="color:#a371f7;font-weight:800">${escapeHTML(bufferData.orphanAlias)} (Huérfano)</span></div>` : '';

  const cov = (isCustom && bufferData?.orphanAlias)
    ? (orphanBufferCoverageState?.byBufferId?.get?.(bufferData.id) || bufferData.coverage || null)
    : null;

  const coverageTag = (isCustom && bufferData?.orphanAlias)
    ? (cov && cov.bestNi != null && cov.coveredSatellites > 0
        ? `<div class="popup-row"><span class="popup-label">Cobertura fiscal:</span><span class="popup-value" style="color:#58a6ff;font-weight:800">${escapeHTML(cov.nucleoNombre || '')} (${escapeHTML(cov.nucleoAmie || '')})</span></div><div class="popup-row"><span class="popup-label">Satélites cubiertos:</span><span class="popup-value">${cov.coveredSatellites}/${cov.totalSatellites} (≤ 7.5 km)</span></div>`
        : `<div class="popup-row"><span class="popup-label">Cobertura fiscal:</span><span class="popup-value" style="color:#f85149;font-weight:800">SIN COBERTURA (≤ 7.5 km)</span></div>`)
    : '';

  const content = `<div class="buffer-popup"><div class="popup-title">${isCustom ? '🎨' : '🏛️'} ${escapeHTML(title)}</div><div class="popup-content"><div class="popup-row"><span class="popup-label">Tipo:</span><span class="popup-value" style="color:${isCustom ? '#a371f7' : '#58a6ff'}">${isCustom ? 'Personalizado' : 'Núcleo'}</span></div>${orphanTag}${coverageTag}<div class="popup-row"><span class="popup-label">Posición:</span><span class="popup-value">${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}</span></div><div class="popup-divider"></div><div class="popup-row highlight"><span class="popup-label">🎯 AMIEs:</span><span class="popup-value">${metrics.iesCount}</span></div><div class="popup-row"><span class="popup-label">🏛️ Núcleos:</span><span class="popup-value" style="color:#58a6ff">${metrics.nucleosCount}</span></div><div class="popup-row"><span class="popup-label">📍 Satélites:</span><span class="popup-value" style="color:#58a6ff">${metrics.satellitesCount}</span></div><div class="popup-row"><span class="popup-label">👥 Estudiantes:</span><span class="popup-value" style="color:#d29922">${metrics.totalStudents.toLocaleString()}</span></div>${metrics.iesList.length > 0 ? `<div class="popup-divider"></div><div class="popup-ies-list"><strong>Instituciones:</strong>${metrics.iesList.slice(0, 5).map(ie => `<div class="popup-ie-item"><span class="ie-type-dot ${ie.type}"></span><span class="ie-name">${escapeHTML(ie.name).substring(0, 25)}...</span><span class="ie-dist">${(ie.dist/1000).toFixed(1)}km</span></div>`).join('')}${metrics.iesList.length > 5 ? `<div class="popup-more">... y ${metrics.iesList.length - 5} más</div>` : ''}</div>` : ''}</div></div>`;
  bufferData.circle.bindPopup(content, { maxWidth: 350, className: 'custom-buffer-popup' }).openPopup();
}

function calculateBufferMetricsDetailed(position, radius, opts = {}) {
  if (!globalData) return { iesCount: 0, totalStudents: 0, profNecesarios: 0, iesList: [], nucleosCount: 0, satellitesCount: 0 };
  const onlyFiscalSatellites = !!opts.onlyFiscalSatellites;
  const onlyFiscalNucleos = !!opts.onlyFiscalNucleos;
  const onlySatellite51to120 = !!opts.onlySatellite51to120;
  const excludeGroup = (opts.excludeGroup1to50 !== false);
  let iesCount = 0, totalStudents = 0, iesList = [], nucleosCount = 0, satellitesCount = 0;
  globalData.satellites.forEach(sat => {
    if (excludeGroup && isExcludedGroup1to50(sat)) return;
    if (onlyFiscalSatellites && !isFiscalInstitution(sat)) return;
    if (onlySatellite51to120 && !isSatellite51to120(sat)) return;
    const dist = haversineMeters(position.lat, position.lng, sat.lat, sat.lng);
    if (dist <= radius) { iesCount++; satellitesCount++; totalStudents += sat.students || 0; iesList.push({ name: sat.name || 'Sin nombre', dist, students: sat.students || 0, type: 'satellite' }); }
  });
  globalData.nucleos.forEach(nuc => {
    if (onlyFiscalNucleos && !isFiscalInstitution(nuc)) return;
    const dist = haversineMeters(position.lat, position.lng, nuc.lat, nuc.lng);
    if (dist <= radius) { iesCount++; nucleosCount++; totalStudents += nuc.students || 0; iesList.push({ name: nuc.name || 'Sin nombre', dist, students: nuc.students || 0, type: 'nucleo' }); }
  });
  iesList.sort((a, b) => a.dist - b.dist);
  return { iesCount, totalStudents, profNecesarios: Math.ceil(totalStudents / 450), iesList, nucleosCount, satellitesCount };
}

function calculateBufferMetrics(position, radius) {
  if (!globalData) return { iesCount: 0, totalStudents: 0, profNecesarios: 0, iesList: [] };
  let iesCount = 0, totalStudents = 0, iesList = [];
  globalData.satellites.forEach(sat => {
    const dist = haversineMeters(position.lat, position.lng, sat.lat, sat.lng);
    if (dist <= radius) { iesCount++; totalStudents += sat.students || 0; iesList.push({ name: sat.name || 'Sin nombre', dist, students: sat.students || 0 }); }
  });
  iesList.sort((a, b) => a.dist - b.dist);
  return { iesCount, totalStudents, profNecesarios: Math.ceil(totalStudents / 450), iesList };
}

function closeMetricsPanel() { if (metricsPanel) metricsPanel.classList.remove('show'); }
window.closeMetricsPanel = closeMetricsPanel;

function deleteCustomBuffer(bufferId) {
  const idx = customBuffers.findIndex(b => b.id === bufferId);
  if (idx === -1) return;
  // remover handle si existe
  try {
    if (customBuffers[idx].handle) {
      layers.bufferHandles.removeLayer(customBuffers[idx].handle);
      customBuffers[idx].handle = null;
    }
  } catch(_){ }
  layers.buffers.removeLayer(customBuffers[idx].circle);
  customBuffers.splice(idx, 1);
  markAsChanged();
  closeMetricsPanel();
  debounceAnalyzeOrphans(); // Usar debouncing
  showNotification("✓ Buffer eliminado", "info");
}
window.deleteCustomBuffer = deleteCustomBuffer;

// ==================== BUFFER HANDLES ====================
// En versiones anteriores intentamos usar “handles” (marcadores) para arrastrar.
// Pero el usuario prefiere el comportamiento clásico: arrastrar el círculo (como en v10).
// Además, al renderizar los buffers con SVG (buffersRenderer) la detección de eventos es confiable.
const USE_BUFFER_HANDLES = false;
const BUFFER_HANDLE_ICON = L.divIcon({
  className: 'buffer-handle-icon',
  html: '<div class="buffer-handle"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8]
});

function ensureBufferHandle(data, isCustom, ni = null){
  if (!USE_BUFFER_HANDLES) return;
  if (!data || !data.circle) return;
  if (data.handle) return;

  const p = data.circle.getLatLng();
  const handle = L.marker([p.lat, p.lng], {
    icon: BUFFER_HANDLE_ICON,
    draggable: true,
    autoPan: true,
    keyboard: false,
    zIndexOffset: 2000,
    opacity: 0 // por defecto oculto; se muestra solo en modo edición
  });

  // Por defecto: no interactivo hasta que se active edición
  try { handle.dragging.disable(); } catch(_){ }

  // Mientras se arrastra el handle, movemos el círculo y evitamos que el mapa "robe" el drag.
  handle.on('dragstart', (e) => {
    if (!editMode) { try { handle.dragging.disable(); } catch(_){} return; }
    data.isDragging = true;
    try { map.dragging.disable(); } catch(_){}
    try { map.getContainer().classList.add('buffer-dragging'); } catch(_){}
    try { data.circle.setStyle({ weight: 4, fillOpacity: 0.3 }); } catch(_){}
  });

  // Throttle con RAF para suavidad
  let raf = null;
  let pending = null;
  const flush = () => {
    raf = null;
    if (!pending) return;
    try { data.circle.setLatLng(pending); } catch(_){}
  };
  handle.on('drag', (e) => {
    if (!editMode) return;
    pending = e.target.getLatLng();
    if (raf) return;
    raf = requestAnimationFrame(flush);
  });

  handle.on('dragend', (e) => {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    pending = null;
    data.isDragging = false;

    const pos = e.target.getLatLng();
    try { data.circle.setLatLng(pos); } catch(_){}
    data.currentPos = pos;
    if (isCustom) { data.lat = pos.lat; data.lng = pos.lng; }

    // Actualizar alias/labels si aplica (solo al final para no parpadear)
    try {
      const ob = orphanBuffersState?.list?.find?.(x => x.bufferId === data.id);
      if (ob) { ob.centerLat = pos.lat; ob.centerLng = pos.lng; }
    } catch(_){}
    try { refreshOrphanBufferLabels(); } catch(_){}

    // Restaurar pan del mapa (en edición: solo con ESPACIO)
    try { map.dragging.enable(); } catch(_){}
    try { map.getContainer().classList.remove('buffer-dragging'); } catch(_){}
    try { data.circle.setStyle({ weight: isCustom ? 2 : 3, fillOpacity: isCustom ? 0.15 : 0.2 }); } catch(_){}

    markAsChanged();
    debounceAnalyzeOrphans();
    showNotification('Buffer reposicionado', 'info');
  });

  // Click sobre handle abre popup (si no está arrastrando)
  handle.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    if (!editMode && !deleteMode) {
      showBufferPopup(data, !!isCustom);
    }
  });

  // Guardar refs
  data.handle = handle;
  layers.bufferHandles.addLayer(handle);
  // Si no estamos en edición, evitar que bloquee clicks (aunque sea transparente)
  try {
    const el = (typeof handle.getElement === 'function') ? handle.getElement() : null;
    if (el) el.style.pointerEvents = editMode ? 'auto' : 'none';
  } catch(_){ }
}

function setHandlesEditingEnabled(enabled){
  if (!USE_BUFFER_HANDLES) return;
  // Mostrar/ocultar y habilitar/inhabilitar drag para handles
  layers.bufferHandles.eachLayer((h) => {
    try {
      h.setOpacity(enabled ? 1 : 0);
      const el = (typeof h.getElement === 'function') ? h.getElement() : null;
      if (el) el.style.pointerEvents = enabled ? 'auto' : 'none';
      if (enabled) h.dragging.enable();
      else h.dragging.disable();
    } catch(_){}
  });
}

// ==================== EDITING ====================
function enableBufferEditing() {
  // Detener animaciones durante edición para mejor rendimiento
  stopAnimations();

  // Comportamiento solicitado (como antes): arrastrar el círculo del buffer.
  // En edición desactivamos el pan del mapa para que el “cursor mano” no se robe el arrastre.
  // Si necesitas panear, mantén presionada la tecla ESPACIO (ver bindEditPanKeyHandlers).
  try { map.dragging.disable(); } catch (e) {}
  try { map.getContainer().style.cursor = 'default'; } catch (e) {}
  try { layers.bufferHandles.clearLayers(); } catch(_){ }
  showNotification("Modo edición: arrastra el círculo del buffer. Mantén ESPACIO para mover el mapa.", "info");
  setHandlesEditingEnabled(false);
  
  editableBuffers.forEach((data, ni) => {
    data.circle.setStyle({ color: '#f0883e', fillColor: '#f0883e', weight: 3, fillOpacity: 0.2 });
            setBufferInteractivity(data.circle, true); // PATCH: habilitar edición
// Fallback: permitir arrastre también desde el borde del círculo
    makeBufferDraggable(data.circle, data, false, ni);
    data.circle.on('click', (e) => { L.DomEvent.stopPropagation(e); if (editMode && !data.isDragging) showBufferPopup(data, false); });
  });
  // ✅ FIX: algunos buffers personalizados se crean/restauran fuera de modo edición,
  // y quedan con pointer-events: none. Al activar edición, habilitamos interactividad
  // para TODOS los buffers personalizados antes de enganchar el drag.
  customBuffers.forEach(buffer => {
    try { setBufferInteractivity(buffer.circle, true); } catch(_){ }
    makeBufferDraggable(buffer.circle, buffer, true);
  });
}

function disableBufferEditing() {
  setHandlesEditingEnabled(false);
  editableBuffers.forEach((data) => {
    data.circle.setStyle({ color: '#58a6ff', fillColor: '#58a6ff', weight: 2, fillOpacity: 0.08 });
    data.circle.off('mousedown');
    data.circle.off('click');
    setBufferInteractivity(data.circle, false); // PATCH: no bloquear clics en marcadores
  });

  // ✅ Consistencia: al salir de edición, deshabilitar handlers de drag y
  // devolver la interactividad de buffers personalizados al estado normal.
  customBuffers.forEach((buffer) => {
    try {
      buffer.circle.off('mousedown');
      buffer.circle.off('touchstart');
    } catch(_){ }
    try { setBufferInteractivity(buffer.circle, false); } catch(_){ }
  });

  // Salimos de edición: reactivar arrastre normal del mapa
  try { map.dragging.enable(); } catch (e) {}
  try { map.getContainer().style.cursor = ''; } catch (e) {}

  // Reactivar animaciones al terminar edición
  setTimeout(() => regenerateAnimations(), 500);
}

function bindEditPanKeyHandlers(){
  if (editPanKeyHandlersBound) return;
  editPanKeyHandlersBound = true;
  const onKeyDown = (ev) => {
    if (!editMode) return;
    // Espacio para panear el mapa
    if (ev.code === 'Space') {
      // Evita que haga scroll la página
      ev.preventDefault();
      if (editPanKeyDown) return;
      editPanKeyDown = true;
      try { map.dragging.enable(); } catch (e) {}
      try { map.getContainer().style.cursor = 'grab'; } catch (e) {}
    }
  };
  const onKeyUp = (ev) => {
    if (!editMode) return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      editPanKeyDown = false;
      // Volver a “drag de buffers”: deshabilitar pan del mapa
      try { map.dragging.disable(); } catch (e) {}
      try { map.getContainer().style.cursor = 'default'; } catch (e) {}
    }
  };
  // Guardar refs para poder remover
  window.__deceEditPanKeyDown = onKeyDown;
  window.__deceEditPanKeyUp = onKeyUp;
  document.addEventListener('keydown', onKeyDown, { capture: true });
  document.addEventListener('keyup', onKeyUp, { capture: true });
}

function unbindEditPanKeyHandlers(){
  if (!editPanKeyHandlersBound) return;
  editPanKeyHandlersBound = false;
  editPanKeyDown = false;
  const kd = window.__deceEditPanKeyDown;
  const ku = window.__deceEditPanKeyUp;
  if (kd) document.removeEventListener('keydown', kd, { capture: true });
  if (ku) document.removeEventListener('keyup', ku, { capture: true });
  delete window.__deceEditPanKeyDown;
  delete window.__deceEditPanKeyUp;
}

function makeBufferDraggable(circle, data, isCustom, ni = null) {
  // Importante: si se entra/sale varias veces de modo edición, evitamos duplicar handlers
  circle.off('mousedown');
  circle.off('touchstart');

  let isDragging = false;
  let rafId = null;
  let pendingLatLng = null;

  const startDrag = (startEvent) => {
    if (!editMode) return;
    // Importante: con renderer canvas, el evento Leaflet trae el DOM event en startEvent.originalEvent
    // Si no prevenimos el DOM event, el mapa se arrastra (cursor “mano”) y se pierde el drag del buffer.
    const domEv = startEvent?.originalEvent || startEvent;
    try {
      L.DomEvent.stopPropagation(domEv);
      L.DomEvent.preventDefault(domEv);
    } catch (e) {
      // fallback
      try { domEv?.stopPropagation?.(); domEv?.preventDefault?.(); } catch (e2) {}
    }

    isDragging = true;
    data.isDragging = true;
    // Mientras arrastramos un buffer, el mapa no debe moverse.
    try { map.dragging.disable(); } catch (e) {}

    circle.setStyle({ weight: 4, fillOpacity: 0.3 });

    const scheduleMove = (latlng) => {
      pendingLatLng = latlng;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        try {
          if (isDragging && pendingLatLng) circle.setLatLng(pendingLatLng);
          // mantener handle sincronizado si existe
          if (isDragging && pendingLatLng && data.handle) {
            try { data.handle.setLatLng(pendingLatLng); } catch(_){}
          }
        } finally {
          rafId = null;
        }
      });
    };

    // Usamos listeners en document para que SIEMPRE se capture mouseup/move
    const onDocMove = (ev) => {
      if (!isDragging) return;
      const latlng = map.mouseEventToLatLng(ev);
      scheduleMove(latlng);
    };
    const onDocUp = () => {
      if (!isDragging) return;
      isDragging = false;
      data.isDragging = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      pendingLatLng = null;

      // Al terminar, restaurar el estado de pan del mapa:
      // - Si seguimos en edición: solo permitir pan si se mantiene ESPACIO
      // - Si ya no estamos en edición: pan normal
      try {
        if (!editMode) {
          map.dragging.enable();
        } else {
          if (editPanKeyDown) map.dragging.enable();
          else map.dragging.disable();
        }
      } catch (e) {}
      circle.setStyle({ weight: isCustom ? 2 : 3, fillOpacity: isCustom ? 0.15 : 0.2 });

      document.removeEventListener('mousemove', onDocMove, true);
      document.removeEventListener('mouseup', onDocUp, true);
      document.removeEventListener('touchmove', onTouchMove, { passive: false, capture: true });
      document.removeEventListener('touchend', onDocUp, true);

      const pos = circle.getLatLng();
      try { if (data.handle) data.handle.setLatLng(pos); } catch(_){}
      data.currentPos = pos;
      if (isCustom) { data.lat = pos.lat; data.lng = pos.lng; }

      markAsChanged();
      debounceAnalyzeOrphans();
      showNotification("Buffer reposicionado", "info");
    };

    const onTouchMove = (ev) => {
      if (!isDragging) return;
      ev.preventDefault();
      const t = ev.touches && ev.touches[0];
      if (!t) return;
      const latlng = map.mouseEventToLatLng(t);
      scheduleMove(latlng);
    };

    // Captura en fase capture para ganar a otros handlers
    document.addEventListener('mousemove', onDocMove, true);
    document.addEventListener('mouseup', onDocUp, true);
    document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    document.addEventListener('touchend', onDocUp, true);
  };

  circle.on('mousedown', startDrag);
  circle.on('touchstart', startDrag);
}

function resetBufferPosition(ni) {
  const data = editableBuffers.get(ni);
  if (!data) return;
  data.circle.setLatLng([data.originalPos.lat, data.originalPos.lng]);
  try { if (data.handle) data.handle.setLatLng([data.originalPos.lat, data.originalPos.lng]); } catch(_){ }
  data.currentPos = data.originalPos;
  markAsChanged();
  debounceAnalyzeOrphans(); // Usar debouncing
  showNotification("✓ Posición restaurada", "info");
}
window.resetBufferPosition = resetBufferPosition;

function resetAllBuffersState() { if (confirm('¿Reiniciar todos los buffers?')) { clearBuffersState(); location.reload(); } }
window.resetAllBuffersState = resetAllBuffersState;

// ==================== ANIMATIONS ====================

// Dibuja conexiones forzadas (huérfanos) dentro de la misma capa de conexiones
// Nota: Se generan para todo satélite sin cobertura normal, asignándolo al núcleo más cercano.
function drawForcedConnections(targetLinesArray = null, targetGroup = null) {
  if (!SHOW_CONNECTION_LINES) return;
  if (!globalData || !orphanAnalysis?.forcedAssignments?.size) return;
  const { satellites, nucleos } = globalData;
  const group = targetGroup || layers.connections;

  orphanAnalysis.forcedAssignments.forEach((assign, si) => {
    const sat = satellites[si];
    const nuc = nucleos[assign.ni];
    if (!sat || !nuc) return;

    // Posición actual (si el buffer fue movido)
    const pos = getCurrentNucleoLatLng(assign.ni, nuc);
    const nucLat = pos.lat;
    const nucLng = pos.lng;

    const line = L.polyline(
      [[nucLat, nucLng], [sat.lat, sat.lng]],
      {
        color: '#111827',
        weight: 2,
        opacity: 0.75,
        dashArray: '8,12',
        renderer: connectionRenderer
      }
    );

    const tag = assign.distance <= ORPHAN_WARNING_DISTANCE_M ? "Apoyo (≤ 7.5 km)" : "Apoyo (> 7.5 km)";

    line.bindPopup(`
      <b>${tag}</b><br>
      Satélite: ${escapeHTML(sat.name)}<br>
      → Núcleo: ${escapeHTML(nuc.name)}<br>
      Distancia: ${(assign.distance / 1000).toFixed(2)} km
    `);

    line.addTo(group);
    line.bringToFront();
    if (targetLinesArray) targetLinesArray.push(line);
  });
}
function regenerateAnimations() {
  // Evita el “parpadeo”: calculamos nuevas líneas y solo al final reemplazamos las existentes.
  const tempGroup = L.featureGroup();
  const newLines = [];
  animationLines = [];
  if (!globalData) return;
  const { satellites } = globalData;

  // ✅ Conexiones visuales (limpias): 1 línea por NÚCLEO (fiscal seleccionado) hacia su SATÉLITE fiscal más cercano.
  //    - Evita “abanicos”/líneas duplicadas.
  //    - Corte duro: solo si la distancia ≤ 7.5 km.
  const nucleoCenters = getActiveNucleoCentersOnly();

  // Grid de satélites elegibles (solo fiscal, no excluidos 1–50)
  const eligibleSatPoints = [];
  satellites.forEach((sat, si) => {
    if (!isFiscalInstitution(sat) || !isSatellite51to120(sat)) return;
    if (!Number.isFinite(sat.lat) || !Number.isFinite(sat.lng)) return;
    eligibleSatPoints.push({ lat: sat.lat, lng: sat.lng, kind: 'satellite', si });
  });
  const satGrid = buildPointGrid(eligibleSatPoints);

  nucleoCenters.forEach(nc => {
    const hit = findClosestInGridWithin(satGrid, nc.lat, nc.lng, BUFFER_RADIUS_M, 1);
    if (!hit || !hit.point || !Number.isFinite(hit.point.si)) return;
    const sat = satellites[hit.point.si];
    if (!sat) return;

    const line = L.polyline(
      [[nc.lat, nc.lng], [sat.lat, sat.lng]],
      {
        color: '#111827',
        weight: 3,
        opacity: 0.85,
        renderer: connectionRenderer
      }
    );
    line.bringToFront();
    tempGroup.addLayer(line);
    newLines.push(line);
  });

  // ✅ Sin conexiones forzadas: el modelo es únicamente FISCAL NÚCLEO → FISCAL SATÉLITE (≤ 7.5 km).

  // Reemplazar al final (sin parpadeo)
  layers.connections.clearLayers();
  tempGroup.eachLayer(l => layers.connections.addLayer(l));
  animationLines = newLines;

  if (ENABLE_NETWORK_ANIMATION && animationLines.length <= MAX_CONNECTIONS_FOR_ANIM) startConnectionAnimation(animationLines);
}

function startConnectionAnimation(lines) {
  if (!SHOW_CONNECTION_LINES) return;
  stopAnimations();
  let offset = 0;
  _connectionAnimTimer = setInterval(() => {
    offset = (offset + 1) % 1000;
    lines.forEach(line => line.setStyle({ dashOffset: String(offset) }));
  }, 80);
}

function stopAnimations() { if (_connectionAnimTimer) { clearInterval(_connectionAnimTimer); _connectionAnimTimer = null; } }

// ==================== UTILITIES ====================
function showNotification(message, type = 'info') {
  const n = document.createElement('div');
  n.className = `notification notification-${type}`;
  n.innerHTML = `<div class="notification-content">${type === 'success' ? '✓' : type === 'info' ? 'ℹ' : '⚠'} ${message}</div>`;
  document.body.appendChild(n);
  setTimeout(() => n.classList.add('show'), 10);
  setTimeout(() => { n.classList.remove('show'); setTimeout(() => n.remove(), 300); }, 3500);
}




// ==================== HELPERS DE COBERTURA Y ASIGNACIÓN (DINÁMICO) ====================

function getCurrentNucleoLatLng(ni, nuc) {
  const bufData = editableBuffers.get(ni);
  const pos = bufData?.circle?.getLatLng ? bufData.circle.getLatLng() : null;
  if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) return { lat: pos.lat, lng: pos.lng };
  if (bufData?.currentPos && Number.isFinite(bufData.currentPos.lat) && Number.isFinite(bufData.currentPos.lng)) return bufData.currentPos;
  return { lat: nuc.lat, lng: nuc.lng };
}

function buildPointGrid(points) {
  const grid = new Map();
  for (const p of points) {
    const key = `${Math.floor(p.lat / GRID_CELL_DEG)},${Math.floor(p.lng / GRID_CELL_DEG)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  }
  return grid;
}

function findClosestInGridWithin(grid, lat, lng, maxDistM, ring = 1) {
  const cellLat = Math.floor(lat / GRID_CELL_DEG);
  const cellLng = Math.floor(lng / GRID_CELL_DEG);
  let minDist = Infinity;
  let best = null;

  for (let dLat = -ring; dLat <= ring; dLat++) {
    for (let dLng = -ring; dLng <= ring; dLng++) {
      const arr = grid.get(`${cellLat + dLat},${cellLng + dLng}`);
      if (!arr) continue;
      for (const p of arr) {
        const dist = haversineMeters(p.lat, p.lng, lat, lng);
        if (dist < minDist) { minDist = dist; best = p; }
      }
    }
  }
  if (best && minDist <= maxDistM) return { point: best, distance: minDist };
  return null;
}

function getActiveBufferCenters() {
  if (!globalData) return [];
  const centers = [];
  const { nucleos, selected } = globalData;

  // Buffers de núcleos seleccionados
  selected?.forEach?.(ni => {
    const nuc = nucleos?.[ni];
    if (!nuc) return;
    const pos = getCurrentNucleoLatLng(ni, nuc);
    centers.push({ kind: 'nucleo', ni, lat: pos.lat, lng: pos.lng });
  });

  // Buffers personalizados
  customBuffers.forEach(b => {
    const pos = b.circle?.getLatLng ? b.circle.getLatLng() : b.currentPos;
    if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return;
    centers.push({ kind: 'custom', id: b.id, lat: pos.lat, lng: pos.lng });
  });

  return centers;
}

// ✅ Regla de negocio: la atención/conexión se modela SOLO de FISCAL NÚCLEO → FISCAL SATÉLITE.
// Los buffers personalizados sirven para exploración/etiquetado (p.ej. B#) pero NO otorgan cobertura.
function getActiveNucleoCentersOnly() {
  if (!globalData) return [];
  const centers = [];
  const { nucleos, selected } = globalData;

  // Buffers de núcleos fiscales seleccionados
  selected?.forEach?.(ni => {
    const nuc = nucleos?.[ni];
    if (!nuc) return;
    // ✅ Regla de negocio: SOLO núcleos fiscales otorgan cobertura/conexión
    if (!isFiscalInstitution(nuc)) return;
    const pos = getCurrentNucleoLatLng(ni, nuc);
    centers.push({ kind: 'nucleo', ni, lat: pos.lat, lng: pos.lng });
  });

  return centers;
}

// Centros de cobertura "activa" para capas dinámicas:
// - Incluye núcleos fiscales seleccionados (buffers editables)
// - Incluye buffers personalizados (huérfanos / manuales)
// Objetivo: que "Satélites SIN Cobertura" muestre SOLO los satélites realmente fuera de CUALQUIER buffer visible.
function getActiveCoverageCenters() {
  const centers = [];
  // 1) Núcleos fiscales seleccionados
  try {
    const nucCenters = getActiveNucleoCentersOnly();
    nucCenters.forEach(c => centers.push(c));
  } catch (_) {}

  // 2) Buffers personalizados (si existen)
  try {
    (customBuffers || []).forEach((b, bi) => {
      const ll = b?.circle?.getLatLng?.();
      if (!ll) return;
      centers.push({ kind: 'custom', bi, lat: ll.lat, lng: ll.lng });
    });
  } catch (_) {}

  return centers;
}


function getCoverageInfoForSatellite(sat, activeBufferGrid) {
  // Retorna { covered: bool, dist: number|null }
  const hit = findClosestInGridWithin(activeBufferGrid, sat.lat, sat.lng, BUFFER_RADIUS_M, 1);
  if (hit) return { covered: true, dist: hit.distance };
  return { covered: false, dist: null };
}

function buildNucleoLookup(nucleos, selectedSet) {
  const all = [];
  const selected = [];
  const allByProv = new Map();
  const allByProvCant = new Map();
  const allByZona = new Map();
  const selByProv = new Map();
  const selByProvCant = new Map();
  const selByZona = new Map();

  nucleos.forEach((nuc, ni) => {
    if (!nuc) return;
    // ✅ SOLO núcleos fiscales son candidatos para asignación/atención
    if (!isFiscalInstitution(nuc)) return;
    const pos = getCurrentNucleoLatLng(ni, nuc);
    const entry = {
      ni,
      lat: pos.lat,
      lng: pos.lng,
      zona: Number.isFinite(nuc.zona) ? nuc.zona : null,
      codProvincia: Number.isFinite(nuc.codProvincia) ? nuc.codProvincia : null,
      codCanton: Number.isFinite(nuc.codCanton) ? nuc.codCanton : null
    };
    all.push(entry);

    if (Number.isFinite(entry.zona)) {
      if (!allByZona.has(entry.zona)) allByZona.set(entry.zona, []);
      allByZona.get(entry.zona).push(entry);
    }

    if (Number.isFinite(entry.codProvincia)) {
      if (!allByProv.has(entry.codProvincia)) allByProv.set(entry.codProvincia, []);
      allByProv.get(entry.codProvincia).push(entry);

      if (Number.isFinite(entry.codCanton)) {
        const key = `${entry.codProvincia}-${entry.codCanton}`;
        if (!allByProvCant.has(key)) allByProvCant.set(key, []);
        allByProvCant.get(key).push(entry);
      }
    }

    if (selectedSet?.has?.(ni)) {
      selected.push(entry);
      if (Number.isFinite(entry.zona)) {
        if (!selByZona.has(entry.zona)) selByZona.set(entry.zona, []);
        selByZona.get(entry.zona).push(entry);
      }
      if (Number.isFinite(entry.codProvincia)) {
        if (!selByProv.has(entry.codProvincia)) selByProv.set(entry.codProvincia, []);
        selByProv.get(entry.codProvincia).push(entry);

        if (Number.isFinite(entry.codCanton)) {
          const key = `${entry.codProvincia}-${entry.codCanton}`;
          if (!selByProvCant.has(key)) selByProvCant.set(key, []);
          selByProvCant.get(key).push(entry);
        }
      }
    }
  });

  return { all, selected, allByProv, allByProvCant, allByZona, selByProv, selByProvCant, selByZona };
}

function findClosestNucleoForOrphan(sat, lookup, preferSelected = true) {
  const prov = Number.isFinite(sat.codProvincia) ? sat.codProvincia : null;
  const cant = Number.isFinite(sat.codCanton) ? sat.codCanton : null;
  const zona = Number.isFinite(sat.zona) ? sat.zona : null;

  const useSel = preferSelected && lookup.selected.length > 0;

  // 1) Regla especial Galápagos: NO cruzar islas (canton) ni continente (provincia).
  if (prov === 20 && Number.isFinite(cant)) {
    const key = `${prov}-${cant}`;
    const pool = (useSel ? lookup.selByProvCant.get(key) : null) || lookup.allByProvCant.get(key) || [];
    if (!pool.length) return null; // se queda huérfano si no hay núcleo en su isla/cantón
    return findClosestFromPool(sat, pool);
  }

  // 2) Resto del país: preferir mismo cantón; luego misma provincia; luego misma zona; si no existe, usar el pool general.
  if (Number.isFinite(prov) && Number.isFinite(cant)) {
    const key = `${prov}-${cant}`;
    const poolCant = (useSel ? lookup.selByProvCant.get(key) : null) || lookup.allByProvCant.get(key) || [];
    if (poolCant.length) return findClosestFromPool(sat, poolCant);
  }

  if (Number.isFinite(prov)) {
    const poolProv = (useSel ? lookup.selByProv.get(prov) : null) || lookup.allByProv.get(prov) || [];
    if (poolProv.length) return findClosestFromPool(sat, poolProv);
  }

  if (Number.isFinite(zona)) {
    const poolZona = (useSel ? lookup.selByZona.get(zona) : null) || lookup.allByZona.get(zona) || [];
    if (poolZona.length) return findClosestFromPool(sat, poolZona);
  }

  // 3) Fallback: usar seleccionados o todos
  const pool = useSel ? lookup.selected : lookup.all;
  if (!pool.length) return null;
  return findClosestFromPool(sat, pool);
}

function findClosestFromPool(sat, pool) {
  let best = null;
  let minDist = Infinity;
  for (const n of pool) {
    const dist = haversineMeters(n.lat, n.lng, sat.lat, sat.lng);
    if (dist < minDist) { minDist = dist; best = n; }
  }
  if (!best) return null;
  return { ni: best.ni, distance: minDist };
}


// ========== FUNCIONES DE ANÁLISIS DE HUÉRFANOS ==========


function getBufferBCoveredSet(satellites, nucleos) {
  const covered = new Set();
  try {
    if (!Array.isArray(customBuffers) || !customBuffers.length) return covered;
    for (const buf of customBuffers) {
      const circle = buf?.circle;
      if (!circle) continue;
      const c = circle.getLatLng?.();
      if (!c) continue;

      // Criterio B# (buffers solo-satélite): NO hay núcleos fiscales dentro del radio
      let hasNucleo = false;
      for (let ni = 0; ni < (nucleos?.length || 0); ni++) {
        const n = nucleos[ni];
        if (!n) continue;
        const d = haversineMeters(c.lat, c.lng, n.lat, n.lng);
        if (d <= BUFFER_RADIUS_M) { hasNucleo = true; break; }
      }
      if (hasNucleo) continue;

      // Marcar satélites fiscales (51–120) dentro del buffer
      for (let si = 0; si < (satellites?.length || 0); si++) {
        const s = satellites[si];
        if (!s) continue;
        // satellites ya llega filtrado (fiscal 51–120), pero dejamos la verificación por seguridad
        if (!isFiscalInstitution(s) || !isSatellite51to120(s)) continue;
        const ds = haversineMeters(c.lat, c.lng, s.lat, s.lng);
        if (ds <= BUFFER_RADIUS_M) covered.add(si);
      }
    }
  } catch (e) {
    console.warn('[WARN] getBufferBCoveredSet falló:', e);
  }
  return covered;
}

function analyzeOrphans() {
  if (!globalData || !globalData.satellites || !globalData.nucleos) {
    console.log("[WARN] globalData no disponible para análisis");
    return;
  }

  console.log("=== ANÁLISIS DE HUÉRFANOS (DINÁMICO) ===");

  const { satellites, nucleos, selected } = globalData;

  // Limpiar
  orphanAnalysis.forcedAssignments.clear();
  orphanAnalysis.orphanSatellites.clear();
  orphanAnalysis.unservedSatellites.clear();
  orphanAnalysis.orphanNucleos.clear();

  // Índice dinámico de buffers (núcleos seleccionados con posición ACTUAL)
  const activeCenters = getActiveNucleoCentersOnly();
  const activeGrid = buildPointGrid(activeCenters);

  // Lookup de núcleos para referencia (respeta provincia/isla)
  const lookup = buildNucleoLookup(nucleos, selected);

  // Para identificar núcleos sin satélites (de los seleccionados)
  const hasAnySatellite = new Array(nucleos.length).fill(false);

  // Sets para coherencia de KPIs
  const normalCoveredSet = new Set();
  const notNormalIdx = [];

  let eligibleTotal = 0; // ✅ Solo satélites fiscales (51–120)

  // 1) Cobertura normal (núcleos seleccionados)
  satellites.forEach((sat, si) => {
    if (!isFiscalInstitution(sat) || !isSatellite51to120(sat)) return;
    eligibleTotal++;

    const hit = findClosestInGridWithin(activeGrid, sat.lat, sat.lng, BUFFER_RADIUS_M, 1);
    if (hit) {
      normalCoveredSet.add(si);
      if (hit.point?.kind === 'nucleo' && Number.isFinite(hit.point.ni)) {
        hasAnySatellite[hit.point.ni] = true;
      }
    } else {
      notNormalIdx.push(si);
    }
  });

  // 2) Cobertura por Buffers B# (buffers personalizados que NO tienen núcleos dentro)
  const bCoveredSet = getBufferBCoveredSet(satellites, nucleos);

  // 3) Satélites realmente fuera de alcance (ni Núcleo, ni Buffer B#)
  for (const si of notNormalIdx) {
    if (bCoveredSet.has(si)) continue; // ya cuenta como cubierto por B#

    orphanAnalysis.orphanSatellites.add(si);
    const sat = satellites[si];
    const closest = findClosestNucleoForOrphan(sat, lookup, true);
    if (closest) {
      orphanAnalysis.unservedSatellites.set(si, { ni: closest.ni, distance: closest.distance });
    }
  }

  // Núcleos huérfanos (solo seleccionados) — huérfano = no cubre satélites en cobertura normal
  selected?.forEach?.(ni => {
    if (!hasAnySatellite[ni]) orphanAnalysis.orphanNucleos.add(ni);
  });

  // Stats coherentes con el mapa + buffers B#
  const normalCovered = normalCoveredSet.size;
  const bCovered = bCoveredSet.size;
  const totalCovered = new Set([...normalCoveredSet, ...bCoveredSet]).size;
  const tooFar = orphanAnalysis.orphanSatellites.size;

  orphanAnalysis.stats = {
    eligibleTotal,
    total: eligibleTotal,
    normalCovered,
    bufferBCovered: bCovered,
    forcedCovered: 0,
    totalCovered,
    tooFar,
    unserved: tooFar,
    normalPercent: eligibleTotal ? ((normalCovered / eligibleTotal) * 100).toFixed(2) : "0.00",
    totalPercent: eligibleTotal ? ((totalCovered / eligibleTotal) * 100).toFixed(2) : "0.00"
  };

  console.log("Total (satélites fiscales elegibles):", eligibleTotal);
  console.log("Normal:", normalCovered, `(${orphanAnalysis.stats.normalPercent}%)`);
  console.log("Buffers B#:", bCovered);
  console.log("TOTAL:", totalCovered, `(${orphanAnalysis.stats.totalPercent}%)`);
  console.log("Fuera de alcance (>7.5km):", tooFar);
  console.log("Huérfanos (núcleos):", orphanAnalysis.orphanNucleos.size);

  updateOrphanPanel();
  refreshSatellitesLayer();
  regenerateAnimations();
  // (B#) Recalcular buffers huérfanos y etiquetas (para exportación + mapa)
  updateOrphanBuffers();
}


function updateOrphanPanel() {
  const panel = document.getElementById('orphanStatsPanel');
  if (!panel) {
    console.warn("Panel no encontrado");
    return;
  }
  
  const s = orphanAnalysis.stats;
  
  panel.innerHTML = `
    <div class="orphan-stat">
      <div class="stat-label">Total satélites (FISCAL 51–120)</div>
      <div class="stat-value">${s.eligibleTotal.toLocaleString()}</div>
      <div class="stat-sub">Base de estudio</div>
    </div>
    <div class="orphan-stat">
      <div class="stat-label">Cobertura Normal (FISCAL 51–120)</div>
      <div class="stat-value">${s.normalPercent}%</div>
      <div class="stat-sub">${s.normalCovered} satélites</div>
    </div>
    <div class="orphan-stat">
      <div class="stat-label">Asignación Forzada</div>
      <div class="stat-value">0</div>
      <div class="stat-sub">(deshabilitada)</div>
    </div>
    <div class="orphan-stat warn">
      <div class="stat-label">Fuera de alcance (&gt;7.5km)</div>
      <div class="stat-value">${s.tooFar}</div>
      <div class="stat-sub">satélites sin atención</div>
    </div>
    <div class="orphan-stat highlight">
      <div class="stat-label">COBERTURA TOTAL</div>
      <div class="stat-value-big">${s.totalPercent}%</div>
      <div class="stat-sub">${s.totalCovered} de ${s.total}</div>
    </div>
    <div class="orphan-stat">
      <div class="stat-label">Núcleos Huérfanos</div>
      <div class="stat-value">${orphanAnalysis.orphanNucleos.size}</div>
      <div class="stat-sub">sin satélites</div>
    </div>
  `;
  
  console.log("✅ Panel actualizado");
}

function drawOrphanConnections() {
  if (!SHOW_CONNECTION_LINES) return;
  console.log("🎨 Dibujando líneas...");
  
  if (!layers.orphanConnections) {
    layers.orphanConnections = L.featureGroup().addTo(map);
  } else {
    layers.orphanConnections.clearLayers();
  }
  
  if (!globalData) return;
  
  const { satellites, nucleos } = globalData;
  let count = 0;
  
  orphanAnalysis.forcedAssignments.forEach((assign, si) => {
    const sat = satellites[si];
    const nuc = nucleos[assign.ni];
    if (!sat || !nuc) return;
    
    const bufData = editableBuffers.get(assign.ni);
    const nucLat = bufData?.currentPos?.lat || nuc.lat;
    const nucLng = bufData?.currentPos?.lng || nuc.lng;
    
    const line = L.polyline(
      [[sat.lat, sat.lng], [nucLat, nucLng]],
      {
        color: '#ff9800',
        weight: 2,
        opacity: 0.6,
        dashArray: '5,10',
        renderer: connectionRenderer
      }
    );
    
    line.bindPopup(`
      <b>Asignación Forzada</b><br>
      Satélite: ${sat.name}<br>
      → Núcleo: ${nuc.name}<br>
      Distancia: ${(assign.distance / 1000).toFixed(2)} km
    `);
    
    layers.orphanConnections.addLayer(line);
    count++;
  });
  
  console.log(`✅ ${count} líneas dibujadas`);
}




// ========== CONECTAR SATÉLITES DESATENDIDOS ==========
function connectUnattendedSatellites(nucleos, satellites, satCandidates, selected) {
  console.log("🔗 Analizando satélites desatendidos...");
  
  satelliteConnections.clear();
  let normalCovered = 0;
  let newConnections = 0;
  let orphansRemaining = 0;
  let longConnections = 0;
  
  const WARNING_DISTANCE = ORPHAN_WARNING_DISTANCE_M; // 7 km
  const MAX_CONNECTION_DISTANCE = WARNING_DISTANCE; // corte duro: no conectar si supera 7 km
  
  satellites.forEach((sat, si) => {
    let isCovered = false;
    
    // Verificar cobertura normal (dentro de buffer)
    if (satCandidates[si]) {
      satCandidates[si].forEach(c => {
        if (selected.has(c.ni) && c.dist <= BUFFER_RADIUS_M) {
          isCovered = true;
        }
      });
    }
    
    if (isCovered) {
      normalCovered++;
    } else {
      // Buscar núcleo más cercano
      let closestNi = null;
      let minDist = MAX_CONNECTION_DISTANCE + 1;
      
      for (let ni = 0; ni < nucleos.length; ni++) {
        const nuc = nucleos[ni];
        // Regla: FISCAL NÚCLEO -> FISCAL SATÉLITE (ignorar otros sostenimientos)
        if (!isFiscalOnly(nuc.sostenimiento) || !isFiscalOnly(sat.sostenimiento)) continue;
        // Respetar límites distritales
        if (normalizeDistrictCode(nuc.dist) !== normalizeDistrictCode(sat.dist)) continue;

        const dist = map.distance([sat.lat, sat.lng], [nuc.lat, nuc.lng]);
        if (dist <= MAX_CONNECTION_DISTANCE && dist < minDist) {
          minDist = dist;
          closestNi = ni;
        }
      }
if (closestNi !== null) {
        satelliteConnections.set(si, {
          ni: closestNi,
          distance: minDist,
          animated: true
        });
        newConnections++;
      } else {
        orphansRemaining++;
      }
    }
  });
  
  connectionStats = {
    total: satellites.length,
    normalCovered: normalCovered,
    connected: newConnections,
    orphans: orphansRemaining,
    normalCoveragePercent: ((normalCovered / satellites.length) * 100).toFixed(2),
    totalCoveragePercent: (((normalCovered + newConnections) / satellites.length) * 100).toFixed(2)
  };
  
  console.log("📊 Resultados:");
  console.log(`  Total satélites: ${connectionStats.total}`);
  console.log(`  Cobertura normal: ${normalCovered} (${connectionStats.normalCoveragePercent}%)`);
  console.log(`  Nuevas conexiones: ${newConnections}`);
  console.log(`  Cobertura TOTAL: ${normalCovered + newConnections} (${connectionStats.totalCoveragePercent}%)`);
  console.log(`  Conexiones extendidas (>7km): ${longConnections}`);
  console.log(`  Sin núcleo seleccionado: ${orphansRemaining}`);
  
  return connectionStats;
}

// ========== DIBUJAR CONEXIONES ANIMADAS ==========
function drawAnimatedConnections(nucleos, satellites) {
  if (!SHOW_CONNECTION_LINES) return;
  console.log("🎨 Dibujando conexiones animadas...");
  
  if (!layers.connections) {
    layers.connections = L.featureGroup();
    // PATCH: no añadir al mapa (capa deshabilitada)
    try { if (map && map.hasLayer && map.hasLayer(layers.connections)) map.removeLayer(layers.connections); } catch(_) {}
  } else {
    layers.connections.clearLayers();
  }
  
  let drawnCount = 0;
  
  satelliteConnections.forEach((conn, si) => {
    const sat = satellites[si];
    const nuc = nucleos[conn.ni];
    if (!sat || !nuc) return;
    
    const bufferData = editableBuffers.get(conn.ni);
    const nucLat = bufferData?.currentPos?.lat || nuc.lat;
    const nucLng = bufferData?.currentPos?.lng || nuc.lng;
    
    // Crear línea animada
    const line = L.polyline(
      [[sat.lat, sat.lng], [nucLat, nucLng]],
      {
        color: '#d29922',
        weight: 2,
        opacity: 0.7,
        dashArray: '10, 15',
        className: 'animated-connection',
        renderer: connectionRenderer
      }
    );
    
    line.bindPopup(`
      <div style="font-family: system-ui;">
        <b style="color: #d29922;">🔗 Conexión Servicio</b><br>
        <b>Satélite:</b> ${sat.name}<br>
        <b>→ Núcleo:</b> ${nuc.name}<br>
        <b>Distancia:</b> ${(conn.distance / 1000).toFixed(2)} km<br>
        <b>Estado:</b> <span style="color: #d29922;">✓ Conectado</span>
      </div>
    `);
    
    layers.connections.addLayer(line);
    drawnCount++;
  });
  
  console.log(`✅ ${drawnCount} conexiones dibujadas`);
  
  // Agregar animación CSS
  addConnectionAnimation();
}

// ========== AGREGAR ANIMACIÓN CSS ==========
function addConnectionAnimation() {
  if (!SHOW_CONNECTION_LINES) return;
  const styleId = 'connection-animation-style';
  if (document.getElementById(styleId)) return;
  
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    @keyframes dash-flow {
      0% {
        stroke-dashoffset: 25;
      }
      100% {
        stroke-dashoffset: 0;
      }
    }
    
    .animated-connection {
      animation: dash-flow 2s linear infinite;
    }
    
    @keyframes pulse-glow {
      0%, 100% {
        opacity: 0.7;
      }
      50% {
        opacity: 1;
      }
    }
  `;
  
  document.head.appendChild(style);
}




// ========== ACTUALIZAR DISPLAY DE COBERTURA ==========
function updateCoverageDisplay(stats) {
  // Buscar el elemento de cobertura en la UI
  const coverageElement = document.querySelector('.coverage-value, #coverage-stat, [class*="cobertura"]');
  
  if (coverageElement) {
    const improvement = (parseFloat(stats.totalCoveragePercent) - parseFloat(stats.normalCoveragePercent)).toFixed(1);
    coverageElement.innerHTML = `
      <div style="text-align: center;">
        <div style="font-size: 2em; color: #d29922;">${stats.totalCoveragePercent}%</div>
        <div style="font-size: 0.8em; color: #8b949e;">
          Base: ${stats.normalCoveragePercent}% 
          <span style="color: #d29922;">+${improvement}%</span>
        </div>
      </div>
    `;
  }
  
  console.log(`📈 Mejora de cobertura: +${(parseFloat(stats.totalCoveragePercent) - parseFloat(stats.normalCoveragePercent)).toFixed(2)}%`);
}


function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function escapeHTML(str) { return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }

function flyToLocation(lat, lng) { map.flyTo([lat, lng], 12, { duration: 1.2 }); }
window.flyToLocation = flyToLocation;

// ==================== CSV LOADING ====================
function loadCSV() {
  console.log("[LOAD] Iniciando carga CSV...");
  const overlay = document.getElementById("loadingOverlay");
  const setText = (main, sub = "") => { 
    console.log("[LOAD] setText:", main, sub);
    if (overlay) { 
      overlay.querySelector(".loading-text").textContent = main; 
      const s = document.getElementById("loadingSubtext"); 
      if (s) s.textContent = sub; 
    } 
  };
  
  if (!window.Papa) { 
    console.error("[ERROR] PapaParse no disponible");
    setText("Falta PapaParse"); 
    return; 
  }
  console.log("[OK] PapaParse disponible");
  
  setText("Cargando CSV...", "DECE_CRUCE_X_Y_NUC_SAT.csv");
  
  console.log("[LOAD] Iniciando fetch...");
  fetch("DECE_CRUCE_X_Y_NUC_SAT.csv", { cache: "no-store" })
    .then(res => { 
      console.log("[FETCH] Status:", res.status, "OK:", res.ok);
      if (!res.ok) throw new Error(`HTTP ${res.status}`); 
      return res.text(); 
    })
    .then(rawText => {
      console.log("[OK] CSV cargado, tamaño:", rawText.length);
      let text = rawText.replace(/^\uFEFF/, "");
      const firstLine = text.split(/\r?\n/, 1)[0] || "";
      const delim = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ";" : ",";
      console.log("[PARSE] Delimiter:", delim);
      console.log("[PARSE] Primera línea:", firstLine.substring(0, 100));
      setText("Procesando...", `Delimiter: ${delim}`);
      Papa.parse(text, {
        delimiter: delim, skipEmptyLines: "greedy", worker: false,
        complete: (results) => { 
          console.log("[PARSE] Completado, rows:", results.data.length);
          try { 
            handleParsed(results); 
          } catch (e) { 
            console.error("[ERROR] handleParsed:", e);
            setText("Error procesando CSV"); 
          } 
        },
        error: (err) => { 
          console.error("[ERROR] Papa.parse:", err);
          setText("Error leyendo CSV"); 
        }
      });
    })
    .catch(err => { 
      console.error("[ERROR] Fetch falló:", err);
      console.error("[ERROR] Detalles:", err.message);
      setText("Error cargando CSV: " + err.message); 
    });
  
  function handleParsed(results) {
    const rows = results.data || [];
    if (!rows.length) { setText("CSV vacío"); return; }
    const resolved = resolveColumnIndexes(rows[0] || []);
    const mapped = mapRowsToData(rows, resolved.idx);
    // Guardar dataset completo (todas las filas válidas) para exportaciones adicionales.
    window._rawRowsForExport = mapped.data;
    // Índice rápido por AMIE para búsquedas (basado en el CSV ya parseado)
    window._amieIndex = new Map();
    for (const d of mapped.data) {
      const a = (d?.amie || "").trim().toUpperCase();
      if (!a) continue;
      if (!window._amieIndex.has(a)) window._amieIndex.set(a, d);
    }

    if (!mapped.data.length) { setText("No hay registros válidos"); return; }
    if (mapped.bounds?.isValid()) map.fitBounds(mapped.bounds.pad(0.10), { animate: false });
    processData(mapped.data);
  }
}

// === PATCH (v3): asegurar clic en marcadores aunque existan buffers ===
function setBufferInteractivity(circle, enabled){
  try { circle.options.interactive = !!enabled; } catch(_){}
  try {
    const el = (typeof circle.getElement === 'function') ? circle.getElement() : null;
    if (el) el.style.pointerEvents = enabled ? 'auto' : 'none';
  } catch(_){}
}


function resolveColumnIndexes(headerRow) {
  const norm = s => String(s ?? "").replace(/^\uFEFF/, "").trim().toLowerCase();
  const header = headerRow.map(norm);
  const find = (candidates) => {
    for (let c of candidates) {
      const idx = header.findIndex(h => h.includes(c));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  // Preferimos COORD_DECE para clasificar (0 satélite, 1/2/3 núcleo). Si no existe, caemos a COD_GDECE.
  const idxCodGdece = find(["cod_gdece", "cod gdece"]);
  const idxCoordDece = find(["coord_dece", "coord dece"]);
  const idxJornadas = find(["jornadas", "jornada"]);
  // En el CSV viene como "PO_ProfDECE"
  const idxPoProfDece = find(["po_profdece"]);
  // En el CSV viene como "DECE NUCLEO" (con espacio)
  const idxDeceNucleo = find(["dece nucleo", "dece_nucleo"]);
  const idxAmieNucleo = find(["amie_nucleo", "amie nucleo"]);
  const idxJurisdiccion = find(["jurisdic"]);

  return {
    idx: {
      lat: find(["lat", "latitud"]),
      lon: find(["lon", "longitud", "lng"]),
      typeCode: idxCoordDece >= 0 ? idxCoordDece : idxCodGdece,
      codGDECE: idxCodGdece,
      name: find(["nombre_ie", "nombre_institución", "nombre institucion", "nombre"]),
      dist: find(["distrito"]),
      zona: find(["zona"]),
      students: find(["total estudiantes", "estudiantes"]),
      amie: find(["amie"]),
      provincia: find(["provincia"]),
      codProvincia: find(["cod_provincia", "cod provincia", "cod_prov"]),
      canton: find(["cantón", "canton"]),
      codCanton: find(["cod_cantón", "cod canton", "cod_cant"])
      ,
      // Filtros (solo fiscales / grupo DECE)
      sostenimiento: find(["sostenimiento"]),
      ieFiscales: find(["ie_fiscales", "ie fiscales"]),
      grupoDece: find(["grupo_dece", "grupo dece"]),
      // PO_ProfDECE viene en tu CSV como campo de registros administrativos.
      profDece: idxPoProfDece >= 0 ? idxPoProfDece : find(["po_profdece", "profesionales", "prof_dece", "prof dece", "profesional_dece", "n_profesionales", "dece_prof"]),
      // Campos para exportación (tabla GIEE)
      jornadas: idxJornadas,
      coordDece: idxCoordDece,
      deceNucleo: idxDeceNucleo,
      amieNucleo: idxAmieNucleo
    },
    issues: []
  };
}


function mapRowsToData(rows, idx) {
  const data = [], bounds = L.latLngBounds();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r?.length) continue;

    const lat = parseFloat(String(r[idx.lat] || "").replace(",", "."));
    const lng = parseFloat(String(r[idx.lon] || "").replace(",", "."));

    const typeCode = parseInt(String(r[idx.typeCode] || "").trim(), 10);
    const codGDECE = idx.codGDECE >= 0 ? parseInt(String(r[idx.codGDECE] || "").trim(), 10) : null;

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(typeCode)) continue;

    const name = idx.name >= 0 ? String(r[idx.name] || "").trim() : "";
    const dist = idx.dist >= 0 ? String(r[idx.dist] || "").trim() : "";

    const zonaRaw = idx.zona >= 0 ? String(r[idx.zona] || "").trim() : "";
    const zonaNum = zonaRaw ? parseInt((zonaRaw.match(/\d+/) || [""])[0], 10) : NaN;
    const zona = Number.isFinite(zonaNum) ? zonaNum : null;
    const students = idx.students >= 0 ? parseInt(String(r[idx.students] || "0").replace(/\D/g, ""), 10) || 0 : 0;
    const amie = idx.amie >= 0 ? String(r[idx.amie] || "").trim() : "";

    const provincia = idx.provincia >= 0 ? String(r[idx.provincia] || "").trim() : "";
    const codProvinciaRaw = idx.codProvincia >= 0 ? parseInt(String(r[idx.codProvincia] || "").trim(), 10) : NaN;
    const codProvincia = Number.isFinite(codProvinciaRaw) ? codProvinciaRaw : null;
    const canton = idx.canton >= 0 ? String(r[idx.canton] || "").trim() : "";
    const codCantonRaw = idx.codCanton >= 0 ? parseInt(String(r[idx.codCanton] || "").trim(), 10) : NaN;
    const codCanton = Number.isFinite(codCantonRaw) ? codCantonRaw : null;

    const sostenimiento = idx.sostenimiento >= 0 ? String(r[idx.sostenimiento] || "").trim() : "";
    const jurisdiccion = idx.jurisdiccion >= 0 ? String(r[idx.jurisdiccion] || "").trim() : "";
    const ieFiscalesRaw = idx.ieFiscales >= 0 ? String(r[idx.ieFiscales] || "").trim() : "";
    const ieFiscales = ieFiscalesRaw === "1" || ieFiscalesRaw.toLowerCase() === "si" || ieFiscalesRaw.toLowerCase() === "sí";
    const grupoDece = idx.grupoDece >= 0 ? String(r[idx.grupoDece] || "").trim() : "";
    const profDeceRaw = idx.profDece >= 0 ? String(r[idx.profDece] || "").trim() : "";
    const profDece = idx.profDece >= 0 ? (parseInt(String(r[idx.profDece] || "0").replace(/\D/g, ""), 10) || 0) : null;

    // Campos para exportación estilo GIEE (según tu tabla)
    const jornadasRaw = idx.jornadas >= 0 ? String(r[idx.jornadas] || "").trim() : "";
    const jornadas = idx.jornadas >= 0 ? (parseInt(jornadasRaw.replace(/\D/g, ""), 10) || 0) : null;

    const coordDeceRaw = idx.coordDece >= 0 ? String(r[idx.coordDece] || "").trim() : "";
    const coordDece = idx.coordDece >= 0 ? (parseInt(coordDeceRaw, 10) || 0) : null;

    const deceNucleoRaw = idx.deceNucleo >= 0 ? String(r[idx.deceNucleo] || "").trim() : "";
    const deceNucleo = idx.deceNucleo >= 0 ? (parseInt(deceNucleoRaw.replace(/\D/g, ""), 10) || 0) : null;

    const amieNucleo = idx.amieNucleo >= 0 ? String(r[idx.amieNucleo] || "").trim() : "";

    data.push({
      lat, lng,
      code: typeCode,
      codGDECE,
      name, dist, zona, students, amie,
      provincia, codProvincia, canton, codCanton,
      sostenimiento,
      jurisdiccion,
      ieFiscales,
      ieFiscalesRaw,
      grupoDece,
      profDece,
      profDeceRaw,
      jornadas,
      jornadasRaw,
      coordDece,
      coordDeceRaw,
      deceNucleo,
      deceNucleoRaw,
      amieNucleo
    });
    bounds.extend([lat, lng]);
  }
  return { data, bounds };
}

function isFiscalInstitution(row) {
  // Priorizamos IE_Fiscales si existe. Si no, caemos a Sostenimiento.
  if (row?.ieFiscales === true) return true;
  const sost = String(row?.sostenimiento || "").toUpperCase();
  // Aceptar "FISCAL" y excluir "FISCOMISIONAL" (y otras variantes que a veces se cuelan)
  if (!sost.includes("FISCAL")) return false;
  if (sost.includes("FISCOMISIONAL")) return false;
  return true;
}

function isSatellite51to120(row) {
  const g = String(row?.grupoDece || "");
  if (/51\s*a\s*120/i.test(g)) return true;
  const n = Number(row?.students);
  return Number.isFinite(n) && n >= 51 && n <= 120;
}


function processData(data) {
  layers.nucleos.clearLayers();
  layers.nucleosOther.clearLayers();
  layers.satellites.clearLayers();
  layers.satellitesUncovered.clearLayers();
  layers.satellitesOther.clearLayers();
  layers.satellitesExcluded.clearLayers();
  layers.buffers.clearLayers();
  layers.bufferHandles.clearLayers();
  layers.bufferLabels.clearLayers();
  layers.connections.clearLayers();
  layers.animations.clearLayers();
  editableBuffers.clear(); stopAnimations();

  // Nota: el análisis se hace SOLO sobre fiscales (núcleos + satélites),
  // pero en el mapa se dibujan también No Fiscales y Excluidos (1–50) con colores.
  
  // Detectar códigos de tipo (satélite vs núcleo) de forma robusta.
// Soporta datasets típicos:
//   - COORD_DECE: 0 = satélite, 1/2/3 = núcleo
//   - CODE:       2 = satélite, 3/4/5 = núcleo
const counts = {};
data.forEach(d => {
  const c = Number(d.code);
  if (!Number.isFinite(c)) return;
  counts[c] = (counts[c] || 0) + 1;
});
const codes = Object.keys(counts).map(Number);

const has013 = counts[0] && (counts[1] || counts[2] || counts[3]);
const has235 = counts[2] && (counts[3] || counts[4] || counts[5]);

let satelliteCodes = [];
let nucleoCodes = [];

if (has013 && !has235) {
  satelliteCodes = [0];
  nucleoCodes = [1, 2, 3];
} else if (has235 && !has013) {
  satelliteCodes = [2];
  nucleoCodes = [3, 4, 5];
} else if (has013 && has235) {
  // Ambiguo: elegir el código más frecuente como satélite (normalmente hay MUCHOS más satélites).
  const sorted = [...codes].sort((a,b) => (counts[b]||0) - (counts[a]||0));
  const sat = sorted[0];
  satelliteCodes = [sat];
  nucleoCodes = sorted.slice(1);
} else {
  // Fallback: elegir el código más frecuente como satélite y el resto como núcleos.
  const sorted = [...codes].sort((a,b) => (counts[b]||0) - (counts[a]||0));
  const sat = sorted[0];
  satelliteCodes = [sat];
  nucleoCodes = sorted.slice(1);
}

let nucleos = data.filter(d => nucleoCodes.includes(Number(d.code)));
let satellitesAll = data.filter(d => satelliteCodes.includes(Number(d.code)));

// 1) Separar capas: excluidos (1–50), no fiscales y fiscales (para análisis)
const satellitesExcluded = satellitesAll.filter(isExcludedGroup1to50);
// No-fiscales o fuera de alcance del estudio (Fiscal 51–120)
const satellitesOther = satellitesAll.filter(s => !isExcludedGroup1to50(s) && (!isFiscalInstitution(s) || !isSatellite51to120(s)));
// ✅ Satélites de estudio: únicamente FISCAL y grupo DECE 51–120 (≈1415 registros en tu dataset)
const satellites = satellitesAll.filter(s => isFiscalInstitution(s) && isSatellite51to120(s)); // análisis (FISCAL 51–120)

const nucleosOther = nucleos.filter(n => !isFiscalInstitution(n));
nucleos = nucleos.filter(n => isFiscalInstitution(n)); // análisis

console.log(`[FILTER] Satélites análisis (Fiscales, 51–120): ${satellites.length}/${satellitesAll.length}`);
console.log(`[FILTER] Satélites excluidos (1–50): ${satellitesExcluded.length}`);
console.log(`[FILTER] Satélites no fiscales: ${satellitesOther.length}`);
console.log(`[FILTER] Núcleos análisis (Fiscales): ${nucleos.length}`);
console.log(`[FILTER] Núcleos no fiscales: ${nucleosOther.length}`);

console.log("[DATA] Códigos detectados:", { counts, satelliteCodes, nucleoCodes, nucleos: nucleos.length, satellites: satellites.length });
if (!nucleos.length || !satellites.length) {
  console.warn("[DATA] No se detectaron núcleos o satélites. Revisa columnas y códigos.");
  hideLoadingOverlay();
  // Actualizar panel para no quedarse en "Cargando análisis..."
  const panel = document.getElementById("orphanStatsPanel");
  if (panel) {
    panel.innerHTML = `
      <div style="text-align:center; color:#ff7b72; padding:10px;">
        No se pudieron detectar núcleos/satélites.<br/>
        <span style="color:#8b949e; font-size:12px;">Códigos detectados: ${codes.join(", ") || "ninguno"}</span>
      </div>
    `;
  }
  return;
}
  
  const spatialIndex = buildSpatialIndex(satellites);
  const satCandidates = findCandidates(nucleos, satellites, spatialIndex);
  const result = setCoverGreedy(nucleos, satellites, satCandidates);
  const nucleoStats = buildNucleoStats(nucleos, satellites, satCandidates);
  
  // Guardar globalData COMPLETO para analyzeOrphans / export
  globalData = { nucleos, satellites, satCandidates, selected: result.selected, nucleosOther, satellitesOther, satellitesExcluded };

  // Dibujo: otros primero (debajo), fiscales encima
  drawNucleosOther(nucleosOther);
  drawNucleos(nucleos, result.selected);
  drawBuffersEditable(nucleos, result.selected, nucleoStats);
  drawSatellitesExcluded(satellitesExcluded);
  drawSatellitesOther(satellitesOther);
  drawSatellites(satellites, satCandidates, result.selected);
  regenerateAnimations();
  
  const stats = computeStatistics(nucleos, satellites, satCandidates, result.selected, nucleoStats);
  updateStatistics(stats);
  updateTopNucleos(nucleoStats);
  
  hideLoadingOverlay();
  console.log(`✓ ${nucleos.length} núcleos, ${satellites.length} satélites`);
  
  // ========== APOYO A HUÉRFANOS (SOLO NO CUBIERTOS) ==========
  setTimeout(() => {
    // Evitar duplicar capas antiguas de conexión
    if (layers.satelliteConnections) layers.satelliteConnections.clearLayers();
    satelliteConnections?.clear?.();
    analyzeOrphans();
  }, 900);

}

function buildSpatialIndex(satellites) {
  const grid = new Map();
  satellites.forEach((s, i) => { const key = `${Math.floor(s.lat / GRID_CELL_DEG)},${Math.floor(s.lng / GRID_CELL_DEG)}`; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(i); });
  return grid;
}

function findCandidates(nucleos, satellites, spatialIndex) {
  const satCandidates = Array.from({ length: satellites.length }, () => []);
  nucleos.forEach((n, ni) => {
    const cellLat = Math.floor(n.lat / GRID_CELL_DEG), cellLng = Math.floor(n.lng / GRID_CELL_DEG);
    for (let dLat = -2; dLat <= 2; dLat++) for (let dLng = -2; dLng <= 2; dLng++) {
      (spatialIndex.get(`${cellLat + dLat},${cellLng + dLng}`) || []).forEach(si => {
        const dist = haversineMeters(n.lat, n.lng, satellites[si].lat, satellites[si].lng);
        if (dist <= BUFFER_RADIUS_M) satCandidates[si].push({ ni, dist });
      });
    }
  });
  satCandidates.forEach(cands => cands.sort((a, b) => a.dist - b.dist));
  return satCandidates;
}

function setCoverGreedy(nucleos, satellites, satCandidates) {
  const uncovered = new Set(satCandidates.map((c, i) => c.length > 0 ? i : -1).filter(i => i >= 0));
  const selected = new Set();
  const nucleoStats = buildNucleoStats(nucleos, satellites, satCandidates);
  while (uncovered.size > 0 && selected.size < MAX_BUFFERS) {
    if (uncovered.size / satellites.length <= (1 - TARGET_COVERAGE)) break;
    let bestNi = -1, bestCount = 0;
    nucleos.forEach((_, ni) => {
      if (selected.has(ni) || nucleoStats[ni].satIdx.length < MIN_SATS_PER_BUFFER) return;
      let count = nucleoStats[ni].satIdx.filter(si => uncovered.has(si)).length;
      if (count > bestCount) { bestCount = count; bestNi = ni; }
    });
    if (bestNi < 0) break;
    selected.add(bestNi);
    nucleoStats[bestNi].satIdx.forEach(si => uncovered.delete(si));
  }
  return { selected, uncovered };
}

function buildNucleoStats(nucleos, satellites, satCandidates) {
  const stats = nucleos.map(n => ({ satIdx: [], totalStudents: 0, nucleo: n }));
  satCandidates.forEach((cands, si) => {
    if (cands.length > 0) stats[cands[0].ni].satIdx.push(si);
  });
  stats.forEach(st => {
    st.satIdx.forEach(si => { st.totalStudents += satellites[si]?.students || 0; });
  });
  return stats;
}

function drawNucleos(nucleos, selected) {
  nucleos.forEach((n, ni) => {
    const isSelected = selected.has(ni);
    // Núcleos: estilo fijo (no depende de cobertura ni sostenimiento)
    const nucleoStyle = { fill: '#dc2626', stroke: '#7f1d1d' };
    const _sats = globalData?.satellites || [];
    let satCount = 0;
    let satStudents = 0;
    // Cobertura por núcleo (solo satélites del estudio: FISCAL 51–120)
    for (let i = 0; i < _sats.length; i++) {
      const s = _sats[i];
      const d = haversineMeters(n.lat, n.lng, s.lat, s.lng);
      if (d <= BUFFER_RADIUS_M && estimateTravelMinutes(d) <= MAX_TRAVEL_MIN) {
        satCount++;
        satStudents += (s.students || 0);
      }
    }
    // Núcleos: símbolo fijo; la selección se resalta con borde/tamaño.
    const marker = L.circleMarker([n.lat, n.lng], {
      radius: isSelected ? 10 : 7,
      fillColor: nucleoStyle.fill,
      color: isSelected ? '#ffffff' : nucleoStyle.stroke,
      weight: isSelected ? 3 : 2,
      opacity: 1,
      fillOpacity: isSelected ? 0.95 : 0.85,
      renderer: canvasRenderer
    });
    marker.bindPopup(createNucleoPopup(n, satCount, satStudents));
    marker.addTo(layers.nucleos);
  });
}

function drawNucleosOther(nucleosOther) {
  (nucleosOther || []).forEach((n) => {
    const style = getSostenimientoStyle(n.sostenimiento);
    // Núcleos NO fiscales se dibujan solo como referencia visual.
    // No forman parte del análisis fiscal→fiscal.
    // Evita ReferenceError (satCount/satStudents no definidos) que rompe la carga del CSV.
    const satCount = 0;
    const satStudents = 0;
    const marker = L.circleMarker([n.lat, n.lng], {
      radius: 6,
      fillColor: style.fill,
      color: style.stroke,
      weight: 2,
      opacity: 1,
      fillOpacity: 0.75,
      renderer: canvasRenderer
    });
    marker.bindPopup(createNucleoPopup(n, satCount, satStudents));
    marker.addTo(layers.nucleosOther);
  });
}

function drawBuffersEditable(nucleos, selected, nucleoStats) {
  const savedState = loadBuffersState();
  const savedPositions = new Map();
  
  // Crear mapa de posiciones guardadas CON VALIDACIÓN
  if (savedState?.editableBuffers) {
    savedState.editableBuffers.forEach(s => {
      // CRÍTICO: validar antes de usar
      if (validateBufferCoordinates(s.currentLat, s.currentLng)) {
        savedPositions.set(s.ni, {
          lat: s.currentLat,
          lng: s.currentLng
        });
      } else {
        console.warn(`⚠️ Posición inválida para buffer ${s.ni}, usando original`);
      }
    });
  }
  
  let restoredCount = 0;
  let originalCount = 0;
  
  selected.forEach(ni => {
    const n = nucleos[ni], st = nucleoStats[ni];
    const savedPos = savedPositions.get(ni);
    
    // Usar posición guardada si existe y es válida, sino usar original
    let lat, lng, wasRestored;
    
    if (savedPos) {
      lat = savedPos.lat;
      lng = savedPos.lng;
      wasRestored = true;
      restoredCount++;
    } else {
      lat = n.lat;
      lng = n.lng;
      wasRestored = false;
      originalCount++;
    }
    
    // 🟣 PÚRPURA para buffers
    const circle = L.circle([lat, lng], { radius: BUFFER_RADIUS_M, color: '#9333ea', fillColor: '#9333ea', weight: 2, opacity: 0.6, fillOpacity: 0.08, renderer: buffersRenderer });
    circle.addTo(layers.buffers);
    setBufferInteractivity(circle, !!editMode);
circle.on('click', (e) => { L.DomEvent.stopPropagation(e); showBufferPopup(editableBuffers.get(ni), false); });
    editableBuffers.set(ni, { circle, nucleo: n, stats: st, originalPos: { lat: n.lat, lng: n.lng }, currentPos: { lat, lng }, isDragging: false, wasRestored });
  });
  
  // Restaurar buffers personalizados
  if (savedState?.customBuffers) {
    savedState.customBuffers.forEach(s => {
      if (validateBufferCoordinates(s.lat, s.lng)) {
        restoreCustomBuffer(s);
        restoredCount++;
      } else {
        console.warn(`⚠️ Buffer personalizado inválido: ${s.id}`);
      }
    });
  }
  
  // Log de restauración
  if (restoredCount > 0 || originalCount > 0) {
    console.log(`📍 Buffers cargados: ${restoredCount} restaurados, ${originalCount} originales`);
    
    if (restoredCount > 0) {
      showNotification(`✅ ${restoredCount} buffer(s) restaurado(s) desde posiciones guardadas`, "success");
    }
  }
}

function restoreCustomBuffer(saved) {
  customBufferCounter++;
  const circle = L.circle([saved.lat, saved.lng], { radius: BUFFER_RADIUS_M, color: '#a371f7', fillColor: '#a371f7', weight: 2, opacity: 0.7, fillOpacity: 0.15, renderer: buffersRenderer });
  circle.addTo(layers.buffers);
  setBufferInteractivity(circle, !!editMode);
  const buffer = { id: saved.id, circle, lat: saved.lat, lng: saved.lng, originalPos: { lat: saved.lat, lng: saved.lng }, currentPos: { lat: saved.lat, lng: saved.lng }, isCustom: true, isDragging: false, name: saved.name };
  customBuffers.push(buffer);
  setBufferInteractivity(circle, !!editMode);
  if (editMode) {
    circle.on('click', (e) => { L.DomEvent.stopPropagation(e); showBufferPopup(buffer, true); });
    makeBufferDraggable(circle, buffer, true);
  }
}


function drawSatellites(satellites, satCandidates, selected) {
  // satCandidates/selected se mantienen por compatibilidad, pero la cobertura se calcula con buffers actuales.
  const activeCenters = getActiveNucleoCentersOnly();
  const activeGrid = buildPointGrid(activeCenters);

  let verdesCount = 0;
  let rojosCount = 0;

  satellites.forEach((s, si) => {
    // ✅ "Cobertura" para colorear = SOLO si está dentro de un buffer (≤ 7 km)
    // La asignación forzada (huérfanos) NO cambia el color: sigue siendo rojo para que puedas ajustarlo manualmente.
    let normalCovered = false;
    let normalDist = null;

    // 1) Cobertura real por buffer (núcleos seleccionados + personalizados), usando posición actual
    const hit = findClosestInGridWithin(activeGrid, s.lat, s.lng, BUFFER_RADIUS_M, 1);
    if (hit) {
      normalCovered = true;
      normalDist = hit.distance;
    }

    // (Nuevo) Si el satélite está dentro de un buffer huérfano (B#), guardamos esa info para el popup,
// pero NO forzamos el color a rojo: el color depende únicamente de estar dentro/fuera de cualquier buffer visible.
    const orphanBid = orphanBufferCoverageState?.satInsideOrphan?.get?.(si);
    const orphanAssign = orphanBid ? orphanBufferCoverageState?.satAssignments?.get?.(si) : null;

    // 2) Info de asignación forzada (solo popup / líneas)
    const forced = orphanAnalysis?.forcedAssignments?.get(si) || null;
    const tooFarRaw = orphanAnalysis?.unservedSatellites?.get?.(si) || null;
    const tooFar = tooFarRaw ? { distance: tooFarRaw.distance, nucleo: globalData?.nucleos?.[tooFarRaw.ni] } : null;
  // Satélites (FISCAL 51–120):
  // - CON cobertura (≤7.5 km): rojo con borde blanco (coherente con fiscal)
  // - HUÉRFANOS fuera de núcleo (>7.5 km): naranja (diferenciación visual)
  // - En buffers huérfanos (B#): púrpura
  let fillColor, strokeColor, weight, dashArray, radius;
  if (orphanBid) {
    fillColor = '#9333ea';
    strokeColor = '#5b21b6';
    weight = 2;
    dashArray = null;
    radius = 7;
  } else if (normalCovered) {
    fillColor = '#dc2626';
    strokeColor = '#ffffff';
    weight = 3;
    dashArray = null;
    radius = 7;
  } else {
    // Huérfanos (fuera de núcleo)
    fillColor = '#f59e0b';
    strokeColor = '#92400e';
    weight = 3;
    dashArray = '5,6';
    radius = 8;
  }

  const marker = L.circleMarker([s.lat, s.lng], {
    radius,
    fillColor,
    color: strokeColor,
    weight,
    fillOpacity: 0.95,
    opacity: 1,
    dashArray,
    renderer: canvasRenderer
  });

    marker.bindPopup(createSatellitePopup(s, { normalCovered, normalDist, forced, tooFar, orphanBid, orphanAssign }));

    // Agregar a capa correspondiente
    // Reglas:
    // 1) "CON Cobertura (Núcleo)" = satélite fiscal dentro del buffer de un núcleo fiscal seleccionado (≤ 7.5 km)
    // 2) "en Buffers B#" = satélite fiscal fuera de núcleos pero dentro de algún buffer huérfano B#
    // 3) "Huérfanos (Fuera de Núcleo)" = satélite fiscal fuera de núcleos y fuera de buffers B#
    if (normalCovered) {
      verdesCount++;
      marker.addTo(layers.satellites);
    } else if (orphanBid) {
      // Dentro de un buffer B# (huérfano/manual)
      marker.addTo(layers.satellitesOrphanBuffers);
    } else {
      rojosCount++;
      marker.addTo(layers.satellitesUncovered);
    }
  });
  
  // LOGS DE DEBUGGING
  console.log('%c═══════════════════════════════════', 'color: #9333ea; font-weight: bold;');
  console.log('%c🎯 SATÉLITES DIBUJADOS', 'color: #9333ea; font-size: 16px; font-weight: bold;');
  console.log('%c═══════════════════════════════════', 'color: #9333ea; font-weight: bold;');
  console.log('%c🟢 Satélites CON cobertura: ' + verdesCount, 'color: #10b981; font-size: 14px; font-weight: bold;');
  console.log('%c🔴 Satélites SIN cobertura: ' + rojosCount, 'color: #dc2626; font-size: 14px; font-weight: bold;');
  console.log('%c📊 Total satélites: ' + satellites.length, 'color: #60a5fa; font-size: 14px;');
  console.log('%c═══════════════════════════════════', 'color: #9333ea; font-weight: bold;');
  
  if (rojosCount > 0) {
    console.log('%c✅ HAY ' + rojosCount + ' SATÉLITES ROJOS - Usa el toggle para verlos', 'background: #dc2626; color: white; padding: 8px; font-weight: bold; font-size: 12px;');
  } else {
    console.log('%c✅ 100% COBERTURA - Todos los satélites están cubiertos', 'background: #10b981; color: white; padding: 8px; font-weight: bold; font-size: 12px;');
  }
}

function drawSatellitesOther(satellitesOther) {
  (satellitesOther || []).forEach((s) => {
    const style = getSostenimientoStyle(s.sostenimiento);
    const marker = L.circleMarker([s.lat, s.lng], {
      radius: 6,
      fillColor: style.fill,
      color: style.stroke,
      weight: 2,
      opacity: 1,
      fillOpacity: 0.8,
      renderer: canvasRenderer
    });
    marker.bindPopup(createSatellitePopup(s, { excludedReason: 'FUERA DE ANÁLISIS (No fiscal)' }));
    marker.addTo(layers.satellitesOther);
  });
}

function drawSatellitesExcluded(satellitesExcluded) {
  (satellitesExcluded || []).forEach((s) => {
    const style = getSostenimientoStyle(s.sostenimiento, { excluded: true });
    const marker = L.circleMarker([s.lat, s.lng], {
      radius: 6,
      fillColor: style.fill,
      color: style.stroke,
      weight: 2,
      opacity: 1,
      fillOpacity: 0.85,
      renderer: canvasRenderer
    });
    marker.bindPopup(createSatellitePopup(s, { excludedReason: 'EXCLUIDO (Grupo 1–50)' }));
    marker.addTo(layers.satellitesExcluded);
  });
}


function refreshSatellitesLayer() {
  if (!globalData) return;
  layers.satellites.clearLayers();
  layers.satellitesUncovered.clearLayers();  // Limpiar también la capa de rojos
  drawSatellites(globalData.satellites, globalData.satCandidates, globalData.selected);
}


function hideLoadingOverlay() { const o = document.getElementById("loadingOverlay"); if (o) { o.style.opacity = "0"; setTimeout(() => o.style.display = "none", 500); } }

function createNucleoPopup(n, satCount, totalStudents) {
  const amie = n?.amie || "";
  const sost = n?.sostenimiento || "";
  const dist = n?.dist || "";
  const nombre = n?.name || "SIN NOMBRE";
  const estudiantes = (n?.students || 0);
  return `
  <div class="popup-title">🏛️ Núcleo DECE</div>
  <div class="popup-info">
    <div class="popup-row"><span class="popup-label">AMIE:</span><span class="popup-value" style="color:#58a6ff">${amie}</span></div>
    <div class="popup-row"><span class="popup-label">Institución:</span><span class="popup-value">${nombre}</span></div>
    <div class="popup-row"><span class="popup-label">Sostenimiento:</span><span class="popup-value" style="color:#58a6ff">${sost || "N/D"}</span></div>
    <div class="popup-row"><span class="popup-label">Distrito:</span><span class="popup-value" style="color:#58a6ff">${dist}</span></div>
    <div class="popup-row"><span class="popup-label">Estudiantes:</span><span class="popup-value" style="color:#ff9922">${estudiantes.toLocaleString()}</span></div>

    <div class="popup-row"><span class="popup-label">Satélites cubiertos (≤${(BUFFER_RADIUS_M/1000).toFixed(1)}km):</span><span class="popup-value" style="color:#22c55e">${satCount.toLocaleString()}</span></div>
    <div class="popup-row"><span class="popup-label">Estudiantes satélites:</span><span class="popup-value" style="color:#ff9922">${totalStudents.toLocaleString()}</span></div>
    <div class="popup-row"><span class="popup-label">Profesionales requeridos (1/450):</span><span class="popup-value">${Math.ceil(totalStudents / 450)}</span></div>
    <div class="popup-row"><span class="popup-label">Profesionales disponibles:</span><span class="popup-value">${(Number.isFinite(n?.profDece) ? n.profDece : 'N/D')}</span></div>

  </div>`;
}


function createSatellitePopup(s, info) {
  const normalCovered = !!(info && info.normalCovered);
  const normalDist = (info && typeof info.normalDist === "number") ? info.normalDist : null;
  const forced = (info && info.forced) ? info.forced : null;
  const excludedReason = (info && info.excludedReason) ? String(info.excludedReason) : "";
  const tooFar = (info && info.tooFar) ? info.tooFar : null;

  const amie = s?.amie || "";
  const nombre = s?.name || "SIN NOMBRE";
  const dist = s?.dist || "";
  const sost = s?.sostenimiento || "";

  let estadoTxt = "SIN ATENCIÓN";
  let estadoColor = "#ff7b72";
  let distTxt = "";
  let nucleoTxt = "";

  if (excludedReason) {
    estadoTxt = excludedReason;
    estadoColor = "#60a5fa";
  } else if (normalCovered) {
    estadoTxt = "CON COBERTURA (≤ 7.5 km)";
    estadoColor = "#58d26a";
    if (normalDist != null) distTxt = `${(normalDist/1000).toFixed(2)} km`;
  } else if (tooFar && typeof tooFar.distance === 'number') {
    estadoTxt = "FUERA DE ALCANCE (> 7.5 km)";
    estadoColor = "#ff7b72";
    distTxt = `${(tooFar.distance/1000).toFixed(2)} km`;
    if (tooFar.nucleo) {
      const n = tooFar.nucleo;
      nucleoTxt = `${n.name || ""} (${n.amie || ""}) • ${n.sostenimiento || "N/D"} • ${n.dist || ""}`;
    }
  } else if (forced && typeof forced.distance === "number") {
    estadoTxt = "ATENCIÓN DISTRITAL";
    estadoColor = "#ffcc00";
    distTxt = `${(forced.distance/1000).toFixed(2)} km`;
    if (forced.nucleo) {
      const n = forced.nucleo;
      nucleoTxt = `${n.name || ""} (${n.amie || ""}) • ${n.sostenimiento || "N/D"} • ${n.dist || ""}`;
    }
  }

  return `
  <div class="popup-title">📍 Satélite</div>
  <div class="popup-info">
    <div class="popup-row"><span class="popup-label">AMIE:</span><span class="popup-value" style="color:#58a6ff">${amie}</span></div>
    <div class="popup-row"><span class="popup-label">Institución:</span><span class="popup-value">${nombre}</span></div>
    <div class="popup-row"><span class="popup-label">Sostenimiento:</span><span class="popup-value" style="color:#58a6ff">${sost || "N/D"}</span></div>
    <div class="popup-row"><span class="popup-label">Distrito:</span><span class="popup-value" style="color:#58a6ff">${dist}</span></div>
    <div class="popup-row"><span class="popup-label">Estado:</span><span class="popup-value" style="color:${estadoColor}">✔ ${estadoTxt}</span></div>
    ${distTxt ? `<div class="popup-row"><span class="popup-label">Distancia:</span><span class="popup-value" style="color:#ff9922">${distTxt}</span></div>` : ""}
    ${nucleoTxt ? `<div class="popup-row"><span class="popup-label">Núcleo asignado:</span><span class="popup-value">${nucleoTxt}</span></div>` : ""}
    <div class="popup-row"><span class="popup-label">Estudiantes:</span><span class="popup-value" style="color:#ff9922">${(s.students || 0).toLocaleString()}</span></div>
  </div>`;
}



function updateStatistics(stats) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = typeof val === 'number' ? val.toLocaleString() : val; };
  set("totalNucleos", stats.totalNucleos); set("totalSatellites", stats.totalSatellites); set("coveragePercent", stats.coveragePercent + "%"); set("totalStudents", stats.totalStudents);
  set("nucleosActivos", stats.nucleosActivos); set("sinCobertura", stats.sinCobertura);
  const fill = document.getElementById("coverageFill"); if (fill) fill.style.width = Math.min(100, parseFloat(stats.coveragePercent)) + "%";
}

function computeStatistics(nucleos, satellites, satCandidates, selected, nucleoStats) {
  // ✅ Estadísticas coherentes con lo dibujado en el mapa:
  // - Cobertura normal: dentro de algún buffer de núcleo seleccionado (≤ 7.5 km)
  // - Cobertura B#: satélites dentro de buffers personalizados sin núcleos (B1..Bn)
  const activeCenters = getActiveNucleoCentersOnly();
  const activeGrid = buildPointGrid(activeCenters);

  const normalCoveredSet = new Set();
  let totalStudents = 0;

  satellites.forEach((s, si) => {
    const hit = findClosestInGridWithin(activeGrid, s.lat, s.lng, BUFFER_RADIUS_M, 1);
    if (hit) {
      normalCoveredSet.add(si);
      totalStudents += s.students || 0;
    }
  });

  // Satélites cubiertos por Buffers B# (solo-satélite)
  const bCoveredSet = getBufferBCoveredSet(satellites, nucleos);

  const totalCovered = new Set([...normalCoveredSet, ...bCoveredSet]).size;

  const total = satellites.length || 0;
  const uncovered = Math.max(0, total - totalCovered);

  return {
    totalNucleos: nucleos.length,
    totalSatellites: total,
    coveragePercent: total > 0 ? ((totalCovered / total) * 100).toFixed(2) : "0.00",
    totalStudents,
    nucleosActivos: selected?.size || 0,
    sinCobertura: uncovered
  };
}


function updateTopNucleos(nucleoStats) {
  const container = document.getElementById("topNucleos");
  if (!container) return;
  const sorted = nucleoStats.map((st, i) => ({ st, i })).sort((a, b) => b.st.satIdx.length - a.st.satIdx.length).slice(0, 10);
  container.innerHTML = sorted.map((x, idx) => `<div class="top-item" onclick="flyToLocation(${x.st.nucleo.lat},${x.st.nucleo.lng})"><div class="top-item-header"><span class="top-rank">#${idx + 1}</span><span class="top-name">${escapeHTML(x.st.nucleo.name)}</span><span class="top-count">${x.st.satIdx.length}</span></div><div class="top-desc">${x.st.totalStudents.toLocaleString()} est.</div></div>`).join("");
}

function setupControls() {
  document.getElementById("toggleStats")?.addEventListener("click", () => { document.getElementById("statsPanel")?.classList.toggle("active"); document.getElementById("legendPanel")?.classList.remove("active"); });
  document.getElementById("toggleLegend")?.addEventListener("click", () => { document.getElementById("legendPanel")?.classList.toggle("active"); document.getElementById("statsPanel")?.classList.remove("active"); });

  // Botón para ocultar/mostrar KPIs (panel inferior-derecho)
  const kpiPanel = document.getElementById('orphanStatsPanel');
  const btnKpi = document.getElementById('toggleKPI');
  const fabKpi = document.getElementById('kpiFab');

  const updateKpiButtons = (hidden) => {
    const title = hidden ? 'Mostrar KPIs' : 'Ocultar KPIs';
    const apply = (el) => {
      if (!el) return;
      el.classList.toggle('is-hidden', !!hidden);
      el.classList.toggle('is-active', !hidden);
      el.setAttribute('aria-pressed', hidden ? 'false' : 'true');
      el.setAttribute('title', title);
    };
    apply(btnKpi);
    apply(fabKpi);
    if (fabKpi) {
      const lab = fabKpi.querySelector('.kpi-fab-label');
      if (lab) lab.textContent = hidden ? 'Mostrar KPI' : 'Ocultar KPI';
    }
  };

  const setKpiHidden = (hidden) => {
    if (!kpiPanel) return;
    kpiPanel.classList.toggle('kpi-hidden', !!hidden);
    try { localStorage.setItem('kpiHidden', hidden ? '1' : '0'); } catch(_) {}
    updateKpiButtons(!!hidden);
  };
  // estado inicial: KPI oculto por defecto (según requerimiento)
  setKpiHidden(true);

  const toggleKpi = () => {
    const hidden = kpiPanel?.classList.contains('kpi-hidden');
    setKpiHidden(!hidden);
  };

  btnKpi?.addEventListener('click', toggleKpi);
  fabKpi?.addEventListener('click', toggleKpi);
  
  // Toggles de capas
  const toggleIds = [
    "toggleBuffers",
    "toggleNucleos",
    "toggleNucleosOther",
    "toggleSatellites",
    "toggleSatellitesUncovered",
    "toggleSatellitesOrphanBuffers",
    "toggleSatellitesOther",
    "toggleSatellitesExcluded"
  ];
  const toggleLayers = [
    layers.buffers,
    layers.nucleos,
    layers.nucleosOther,
    layers.satellites,
    layers.satellitesUncovered,
    layers.satellitesOrphanBuffers,
    layers.satellitesOther,
    layers.satellitesExcluded
  ];
  const layerNames = [
    "Buffers",
    "Conexiones",
    "Núcleos Fiscales",
    "Núcleos No Fiscales",
    "Satélites Fiscales (con cobertura - núcleo)",
    "Satélites Huérfanos (Fuera de Núcleo)",
    "Satélites en Buffers B#",
    "Satélites No Fiscales",
    "Excluidos (1–50)"
  ];

  toggleIds.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", (e) => { 
      const layer = toggleLayers[i];
      
      if (e.target.checked) {
        map.addLayer(layer);
        console.log(`✅ Capa activada: ${layerNames[i]} (${layer.getLayers().length} elementos)`);
      } else {
        map.removeLayer(layer);
        console.log(`❌ Capa desactivada: ${layerNames[i]}`);
      }
    });
  });
  
  setTimeout(() => document.getElementById("statsPanel")?.classList.add("active"), 500);
}

// ===============================
// 



// ===============================
// BUSCADOR AMIE (Inline Topbar + CSV)
// ===============================
let _amieHighlightLayer = null;

function amieNormalize(v){
  return String(v || "").trim().toUpperCase();
}

function amieGetFromIndex(amieCode){
  // Prefer índice CSV (100% de cobertura de registros válidos)
  if (window._amieIndex && typeof window._amieIndex.get === "function") {
    return window._amieIndex.get(amieCode) || null;
  }
  return null;
}

function amieHighlight(lat, lng, data){
  try {
    if (_amieHighlightLayer) {
      map.removeLayer(_amieHighlightLayer);
      _amieHighlightLayer = null;
    }

    _amieHighlightLayer = L.circleMarker([lat, lng], {
      radius: 10,
      weight: 3,
      color: "#ffffff",
      fillColor: "#facc15",
      fillOpacity: 0.95
    }).addTo(map);

    const name = data?.name ? String(data.name) : "";
    const sost = data?.sostenimiento ? String(data.sostenimiento) : "";
    const dist = data?.dist ? String(data.dist) : "";
    const code = data?.amie ? String(data.amie) : "";

    const html = `
      <div style="font-size:13px;line-height:1.25;">
        <div style="font-weight:800;margin-bottom:6px;">AMIE: ${code}</div>
        ${name ? `<div><b>IE:</b> ${name}</div>` : ""}
        ${sost ? `<div><b>Sostenimiento:</b> ${sost}</div>` : ""}
        ${dist ? `<div><b>Distrito:</b> ${dist}</div>` : ""}
        <div style="margin-top:6px;color:#64748b;">Marcador temporal (búsqueda)</div>
      </div>
    `;

    _amieHighlightLayer.bindPopup(html, { maxWidth: 360 }).openPopup();

    // Auto-remover después de 10s (no molesta)
    setTimeout(() => {
      try {
        if (_amieHighlightLayer) {
          map.removeLayer(_amieHighlightLayer);
          _amieHighlightLayer = null;
        }
      } catch(e) {}
    }, 10000);

  } catch (e) {
    console.warn("No se pudo crear marcador de resaltado:", e);
  }
}

function amieZoomTo(lat, lng){
  map.setView([lat, lng], 17, { animate: true });
}

function initAMIESearchInline(){
  const input = document.getElementById("amieTopInput");
  const btn = document.getElementById("amieTopBtn");

  if (!input || !btn) return;

  const run = () => {
    const amie = amieNormalize(input.value);

    if (!amie) {
      // Mensaje simple por consola (evitamos UI extra en topbar)
      console.warn("Ingrese un AMIE. Ejemplo: 01H01581");
      return;
    }

    // Esperar a que el CSV se cargue (índice exista)
    const d = amieGetFromIndex(amie);
    if (!d) {
      // Si aún no hay índice, o no existe el AMIE
      const hasIndex = !!(window._amieIndex && typeof window._amieIndex.size === "number" && window._amieIndex.size > 0);
      if (!hasIndex) {
        alert("Los datos aún se están cargando. Intente nuevamente en 2-3 segundos.");
      } else {
        alert("AMIE no encontrado en el CSV cargado.");
      }
      return;
    }

    const lat = Number(d.lat), lng = Number(d.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      alert("El registro existe, pero no tiene coordenadas válidas para centrar en el mapa.");
      return;
    }

    amieZoomTo(lat, lng);
    amieHighlight(lat, lng, d);
  };

  btn.addEventListener("click", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  // Inicializa una vez; si el DOM se reconstruye, se reintenta
  setTimeout(initAMIESearchInline, 400);
  setTimeout(initAMIESearchInline, 1200);
});
