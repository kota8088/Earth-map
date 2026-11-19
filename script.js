"use strict";

/*
 * 公開クライアント設定。ここにサーバー秘密鍵を置かないでください。
 * ionトークンはブラウザから閲覧可能です。ion側で利用制限を設定してください。
 */
const CONFIG = {
  CESIUM_ION_TOKEN: "PASTE_RESTRICTED_CESIUM_ION_TOKEN_HERE",

  // ユーザー指定のID。IDからアセット種別は推測しません。
  MOON_ION_ASSET_ID: 2684829,
  MARS_ION_ASSET_ID: 3644333,

  // Google Cloudで有効化・課金設定したブラウザ公開キーを設定。
  GOOGLE_MAPS_API_KEY: "",

  // 本番アプリでは利用規約・レート制限を確認した検索サービスに置き換えてください。
  NOMINATIM_URL: "https://nominatim.openstreetmap.org/search"
};

const STORAGE = {
  pins: "cosmic-atlas.pins.v1",
  history: "cosmic-atlas.history.v1",
  searches: "cosmic-atlas.searches.v1",
  historyEnabled: "cosmic-atlas.historyEnabled.v1"
};

const BODIES = {
  earth: {
    label: "地球",
    ellipsoid: Cesium.Ellipsoid.WGS84,
    home: [0, 20, 20000000]
  },
  moon: {
    label: "月",
    ellipsoid: new Cesium.Ellipsoid(1737400, 1737400, 1737400),
    home: [0, 0, 5200000]
  },
  mars: {
    label: "火星",
    ellipsoid: new Cesium.Ellipsoid(3396190, 3396190, 3376200),
    home: [0, 0, 10000000]
  }
};

// Representative local names only; not a complete gazetteer.
// Coordinates refer to commonly published approximate feature locations.
const LOCAL_PLACES = {
  moon: [
    { name: "Mare Tranquillitatis", lat: 8.5, lon: 31.4, source: "USGS Gazetteer of Planetary Nomenclature" },
    { name: "Copernicus crater", lat: 9.62, lon: -20.08, source: "USGS Gazetteer of Planetary Nomenclature" },
    { name: "Tycho crater", lat: -43.3, lon: -11.2, source: "USGS Gazetteer of Planetary Nomenclature" }
  ],
  mars: [
    { name: "Olympus Mons", lat: 18.65, lon: -133.8, source: "USGS Gazetteer of Planetary Nomenclature" },
    { name: "Gale crater", lat: -5.4, lon: 137.8, source: "USGS Gazetteer of Planetary Nomenclature" },
    { name: "Valles Marineris", lat: -13.9, lon: -59.2, source: "USGS Gazetteer of Planetary Nomenclature" }
  ]
};

let viewer;
let currentBody = "earth";
let imageryLayer = null;
let googleTileset = null;
let selectedPinId = null;
let measureMode = null;
let measurePoints = [];
let measureEntities = [];
let lastHistoryKey = "";
let toastTimer;
let streetViewLink = null;

const $ = id => document.getElementById(id);
const read = key => {
  try { return JSON.parse(localStorage.getItem(key) || "[]"); }
  catch { return []; }
};
const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const historyIsEnabled = () => localStorage.getItem(STORAGE.historyEnabled) !== "false";

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function bodyName(body) { return BODIES[body]?.label || body; }
function formatCoord(n) { return Number(n).toFixed(6); }

function init() {
  if (!window.Cesium) {
    $("layerStatus").textContent = "CesiumJSの読み込みに失敗しました。通信状態を確認してください。";
    return;
  }

  if (CONFIG.CESIUM_ION_TOKEN &&
      !CONFIG.CESIUM_ION_TOKEN.startsWith("PASTE_")) {
    Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_ION_TOKEN;
  }

  const ellipsoid = BODIES.earth.ellipsoid;
  viewer = new Cesium.Viewer("cesiumContainer", {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    baseLayer: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider({ ellipsoid })
  });

  viewer.scene.globe = new Cesium.Globe(ellipsoid);
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#101827");
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#050913");
  viewer.scene.requestRenderMode = false;

  wireEvents();
  renderAllLists();
  setBody("earth");
  viewer.camera.moveEnd.addEventListener(recordView);
}

