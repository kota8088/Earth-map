"use strict";

/*
 * 設定を一か所に集約。
 * ionトークンはブラウザに配布されます。読み取り専用・対象アセット限定など
 * 最小権限のトークンを使用し、秘密鍵を設定しないでください。
 */
const CONFIG = {
  cesiumVersion: "1.127.0",
  ionToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IkswWDFiMmx5U0pvQXNiaDIiLCJqdGkiOiI3Yjg5YzUwZC02NTlmLTQzODctYjExYi04MTY4Nzk2NzA0YjEiLCJpZCI6NTEyNjIzLCJzdWIiOiJrb3RhODA4OCIsImlzcyI6Imh0dHBzOi8vYXBpLmNlc2l1bS5jb20iLCJhdWQiOiLlroflrpnjg57jg4Pjg5fnlKgiLCJpYXQiOjE3OTUxMzAzMjZ9.UCtms3W599MMOAhQUHoufqFIV8h8718ranR3wF1K4l0", // Cesium ionの公開クライアント用トークンを設定
  assets: {
    earth: 2275207,
    moon: 2684829,
    mars: 3644333
  },
  nominatimUrl: "https://nominatim.openstreetmap.org",
  usgsUrl: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
  openMeteoAirUrl: "https://air-quality-api.open-meteo.com/v1/air-quality",
  dataFiles: {
    moon: "./data/lunar-gazetteer.geojson",
    mars: "./data/mars-gazetteer.geojson",
    panoramas: "./data/panoramas.json",
    indoor: "./data/indoor-facilities.json"
  },
  ellipsoids: {
    earth: new Cesium.Ellipsoid(6378137, 6378137, 6356752.314245),
    moon: new Cesium.Ellipsoid(1737400, 1737400, 1737400),
    mars: new Cesium.Ellipsoid(3396190, 3396190, 3376200)
  },
  homes: {
    earth: { lon: 0, lat: 15, height: 24000000 },
    moon: { lon: 0, lat: 0, height: 9000000 },
    mars: { lon: 0, lat: 10, height: 16000000 }
  }
};

const $ = id => document.getElementById(id);
const bodyNames = { earth: "地球", moon: "月", mars: "火星" };
const state = {
  body: "earth",
  generation: 0,
  tileset: null,
  imageryLayers: [],
  terrainProvider: null,
  pinEntities: new Map(),
  temporaryEntities: [],
  quakeEntities: [],
  osmLayer: null,
  indoorLayer: null,
  selectedPoint: null,
  selectedPinId: null,
  currentPanoramas: [],
  panoramaViewer: null,
  panoramaData: [],
  indoorData: [],
  gazetteers: { moon: [], mars: [] },
  db: null,
  storageMode: "IndexedDB",
  historyEnabled: true,
  lastGeocodeAt: 0,
  cameraHistoryTimer: null,
  arStream: null
};

if (!window.Cesium) {
  document.body.innerHTML =
    "<p style='padding:2rem;color:white'>CesiumJSが見つかりません。vendor/CesiumにCesiumJS 1.127.0を配置してください。</p>";
  throw new Error("CesiumJS not loaded");
}
if (Cesium.VERSION !== CONFIG.cesiumVersion) {
  console.warn(`CesiumJSの版が設定と異なります: ${Cesium.VERSION}`);
}

Cesium.Ion.defaultAccessToken = CONFIG.ionToken;

const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  infoBox: false,
  selectionIndicator: false,
  shouldAnimate: false,
  terrainProvider: new Cesium.EllipsoidTerrainProvider({
    ellipsoid: CONFIG.ellipsoids.earth
  })
});

viewer.scene.globe = new Cesium.Globe(CONFIG.ellipsoids.earth);
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#101d2e");
viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#030812");
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(0, 15, CONFIG.homes.earth.height)
});

function setMessage(text) { $("mapMessage").textContent = text; }
function setBodyStatus(text) { $("bodyStatus").textContent = text; }