function wireEvents() {
  document.querySelectorAll("[data-body]").forEach(button => {
    button.addEventListener("click", () => setBody(button.dataset.body));
  });

  $("imageryToggle").addEventListener("change", async () => {
    if ($("imageryToggle").checked) await loadBodyImagery();
    else removeImagery();
  });
  $("tilesToggle").addEventListener("change", toggleGoogleTiles);

  $("homeBtn").addEventListener("click", goHome);
  $("tiltBtn").addEventListener("click", () => {
    viewer.camera.setView({
      orientation: { heading: viewer.camera.heading, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 }
    });
  });

  $("searchForm").addEventListener("submit", search);
  $("goCoordinateBtn").addEventListener("click", goToCoordinates);
  $("distanceBtn").addEventListener("click", () => startMeasure("distance"));
  $("areaBtn").addEventListener("click", () => startMeasure("area"));
  $("finishMeasureBtn").addEventListener("click", finishMeasure);
  $("clearMeasureBtn").addEventListener("click", clearMeasure);
  $("closeInfoBtn").addEventListener("click", () => $("infoPanel").classList.add("hidden"));
  $("streetViewBtn").addEventListener("click", () => {
    if (streetViewLink) window.open(streetViewLink, "_blank", "noopener,noreferrer");
  });
  $("historyEnabled").checked = historyIsEnabled();
  $("historyEnabled").addEventListener("change", e => {
    localStorage.setItem(STORAGE.historyEnabled, String(e.target.checked));
  });
  $("clearHistoryBtn").addEventListener("click", () => {
    if (!confirm("閲覧履歴と検索履歴をすべて削除しますか？")) return;
    write(STORAGE.history, []);
    write(STORAGE.searches, []);
    renderAllLists();
  });

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction(event => {
    const cartographic = pickCartographic(event.position);
    if (!cartographic) {
      toast("地表位置を取得できませんでした。地図上の別の場所を選んでください。");
      return;
    }
    if (measureMode) {
      addMeasurePoint(cartographic);
      return;
    }
    const coords = {
      lat: Cesium.Math.toDegrees(cartographic.latitude),
      lon: Cesium.Math.toDegrees(cartographic.longitude)
    };
    createPin(coords, "名称未設定", "");
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function pickCartographic(position) {
  let cartesian;
  if (viewer.scene.pickPositionSupported) {
    cartesian = viewer.scene.pickPosition(position);
  }
  if (!Cesium.defined(cartesian)) {
    cartesian = viewer.camera.pickEllipsoid(position, BODIES[currentBody].ellipsoid);
  }
  return Cesium.defined(cartesian)
    ? BODIES[currentBody].ellipsoid.cartesianToCartographic(cartesian)
    : null;
}

async function setBody(body) {
  if (!BODIES[body]) return;
  currentBody = body;
  selectedPinId = null;

  document.querySelectorAll("[data-body]").forEach(b =>
    b.classList.toggle("active", b.dataset.body === body));

  // Remove body-specific content rather than carrying Earth content to another body.
  removeImagery();
  removeGoogleTiles();
  $("tilesToggle").checked = false;
  $("tilesToggle").disabled = body !== "earth";
  $("imageryToggle").checked = true;

  viewer.scene.globe = new Cesium.Globe(BODIES[body].ellipsoid);
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#101827");
  viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider({
    ellipsoid: BODIES[body].ellipsoid
  });

  clearMeasure();
  goHome();
  await loadBodyImagery();
  $("layerStatus").textContent =
    body === "earth"
      ? "地球：画像レイヤーは未設定です。3D街並みはGoogle APIキー設定後に利用できます。"
      : `${bodyName(body)}：指定ionアセットを画像として読み込みます。アセット種別・権限の確認が必要です。`;
  renderPinList();
}

function goHome() {
  const [lon, lat, height] = BODIES[currentBody].home;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, height, BODIES[currentBody].ellipsoid),
    orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    duration: 1.2
  });
}

function removeImagery() {
  if (imageryLayer) {
    try { viewer.imageryLayers.remove(imageryLayer, true); } catch {}
    imageryLayer = null;
  }
}

async function loadBodyImagery() {
  if (!$("imageryToggle").checked) return;
  if (currentBody === "earth") {
    $("layerStatus").textContent =
      "地球画像：ion画像アセットを設定すると表示できます。3D街並みは別設定です。";
    return;
  }
  if (!CONFIG.CESIUM_ION_TOKEN || CONFIG.CESIUM_ION_TOKEN.startsWith("PASTE_")) {
    $("layerStatus").textContent = "画像未表示：Cesium ionトークンを設定してください。";
    return;
  }

  const assetId = currentBody === "moon"
    ? CONFIG.MOON_ION_ASSET_ID
    : CONFIG.MARS_ION_ASSET_ID;

  try {
    const provider = await Cesium.IonImageryProvider.fromAssetId(assetId);
    imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
    $("layerStatus").textContent =
      `${bodyName(currentBody)}画像を読み込みました（ion asset ${assetId}）。` +
      "表示されない場合はアセット種別・権限・座標系を確認してください。";
  } catch (error) {
    $("layerStatus").textContent =
      `画像を読み込めません（asset ${assetId}）。ionのアセット種別、アクセス権、トークンを確認してください。`;
    console.error("Ion imagery error", error);
  }
}

function removeGoogleTiles() {
  if (googleTileset) {
    viewer.scene.primitives.remove(googleTileset);
    googleTileset = null;
  }
}
async function toggleGoogleTiles() {
  if (!$("tilesToggle").checked) {
    removeGoogleTiles();
    return;
  }
  if (currentBody !== "earth") {
    $("tilesToggle").checked = false;
    toast("Google Photorealistic 3D Tilesは地球向けです。");
    return;
  }
  if (!CONFIG.GOOGLE_MAPS_API_KEY) {
    $("tilesToggle").checked = false;
    toast("Google Maps Platformのブラウザ公開キーをscript.jsに設定してください。");
    $("layerStatus").textContent =
      "3D街並み未接続：Google Maps Platformのキー、API有効化、課金設定が必要です。";
    return;
  }
  try {
    $("layerStatus").textContent = "Google Photorealistic 3D Tilesを読み込み中…";
    googleTileset = await Cesium.createGooglePhotorealistic3DTileset({
      key: CONFIG.GOOGLE_MAPS_API_KEY
    });
    viewer.scene.primitives.add(googleTileset);
    $("layerStatus").textContent =
      "Google Photorealistic 3D Tilesを表示中。地球の3Dデータです。";
  } catch (error) {
    $("tilesToggle").checked = false;
    $("layerStatus").textContent =
      "3D街並みの読み込みに失敗しました。キー制限、Maps Tiles API有効化、課金、通信を確認してください。";
    console.error("Google 3D Tiles error", error);
  }
}