function openDB() {
  return new Promise(resolve => {
    if (!("indexedDB" in window)) return resolve(null);
    const request = indexedDB.open("orbit-atlas", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("state")) db.createObjectStore("state");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function loadSavedState() {
  state.db = await openDB();
  if (!state.db) state.storageMode = "localStorage";
  try {
    const data = await dbGet("app");
    if (data) {
      state.historyEnabled = data.historyEnabled !== false;
      $("historyToggle").checked = state.historyEnabled;
      return {
        pins: Array.isArray(data.pins) ? data.pins : [],
        searchHistory: Array.isArray(data.searchHistory) ? data.searchHistory : [],
        viewHistory: Array.isArray(data.viewHistory) ? data.viewHistory : []
      };
    }
  } catch (error) {
    console.warn("保存データの読み込みに失敗:", error);
  }
  return { pins: [], searchHistory: [], viewHistory: [] };
}

let saved = { pins: [], searchHistory: [], viewHistory: [] };

function dbGet(key) {
  if (!state.db) {
    try { return Promise.resolve(JSON.parse(localStorage.getItem("orbit-atlas") || "null")); }
    catch { return Promise.resolve(null); }
  }
  return new Promise((resolve, reject) => {
    const req = state.db.transaction("state", "readonly").objectStore("state").get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function persist() {
  const payload = {
    version: 1,
    pins: saved.pins,
    searchHistory: saved.searchHistory,
    viewHistory: saved.viewHistory,
    historyEnabled: state.historyEnabled
  };
  try {
    if (!state.db) {
      localStorage.setItem("orbit-atlas", JSON.stringify(payload));
      return;
    }
    const tx = state.db.transaction("state", "readwrite");
    tx.objectStore("state").put(payload, "app");
    tx.onerror = () => {
      setMessage("保存に失敗しました。ブラウザの保存容量を確認してください。");
    };
  } catch (error) {
    setMessage(`保存に失敗しました: ${error.message}`);
  }
}

function clearTemporary() {
  for (const entity of state.temporaryEntities) viewer.entities.remove(entity);
  state.temporaryEntities = [];
  state.selectedPoint = null;
  state.selectedPinId = null;
  $("searchResults").replaceChildren();
}

function removeBodyAssets() {
  if (state.tileset) {
    viewer.scene.primitives.remove(state.tileset);
    state.tileset = null;
  }
  for (const layer of state.imageryLayers) {
    try { viewer.imageryLayers.remove(layer, true); } catch {}
  }
  state.imageryLayers = [];
  if (state.osmLayer) {
    viewer.imageryLayers.remove(state.osmLayer, true);
    state.osmLayer = null;
  }
  if (state.indoorLayer) {
    viewer.imageryLayers.remove(state.indoorLayer, true);
    state.indoorLayer = null;
  }
  for (const entity of state.quakeEntities) viewer.entities.remove(entity);
  state.quakeEntities = [];
  viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider({
    ellipsoid: CONFIG.ellipsoids[state.body]
  });
  viewer.scene.globe = new Cesium.Globe(CONFIG.ellipsoids[state.body]);
}

function redrawPins() {
  for (const entity of state.pinEntities.values()) viewer.entities.remove(entity);
  state.pinEntities.clear();

  for (const pin of saved.pins.filter(p => p.body === state.body)) {
    const entity = viewer.entities.add({
      id: `pin-${pin.id}`,
      position: Cesium.Cartesian3.fromDegrees(pin.lon, pin.lat, pin.height || 0,
        CONFIG.ellipsoids[state.body]),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString("#ffca65"),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
      },
      label: {
        text: pin.name || "ピン",
        font: "12px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3000000)
      }
    });
    state.pinEntities.set(pin.id, entity);
  }
  renderPins();
}

function updateHistoryUI() {
  const box = $("historyList");
  box.replaceChildren();
  const entries = [
    ...saved.searchHistory.slice(0, 10).map(x => ({ ...x, type: "search" })),
    ...saved.viewHistory.slice(0, 10).map(x => ({ ...x, type: "view" }))
  ].sort((a, b) => b.time - a.time).slice(0, 12);

  if (!entries.length) {
    box.textContent = "履歴はありません。";
    return;
  }
  for (const item of entries) {
    const row = document.createElement("div");
    row.className = "result-item";
    const open = document.createElement("button");
    open.className = "item-name";
    open.textContent = `${item.type === "search" ? "検索" : "閲覧"} · ${item.label || item.query || bodyNames[item.body]} · ${new Date(item.time).toLocaleString()}`;
    open.onclick = async () => {
      if (item.type === "search") {
        $("bodySelect").value = item.body;
        await switchBody(item.body);
        $("searchInput").value = item.query;
        $("searchForm").requestSubmit();
      } else {
        $("bodySelect").value = item.body;
        await switchBody(item.body);
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(item.lon, item.lat, item.height,
            CONFIG.ellipsoids[item.body]),
          orientation: { heading: item.heading, pitch: item.pitch, roll: item.roll }
        });
      }
    };
    const del = document.createElement("button");
    del.textContent = "削除";
    del.onclick = () => {
      const list = item.type === "search" ? saved.searchHistory : saved.viewHistory;
      const i = list.findIndex(x => x.time === item.time);
      if (i >= 0) list.splice(i, 1);
      persist(); updateHistoryUI();
    };
    row.append(open, del);
    box.append(row);
  }
}

function renderPins() {
  const box = $("pinsList");
  box.replaceChildren();
  const pins = saved.pins.filter(p => p.body === state.body);
  if (!pins.length) {
    box.textContent = "この天体の保存ピンはありません。";
    return;
  }
  for (const pin of pins) {
    const row = document.createElement("div");
    row.className = "result-item";
    const open = document.createElement("button");
    open.className = "item-name";
    open.textContent = `${pin.name || "名称なし"} (${pin.lat.toFixed(4)}, ${pin.lon.toFixed(4)})`;
    open.onclick = () => showPin(pin);
    const edit = document.createElement("button");
    edit.textContent = "編集";
    edit.onclick = () => editPin(pin);
    const del = document.createElement("button");
    del.textContent = "削除";
    del.onclick = () => {
      saved.pins = saved.pins.filter(p => p.id !== pin.id);
      persist(); redrawPins();
    };
    row.append(open, edit, del);
    box.append(row);
  }
}

function showInfo(title, html) {
  $("infoTitle").textContent = title;
  $("infoContent").innerHTML = html;
}

function showPin(pin) {
  const entity = state.pinEntities.get(pin.id);
  if (entity) {
    viewer.flyTo(entity, { duration: 1.2 });
  }
  state.selectedPoint = { body: pin.body, lon: pin.lon, lat: pin.lat };
  state.selectedPinId = pin.id;
  showInfo(pin.name || "保存ピン", `
    <p>${bodyNames[pin.body]} / 緯度 ${pin.lat.toFixed(6)}° / 経度 ${pin.lon.toFixed(6)}°</p>
    <p>メモ: ${escapeHtml(pin.note || "なし")}</p>
    <p>作成日時: ${new Date(pin.createdAt).toLocaleString()}</p>
    ${pin.body === "earth" ? '<div id="reverseAddress">住所を取得しています…</div><button id="panoramaButton" type="button">360度写真を見る</button>' : ""}
  `);
  if (pin.body === "earth") {
    $("panoramaButton").onclick = () => openPanorama(pin.lon, pin.lat);
    reverseGeocode(pin.lon, pin.lat);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

async function reverseGeocode(lon, lat) {
  try {
    const url = `${CONFIG.nominatimUrl}/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
    const response = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const el = $("reverseAddress");
    if (el) el.textContent = data.display_name || "住所・施設情報は見つかりませんでした。";
  } catch {
    const el = $("reverseAddress");
    if (el) el.textContent = "住所情報を取得できませんでした。";
  }
}

function editPin(pin) {
  const name = prompt("ピンの名称", pin.name || "");
  if (name === null) return;
  const note = prompt("メモ", pin.note || "");
  if (note === null) return;
  pin.name = name.trim() || "名称なし";
  pin.note = note;
  persist(); redrawPins(); showPin(pin);
}

function addPin(lon, lat) {
  const name = prompt("ピンの名称", `${bodyNames[state.body]}の地点`);
  if (name === null) return;
  const note = prompt("メモ（任意）", "") ?? "";
  const pin = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    body: state.body,
    name: name.trim() || "名称なし",
    note,
    lon, lat, height: 0,
    createdAt: Date.now()
  };
  saved.pins.push(pin);
  persist(); redrawPins(); showPin(pin);
}

function cartographicAt(screenPosition) {
  const scene = viewer.scene;
  if (scene.pickPositionSupported) {
    const picked = scene.pickPosition(screenPosition);
    if (Cesium.defined(picked)) {
      const c = Cesium.Cartographic.fromCartesian(picked, CONFIG.ellipsoids[state.body]);
      if (c) return c;
    }
  }
  const ray = viewer.camera.getPickRay(screenPosition);
  const globeHit = ray && scene.globe.pick(ray, scene);
  if (globeHit) return Cesium.Cartographic.fromCartesian(globeHit, CONFIG.ellipsoids[state.body]);
  return viewer.camera.pickEllipsoid(screenPosition, CONFIG.ellipsoids[state.body]);
}

viewer.screenSpaceEventHandler.setInputAction(event => {
  const c = cartographicAt(event.position);
  if (!c) {
    setMessage("この位置の地表を取得できませんでした。");
    return;
  }
  const lon = Cesium.Math.toDegrees(c.longitude);
  const lat = Cesium.Math.toDegrees(c.latitude);
  state.selectedPoint = { body: state.body, lon, lat };
  addPin(lon, lat);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

function parseCoordinates(text) {
  const match = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const a = Number(match[1]), b = Number(match[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: a, lon: b };
}

function addSearchResult(label, lon, lat, source) {
  const row = document.createElement("div");
  row.className = "result-item";
  const button = document.createElement("button");
  button.className = "item-name";
  button.textContent = `${label} (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
  button.onclick = () => {
    const destination = Cesium.Cartesian3.fromDegrees(lon, lat, 12000, CONFIG.ellipsoids[state.body]);
    viewer.camera.flyTo({ destination, duration: 1.4 });
    state.selectedPoint = { body: state.body, lon, lat };
    showInfo(label, `<p>${bodyNames[state.body]} / 緯度 ${lat.toFixed(6)}° / 経度 ${lon.toFixed(6)}°</p><p>出典: ${escapeHtml(source)}</p>`);
  };
  row.append(button);
  $("searchResults").append(row);
}

async function searchPlaces(query, record = true) {
  $("searchResults").replaceChildren();
  const coordinates = parseCoordinates(query);
  if (coordinates) {
    addSearchResult("入力座標", coordinates.lon, coordinates.lat, "ユーザー入力");
    if (record) addSearchHistory(query);
    return;
  }

  if (state.body !== "earth") {
    const list = state.gazetteers[state.body];
    const matches = list.filter(item => {
      const name = String(item.properties?.name || item.properties?.NAME || "");
      return name.toLowerCase().includes(query.toLowerCase());
    }).slice(0, 20);
    if (!matches.length) {
      $("searchResults").textContent = "ローカル地名データに一致する地名がありません。検索対象は登録データに限定されます。";
      return;
    }
    for (const feature of matches) {
      const [lon, lat] = feature.geometry.coordinates;
      addSearchResult(feature.properties.name || feature.properties.NAME, lon, lat,
        feature.properties.source || "登録済みローカルデータ");
    }
    if (record) addSearchHistory(query);
    return;
  }

  const elapsed = Date.now() - state.lastGeocodeAt;
  if (elapsed < 1100) await new Promise(resolve => setTimeout(resolve, 1100 - elapsed));
  state.lastGeocodeAt = Date.now();

  try {
    const url = `${CONFIG.nominatimUrl}/search?format=jsonv2&limit=8&q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const results = await response.json();
    if (!results.length) {
      $("searchResults").textContent = "検索結果がありません。";
      return;
    }
    results.forEach(item => addSearchResult(item.display_name, Number(item.lon), Number(item.lat), "OpenStreetMap Nominatim"));
    if (record) addSearchHistory(query);
  } catch (error) {
    $("searchResults").textContent = `検索に失敗しました（${error.message}）。通信・利用制限を確認してください。`;
  }
}

function addSearchHistory(query) {
  if (!state.historyEnabled) return;
  saved.searchHistory.unshift({ query, body: state.body, time: Date.now() });
  saved.searchHistory = saved.searchHistory.slice(0, 100);
  persist(); updateHistoryUI();
}

$("searchForm").addEventListener("submit", async event => {
  event.preventDefault();
  const query = $("searchInput").value.trim();
  if (!query) return;
  await searchPlaces(query);
});

async function fetchIonMetadata(assetId) {
  if (!CONFIG.ionToken) throw new Error("Cesium ionトークンが未設定です。");
  const response = await fetch(`https://api.cesium.com/v1/assets/${assetId}`, {
    headers: { Authorization: `Bearer ${CONFIG.ionToken}` }
  });
  if (!response.ok) throw new Error(`ionメタデータ取得失敗: HTTP ${response.status}`);
  return response.json();
}

function metadataType(meta) {
  return String(meta.type || meta.assetType || meta.externalType || "").toUpperCase();
}

async function addIonAsset(body, generation) {
  const assetId = CONFIG.assets[body];
  const meta = await fetchIonMetadata(assetId);
  if (generation !== state.generation) return;

  const type = metadataType(meta);
  setBodyStatus(`ion asset ${assetId}: type=${type || "不明"} / status=${meta.status || "不明"}`);

  if (body === "earth" && type.includes("3D")) {
    const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(assetId);
    if (generation !== state.generation) return;
    state.tileset = tileset;
    viewer.scene.primitives.add(tileset);
    return;
  }

  if (type.includes("3D")) {
    const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(assetId);
    if (generation !== state.generation) return;
    state.tileset = tileset;
    viewer.scene.primitives.add(tileset);
    setBodyStatus(`ion asset ${assetId}: 3D Tilesを読み込みました。座標系・範囲はアセット提供元の情報で別途確認してください。`);
    return;
  }

  if (type.includes("IMAGERY") && body === "earth") {
    const provider = await Cesium.IonImageryProvider.fromAssetId(assetId);
    if (generation !== state.generation) return;
    state.imageryLayers.push(viewer.imageryLayers.addImageryProvider(provider));
    return;
  }

  if (type.includes("TERRAIN") && body === "earth") {
    const provider = await Cesium.CesiumTerrainProvider.fromIonAssetId(assetId);
    if (generation !== state.generation) return;
    viewer.terrainProvider = provider;
    return;
  }

  throw new Error(
    `アセットの種類「${type || "不明"}」はこの設定では安全に表示できません。ionのメタデータと座標系を確認してください。`
  );
}

async function switchBody(body) {
  const generation = ++state.generation;
  state.body = body;
  $("activeBodyLabel").textContent = bodyNames[body];
  $("bodySelect").value = body;
  $("searchResults").replaceChildren();
  $("searchHint").textContent = body === "earth"
    ? "地球検索はNominatimを検索時に照会します。"
    : "月・火星検索は登録済みローカル地名データのみです。";
  $("earthTilesToggle").disabled = body !== "earth";
  $("osmToggle").disabled = body !== "earth";
  $("quakeToggle").disabled = body !== "earth";
  $("aqiToggle").disabled = body !== "earth";
  $("earthTilesToggle").checked = body === "earth";
  $("osmToggle").checked = false;
  $("quakeToggle").checked = false;
  $("aqiToggle").checked = false;

  clearTemporary();
  removeBodyAssets();
  viewer.scene.globe = new Cesium.Globe(CONFIG.ellipsoids[body]);
  viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider({ ellipsoid: CONFIG.ellipsoids[body] });
  redrawPins();

  const home = CONFIG.homes[body];
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(home.lon, home.lat, home.height, CONFIG.ellipsoids[body]),
    duration: 0.8
  });

  setMessage(`${bodyNames[body]}を準備しています…`);
  setBodyStatus(CONFIG.ionToken ? "ionアセット情報を確認中…" : "ionトークン未設定。座標・保存ピン等は利用できます。");

  if (body === "earth" && $("osmToggle").checked) await enableOSM();

  if (CONFIG.ionToken) {
    try {
      await addIonAsset(body, generation);
      if (generation !== state.generation) return;
      setMessage(`${bodyNames[body]}のアセットを読み込みました。`);
    } catch (error) {
      if (generation !== state.generation) return;
      setBodyStatus(error.message);
      setMessage("アセットを利用できません。トークン・権限・アセット情報を確認してください。");
    }
  } else {
    setMessage(`${bodyNames[body]}: ion未設定。座標検索・保存ピンは使用できます。`);
  }
}

async function enableOSM() {
  try {
    if (state.body !== "earth" || state.osmLayer) return;
    const provider = await Cesium.UrlTemplateImageryProvider.fromUrl(
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      { credit: new Cesium.Credit("© OpenStreetMap contributors", true), maximumLevel: 19 }
    );
    state.osmLayer = viewer.imageryLayers.addImageryProvider(provider);
    $("layerStatus").textContent = "地図: © OpenStreetMap contributors。衛星写真ではありません。利用ポリシーを確認してください。";
  } catch (error) {
    $("layerStatus").textContent = `OpenStreetMapを読み込めません: ${error.message}`;
  }
}

$("bodySelect").addEventListener("change", event => switchBody(event.target.value));
$("earthTilesToggle").addEventListener("change", async event => {
  if (state.body !== "earth") return;
  if (event.target.checked) await switchBody("earth");
  else {
    if (state.tileset) viewer.scene.primitives.remove(state.tileset);
    state.tileset = null;
    setMessage("地球3Dタイルを非表示にしました。");
  }
});
$("osmToggle").addEventListener("change", async event => {
  if (event.target.checked) await enableOSM();
  else if (state.osmLayer) {
    viewer.imageryLayers.remove(state.osmLayer, true);
    state.osmLayer = null;
  }
});

$("homeButton").onclick = () => {
  const h = CONFIG.homes[state.body];
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(h.lon, h.lat, h.height, CONFIG.ellipsoids[state.body]),
    duration: 1
  });
};
$("tiltButton").onclick = () => {
  const c = viewer.camera.positionCartographic;
  viewer.camera.setView({
    destination: viewer.camera.position,
    orientation: { heading: viewer.camera.heading, pitch: -Math.PI / 2, roll: 0 }
  });
};

async function loadGazetteer(body) {
  try {
    const response = await fetch(CONFIG.dataFiles[body]);
    if (!response.ok) throw new Error("データ未配置");
    const geojson = await response.json();
    state.gazetteers[body] = (geojson.features || []).filter(f =>
      f.geometry?.type === "Point" && Array.isArray(f.geometry.coordinates)
    );
  } catch {
    state.gazetteers[body] = [];
  }
}

async function loadQuakes() {
  if (state.body !== "earth") return;
  for (const e of state.quakeEntities) viewer.entities.remove(e);
  state.quakeEntities = [];
  setMessage("USGS地震データを取得しています…");
  try {
    const response = await fetch(CONFIG.usgsUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    for (const feature of data.features || []) {
      const [lon, lat, depth] = feature.geometry.coordinates;
      const entity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(0, -depth * 1000), CONFIG.ellipsoids.earth),
        point: { pixelSize: 7, color: Cesium.Color.ORANGERED, outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
        description: `${escapeHtml(feature.properties.title || "地震")}<br>観測時刻: ${new Date(feature.properties.time).toLocaleString()}`
      });
      state.quakeEntities.push(entity);
    }
    setMessage(`USGS地震: 取得 ${new Date().toLocaleString()}。観測時刻は各地点の情報を確認してください。`);
    $("layerStatus").textContent = `出典: USGS Earthquake Hazards Program / all_day.geojson。取得 ${new Date().toLocaleString()}。`;
  } catch (error) {
    setMessage(`地震データ未取得: ${error.message}。異常なしを意味しません。`);
  }
}
$("quakeToggle").addEventListener("change", event => {
  if (event.target.checked) loadQuakes();
  else {
    for (const e of state.quakeEntities) viewer.entities.remove(e);
    state.quakeEntities = [];
  }
});

async function loadAqi() {
  if (state.body !== "earth" || !state.selectedPoint) {
    setMessage("AQIは地球上の地点を選択してから表示してください。");
    $("aqiToggle").checked = false;
    return;
  }
  const { lon, lat } = state.selectedPoint;
  const url = `${CONFIG.openMeteoAirUrl}?latitude=${lat}&longitude=${lon}&current=us_aqi`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const aqi = data.current?.us_aqi;
    if (aqi == null) throw new Error("AQI値が返りませんでした");
    setMessage(`Open-Meteo AQI: ${aqi}（取得 ${new Date().toLocaleString()}）`);
    $("layerStatus").textContent = `出典: Open-Meteo Air Quality API。地点 ${lat.toFixed(3)}, ${lon.toFixed(3)}。観測・モデル時刻: ${data.current.time || "不明"}。`;
  } catch (error) {
    setMessage(`AQI未取得: ${error.message}。異常なしを意味しません。`);
  }
}
$("aqiToggle").addEventListener("change", event => {
  if (event.target.checked) loadAqi();
});