async function search(event) {
  event.preventDefault();
  const query = $("searchInput").value.trim();
  if (!query) return;

  saveSearch(query);
  $("infoTitle").textContent = "検索結果";
  $("infoContent").textContent = "検索中…";
  $("infoPanel").classList.remove("hidden");

  try {
    let results;
    if (currentBody === "earth") {
      const url = new URL(CONFIG.NOMINATIM_URL);
      url.search = new URLSearchParams({
        q: query, format: "jsonv2", limit: "5"
      }).toString();
      const response = await fetch(url, {
        headers: { "Accept": "application/json" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      results = (await response.json()).map(item => ({
        name: item.display_name,
        lat: Number(item.lat),
        lon: Number(item.lon),
        source: "OpenStreetMap Nominatim"
      }));
    } else {
      results = LOCAL_PLACES[currentBody]
        .filter(place => place.name.toLowerCase().includes(query.toLowerCase()))
        .map(place => ({ ...place }));
    }
    showSearchResults(results);
  } catch (error) {
    $("infoContent").textContent =
      `検索に失敗しました。通信、CORS、検索サービスの利用条件を確認してください。(${error.message})`;
  }
}

function showSearchResults(results) {
  if (!results.length) {
    $("infoContent").textContent = currentBody === "earth"
      ? "検索結果がありません。"
      : "同梱の代表地点データに一致する結果がありません。月・火星の検索範囲は限定されています。";
    return;
  }
  $("infoContent").innerHTML = results.map((r, i) =>
    `<div class="list-item">
      <button class="open-item" data-result="${i}">
        ${escapeHtml(r.name)}<br>
        <small>${formatCoord(r.lat)}, ${formatCoord(r.lon)} · ${escapeHtml(r.source || "")}</small>
      </button>
    </div>`).join("");

  $("infoContent").querySelectorAll("[data-result]").forEach(button => {
    button.addEventListener("click", () => {
      const r = results[Number(button.dataset.result)];
      flyTo(r.lat, r.lon);
      createPin({ lat: r.lat, lon: r.lon }, r.name, "");
    });
  });
}

function saveSearch(query) {
  if (!historyIsEnabled()) return;
  const items = read(STORAGE.searches);
  items.unshift({ id: crypto.randomUUID(), body: currentBody, query, at: new Date().toISOString() });
  write(STORAGE.searches, items.slice(0, 100));
  renderSearchHistory();
}

function goToCoordinates() {
  const lat = Number($("latInput").value);
  const lon = Number($("lonInput").value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    toast("緯度は-90〜90、経度は-180〜180で入力してください。");
    return;
  }
  flyTo(lat, lon);
  createPin({ lat, lon }, "座標から追加", "");
}

function flyTo(lat, lon) {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      lon, lat, currentBody === "earth" ? 2500 : 80000, BODIES[currentBody].ellipsoid
    ),
    duration: 1.4
  });
}

function createPin(coords, name, note) {
  const pin = {
    id: crypto.randomUUID(),
    name,
    note,
    body: currentBody,
    lat: coords.lat,
    lon: coords.lon,
    createdAt: new Date().toISOString()
  };
  const pins = read(STORAGE.pins);
  pins.unshift(pin);
  write(STORAGE.pins, pins);
  selectedPinId = pin.id;
  addPinEntity(pin);
  renderPinList();
  showPin(pin);
  return pin;
}

function addPinEntity(pin) {
  const id = `pin-${pin.id}`;
  if (viewer.entities.getById(id)) viewer.entities.removeById(id);
  if (pin.body !== currentBody) return;
  viewer.entities.add({
    id,
    position: Cesium.Cartesian3.fromDegrees(pin.lon, pin.lat, 0, BODIES[pin.body].ellipsoid),
    point: {
      pixelSize: 11,
      color: Cesium.Color.fromCssColorString("#ffcf5c"),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
    },
    label: {
      text: pin.name || "ピン",
      font: "13px sans-serif",
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -18),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
    }
  });
}

function showPin(pin) {
  selectedPinId = pin.id;
  $("infoPanel").classList.remove("hidden");
  $("infoTitle").textContent = pin.name || "地点情報";
  const capabilities = pin.body === "earth"
    ? "地球：Google 3D街並みはキー設定後利用可能。交通・災害等の情報レイヤーは未接続。"
    : `${bodyName(pin.body)}：地球向け情報レイヤー、Google 3D Tiles、ストリートビューは利用対象外です。`;

  $("infoContent").innerHTML = `
    <div><b>対象天体：</b>${escapeHtml(bodyName(pin.body))}</div>
    <div><b>緯度・経度：</b>${formatCoord(pin.lat)}, ${formatCoord(pin.lon)}</div>
    <div><b>作成日時：</b>${escapeHtml(new Date(pin.createdAt).toLocaleString())}</div>
    <div class="muted">${escapeHtml(capabilities)}</div>
    <label>名称</label><input id="editPinName" value="${escapeHtml(pin.name)}">
    <label>メモ</label><textarea id="editPinNote">${escapeHtml(pin.note)}</textarea>
    <div class="quick-actions">
      <button id="savePinEdit">保存</button>
      <button id="deletePin" class="danger">削除</button>
    </div>`;

  $("savePinEdit").onclick = () => {
    const pins = read(STORAGE.pins);
    const target = pins.find(p => p.id === pin.id);
    if (!target) return;
    target.name = $("editPinName").value.trim() || "名称未設定";
    target.note = $("editPinNote").value;
    write(STORAGE.pins, pins);
    addPinEntity(target);
    renderPinList();
    showPin(target);
  };
  $("deletePin").onclick = () => deletePin(pin.id);

  checkStreetView(pin);
}

function deletePin(id) {
  write(STORAGE.pins, read(STORAGE.pins).filter(pin => pin.id !== id));
  viewer.entities.removeById(`pin-${id}`);
  if (selectedPinId === id) {
    selectedPinId = null;
    $("streetViewBtn").classList.add("hidden");
    $("streetViewStatus").textContent = "";
    $("infoContent").textContent = "ピンを削除しました。";
  }
  renderPinList();
}

function renderPinList() {
  const pins = read(STORAGE.pins).filter(p => p.body === currentBody);
  $("pinList").innerHTML = pins.length ? pins.map(pin =>
    `<div class="list-item">
      <button class="open-item" data-open-pin="${escapeHtml(pin.id)}">
        ${escapeHtml(pin.name)}<br>
        <small>${formatCoord(pin.lat)}, ${formatCoord(pin.lon)}</small>
      </button>
      <button data-delete-pin="${escapeHtml(pin.id)}" aria-label="削除">×</button>
    </div>`).join("") : `<span class="muted">保存ピンはありません。</span>`;

  $("pinList").querySelectorAll("[data-open-pin]").forEach(button => {
    button.onclick = () => {
      const pin = read(STORAGE.pins).find(p => p.id === button.dataset.openPin);
      if (!pin) return;
      addPinEntity(pin);
      flyTo(pin.lat, pin.lon);
      showPin(pin);
    };
  });
  $("pinList").querySelectorAll("[data-delete-pin]").forEach(button => {
    button.onclick = () => deletePin(button.dataset.deletePin);
  });
}

function checkStreetView(pin) {
  streetViewLink = null;
  $("streetViewBtn").classList.add("hidden");
  $("streetViewStatus").textContent = "";

  if (pin.body !== "earth") {
    $("streetViewStatus").textContent = "ストリートビューは地球向け機能です。";
    return;
  }
  if (!CONFIG.GOOGLE_MAPS_API_KEY) {
    $("streetViewStatus").textContent =
      "ストリートビュー未確認：Google Maps JavaScript APIキーを別途設定してください。";
    return;
  }

  loadGoogleMaps().then(() => {
    const service = new google.maps.StreetViewService();
    service.getPanorama({
      location: { lat: pin.lat, lng: pin.lon },
      radius: 1000,
      source: google.maps.StreetViewSource.OUTDOOR
    }, (data, status) => {
      if (status !== google.maps.StreetViewStatus.OK || !data?.location?.latLng) {
        $("streetViewStatus").textContent = "この地点付近のストリートビューはありません。";
        return;
      }
      const pos = data.location.latLng;
      const panoLat = pos.lat();
      const panoLon = pos.lng();
      const date = data.imageDate || "撮影日は取得できません";
      const distance = Cesium.Cartesian3.distance(
        Cesium.Cartesian3.fromDegrees(pin.lon, pin.lat),
        Cesium.Cartesian3.fromDegrees(panoLon, panoLat)
      );
      $("streetViewStatus").textContent =
        `ピン位置：${formatCoord(pin.lat)}, ${formatCoord(pin.lon)}。` +
        `撮影位置：${formatCoord(panoLat)}, ${formatCoord(panoLon)}（約${Math.round(distance)}m）。撮影日：${date}。`;
      streetViewLink =
        `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${panoLat},${panoLon}`;
      $("streetViewBtn").classList.remove("hidden");
    });
  }).catch(error => {
    $("streetViewStatus").textContent =
      `ストリートビュー確認に失敗しました。API有効化・キー制限・通信を確認してください。(${error.message})`;
  });
}