async function loadPanoramaCatalog() {
  try {
    const response = await fetch(CONFIG.dataFiles.panoramas);
    if (!response.ok) throw new Error();
    const data = await response.json();
    state.panoramaData = Array.isArray(data) ? data : [];
  } catch {
    state.panoramaData = [];
  }
}

function haversineMeters(lon1, lat1, lon2, lat2) {
  const rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function openPanorama(lon, lat) {
  const matches = state.panoramaData
    .map(item => ({ ...item, distance: haversineMeters(lon, lat, item.lon, item.lat) }))
    .filter(item => item.distance <= Number(item.radiusMeters || 500))
    .sort((a, b) => a.distance - b.distance);

  $("panoramaModal").classList.remove("hidden");
  $("panoramaChoices").replaceChildren();
  if (!matches.length) {
    $("panoramaViewer").textContent = "この地点付近の360度写真はありません。";
    return;
  }
  if (!window.pannellum) {
    $("panoramaViewer").textContent = "写真は登録されていますが、Pannellumが未配置です。";
    return;
  }

  const show = item => {
    if (state.panoramaViewer) {
      try { state.panoramaViewer.destroy(); } catch {}
      state.panoramaViewer = null;
    }
    $("panoramaViewer").replaceChildren();
    state.panoramaViewer = pannellum.viewer("panoramaViewer", {
      type: "equirectangular",
      panorama: item.url,
      autoLoad: true,
      showControls: true
    });
    $("panoramaChoices").dataset.active = item.id || item.url;
  };

  for (const item of matches) {
    const button = document.createElement("button");
    button.textContent = `${item.title || "写真"} · 撮影位置まで${Math.round(item.distance)}m · ${item.capturedAt || "撮影日時不明"}`;
    button.onclick = () => show(item);
    $("panoramaChoices").append(button);
  }
  show(matches[0]);
  $("panoramaViewer").insertAdjacentHTML("afterend",
    `<p>ピン位置と撮影位置は異なる場合があります。写真の撮影位置: ${matches[0].lat}, ${matches[0].lon}</p>`);
}
$("closePanorama").onclick = () => {
  $("panoramaModal").classList.add("hidden");
  if (state.panoramaViewer) {
    try { state.panoramaViewer.destroy(); } catch {}
    state.panoramaViewer = null;
  }
};

async function loadIndoorData() {
  try {
    const response = await fetch(CONFIG.dataFiles.indoor);
    if (!response.ok) throw new Error();
    const data = await response.json();
    state.indoorData = Array.isArray(data.facilities) ? data.facilities : [];
    const select = $("facilitySelect");
    select.replaceChildren(new Option("施設を選択", ""));
    for (const facility of state.indoorData) select.add(new Option(facility.name, facility.id));
    $("indoorStatus").textContent = state.indoorData.length
      ? "登録データを読み込みました。施設の出典・利用条件を確認してください。"
      : "施設データがありません。";
  } catch {
    $("indoorStatus").textContent = "施設データ未登録。図面は表示していません。";
  }
}

$("facilitySelect").addEventListener("change", () => {
  const facility = state.indoorData.find(x => x.id === $("facilitySelect").value);
  $("floorSelect").replaceChildren();
  if (!facility) {
    $("floorSelect").disabled = true;
    return;
  }
  for (const floor of facility.floors || []) $("floorSelect").add(new Option(floor.name, floor.id));
  $("floorSelect").disabled = false;
  $("indoorStatus").textContent =
    `${facility.name} / 出典: ${facility.source || "未記載"}。画像の座標範囲が正しいことを確認してください。`;
  $("floorSelect").dispatchEvent(new Event("change"));
});

$("floorSelect").addEventListener("change", async () => {
  if (state.indoorLayer) {
    viewer.imageryLayers.remove(state.indoorLayer, true);
    state.indoorLayer = null;
  }
  const facility = state.indoorData.find(x => x.id === $("facilitySelect").value);
  const floor = facility?.floors?.find(x => x.id === $("floorSelect").value);
  if (!floor?.image || !Array.isArray(floor.rectangle) || floor.rectangle.length !== 4) return;
  try {
    const rectangle = Cesium.Rectangle.fromDegrees(...floor.rectangle);
    const provider = await Cesium.SingleTileImageryProvider.fromUrl(floor.image, { rectangle });
    state.indoorLayer = viewer.imageryLayers.addImageryProvider(provider);
  } catch (error) {
    $("indoorStatus").textContent = `フロア画像を表示できません: ${error.message}`;
  }
});

$("closeInfo").onclick = () => $("infoPanel").classList.add("hidden");

$("historyToggle").addEventListener("change", event => {
  state.historyEnabled = event.target.checked;
  persist();
});
$("clearSearchHistory").onclick = () => {
  if (confirm("検索履歴をすべて消去しますか？")) {
    saved.searchHistory = []; persist(); updateHistoryUI();
  }
};
$("clearViewHistory").onclick = () => {
  if (confirm("閲覧履歴をすべて消去しますか？")) {
    saved.viewHistory = []; persist(); updateHistoryUI();
  }
};

function saveCameraHistory() {
  if (!state.historyEnabled) return;
  const c = viewer.camera.positionCartographic;
  if (!c) return;
  const item = {
    body: state.body,
    lon: Cesium.Math.toDegrees(c.longitude),
    lat: Cesium.Math.toDegrees(c.latitude),
    height: c.height,
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
    roll: viewer.camera.roll,
    label: `${bodyNames[state.body]} ${Cesium.Math.toDegrees(c.latitude).toFixed(2)}, ${Cesium.Math.toDegrees(c.longitude).toFixed(2)}`,
    time: Date.now()
  };
  const last = saved.viewHistory[0];
  if (last && last.body === item.body &&
      haversineMeters(last.lon, last.lat, item.lon, item.lat) < 300 &&
      Math.abs(last.height - item.height) < 500) return;
  saved.viewHistory.unshift(item);
  saved.viewHistory = saved.viewHistory.slice(0, 100);
  persist(); updateHistoryUI();
}
viewer.camera.changed.addEventListener(() => {
  clearTimeout(state.cameraHistoryTimer);
  state.cameraHistoryTimer = setTimeout(saveCameraHistory, 1800);
});

$("arButton").onclick = async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    $("arStatus").textContent = "このブラウザではカメラAPIを利用できません。HTTPSまたはlocalhostで開いてください。";
    return;
  }
  if (!navigator.geolocation) {
    $("arStatus").textContent = "位置情報APIを利用できません。";
    return;
  }
  try {
    const position = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 })
    );
    state.arStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    $("arVideo").srcObject = state.arStream;
    $("arOverlay").classList.remove("hidden");
    const lat = position.coords.latitude, lon = position.coords.longitude;
    const nearby = saved.pins.filter(p => p.body === "earth")
      .map(p => ({ ...p, distance: haversineMeters(lon, lat, p.lon, p.lat) }))
      .filter(p => p.distance < 500)
      .sort((a, b) => a.distance - b.distance).slice(0, 8);
    const labels = $("arLabels");
    labels.replaceChildren();
    if (!nearby.length) {
      labels.textContent = "周辺500m以内に保存済みピンはありません。";
    } else {
      for (const pin of nearby) {
        const div = document.createElement("div");
        div.className = "ar-label";
        div.textContent = `${pin.name} · 約${Math.round(pin.distance)}m`;
        labels.append(div);
      }
    }
    $("arStatus").textContent =
      `位置精度 約${Math.round(position.coords.accuracy)}m。画面上の表示は簡易一覧で、方位・空間への正確な位置合わせではありません。`;
  } catch (error) {
    $("arStatus").textContent =
      `カメラまたは位置情報を利用できません（${error.message}）。権限、HTTPS、対応端末を確認してください。`;
  }
};
$("stopArButton").onclick = () => {
  if (state.arStream) state.arStream.getTracks().forEach(track => track.stop());
  state.arStream = null;
  $("arVideo").srcObject = null;
  $("arOverlay").classList.add("hidden");
};

async function init() {
  saved = await loadSavedState();
  $("historyToggle").checked = state.historyEnabled;
  $("bodyStatus").textContent = `保存先: ${state.storageMode}（ブラウザ内のみ。端末間同期なし）`;

  await Promise.all([
    loadGazetteer("moon"),
    loadGazetteer("mars"),
    loadPanoramaCatalog(),
    loadIndoorData()
  ]);

  redrawPins();
  updateHistoryUI();
  await switchBody("earth");
}
init().catch(error => {
  console.error(error);
  setMessage("初期化に失敗しました。開発者コンソールを確認してください。");
});