let googleMapsPromise;
function loadGoogleMaps() {
  if (window.google?.maps) return Promise.resolve();
  if (googleMapsPromise) return googleMapsPromise;
  googleMapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(CONFIG.GOOGLE_MAPS_API_KEY)}`;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Google Maps JavaScript APIの読み込み失敗"));
    document.head.appendChild(script);
  });
  return googleMapsPromise;
}

function recordView() {
  if (!historyIsEnabled() || !viewer || !viewer.camera.positionCartographic) return;
  const p = viewer.camera.positionCartographic;
  const entry = {
    id: crypto.randomUUID(),
    body: currentBody,
    lat: Cesium.Math.toDegrees(p.latitude),
    lon: Cesium.Math.toDegrees(p.longitude),
    height: p.height,
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
    roll: viewer.camera.roll,
    at: new Date().toISOString()
  };
  const key = [entry.body, entry.lat.toFixed(3), entry.lon.toFixed(3),
    entry.height.toFixed(0)].join(":");
  if (key === lastHistoryKey) return;
  lastHistoryKey = key;
  const items = read(STORAGE.history);
  items.unshift(entry);
  write(STORAGE.history, items.slice(0, 100));
  renderHistory();
}

function renderHistory() {
  const items = read(STORAGE.history).slice(0, 30);
  $("historyList").innerHTML = items.length ? items.map(item =>
    `<div class="list-item">
      <button class="open-item" data-history="${escapeHtml(item.id)}">
        ${escapeHtml(bodyName(item.body))} · ${formatCoord(item.lat)}, ${formatCoord(item.lon)}
        <br><small>${escapeHtml(new Date(item.at).toLocaleString())}</small>
      </button>
      <button data-delete-history="${escapeHtml(item.id)}" aria-label="削除">×</button>
    </div>`).join("") : `<span class="muted">閲覧履歴はありません。</span>`;

  $("historyList").querySelectorAll("[data-history]").forEach(button => {
    button.onclick = () => {
      const item = read(STORAGE.history).find(x => x.id === button.dataset.history);
      if (!item) return;
      setBody(item.body).then(() => viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          item.lon, item.lat, item.height, BODIES[item.body].ellipsoid
        ),
        orientation: { heading: item.heading, pitch: item.pitch, roll: item.roll }
      }));
    };
  });
  $("historyList").querySelectorAll("[data-delete-history]").forEach(button => {
    button.onclick = () => {
      write(STORAGE.history, read(STORAGE.history).filter(x => x.id !== button.dataset.deleteHistory));
      renderHistory();
    };
  });
}

function renderSearchHistory() {
  const items = read(STORAGE.searches).slice(0, 30);
  $("searchHistoryList").innerHTML = items.length ? items.map(item =>
    `<div class="list-item">
      <button class="open-item" data-search-history="${escapeHtml(item.id)}">
        ${escapeHtml(bodyName(item.body))} · ${escapeHtml(item.query)}
        <br><small>${escapeHtml(new Date(item.at).toLocaleString())}</small>
      </button>
      <button data-delete-search="${escapeHtml(item.id)}" aria-label="削除">×</button>
    </div>`).join("") : `<span class="muted">検索履歴はありません。</span>`;

  $("searchHistoryList").querySelectorAll("[data-search-history]").forEach(button => {
    button.onclick = async () => {
      const item = read(STORAGE.searches).find(x => x.id === button.dataset.searchHistory);
      if (!item) return;
      await setBody(item.body);
      $("searchInput").value = item.query;
      $("searchForm").requestSubmit();
    };
  });
  $("searchHistoryList").querySelectorAll("[data-delete-search]").forEach(button => {
    button.onclick = () => {
      write(STORAGE.searches, read(STORAGE.searches).filter(x => x.id !== button.dataset.deleteSearch));
      renderSearchHistory();
    };
  });
}

function renderAllLists() {
  renderPinList();
  renderHistory();
  renderSearchHistory();
}

function startMeasure(mode) {
  clearMeasure();
  measureMode = mode;
  $("measureStatus").textContent = mode === "distance"
    ? "地図をクリックして2点以上を指定し、「測定終了」を押してください。"
    : "地図をクリックして3点以上を指定し、「測定終了」を押してください。";
}
function addMeasurePoint(cartographic) {
  measurePoints.push(cartographic);
  const position = Cesium.Cartesian3.fromRadians(
    cartographic.longitude, cartographic.latitude, 0, BODIES[currentBody].ellipsoid
  );
  measureEntities.push(viewer.entities.add({
    position,
    point: { pixelSize: 8, color: Cesium.Color.CYAN },
    polyline: measurePoints.length > 1 ? {
      positions: measurePoints.map(p => Cesium.Cartesian3.fromRadians(
        p.longitude, p.latitude, 0, BODIES[currentBody].ellipsoid
      )),
      width: 2,
      material: Cesium.Color.CYAN
    } : undefined
  }));
  $("measureStatus").textContent = `${measurePoints.length}点を指定しました。`;
}

function finishMeasure() {
  if (!measureMode) return;
  if (measureMode === "distance") {
    if (measurePoints.length < 2) {
      $("measureStatus").textContent = "距離測定には2点以上必要です。";
      return;
    }
    let meters = 0;
    for (let i = 1; i < measurePoints.length; i++) {
      const g = new Cesium.EllipsoidGeodesic(
        measurePoints[i - 1], measurePoints[i], BODIES[currentBody].ellipsoid
      );
      meters += g.surfaceDistance;
    }
    $("measureStatus").textContent =
      `地表距離（楕円体上の測地線の合計）：${meters >= 1000 ? (meters / 1000).toFixed(3) + " km" : meters.toFixed(1) + " m"}`;
  } else {
    if (measurePoints.length < 3) {
      $("measureStatus").textContent = "面積測定には3点以上必要です。";
      return;
    }
    const radius = (BODIES[currentBody].ellipsoid.maximumRadius +
      BODIES[currentBody].ellipsoid.minimumRadius) / 2;
    const area = sphericalPolygonArea(measurePoints, radius);
    $("measureStatus").textContent =
      `球面近似面積（天体平均半径を使用）：${area >= 1e6 ? (area / 1e6).toFixed(3) + " km²" : area.toFixed(0) + " m²"}`;
  }
  measureMode = null;
}

function sphericalPolygonArea(points, radius) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += (b.longitude - a.longitude) *
      (2 + Math.sin(a.latitude) + Math.sin(b.latitude));
  }
  return Math.abs(sum * radius * radius / 2);
}
function clearMeasure() {
  measureEntities.forEach(entity => viewer?.entities.remove(entity));
  measureEntities = [];
  measurePoints = [];
  measureMode = null;
  if ($("measureStatus")) $("measureStatus").textContent = "測定を解除しました。";
}

document.addEventListener("DOMContentLoaded", init);
