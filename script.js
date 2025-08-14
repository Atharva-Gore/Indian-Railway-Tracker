// Indian Railways Live Status Tracker
// - Leaflet map over India
// - Animated train marker along route
// - Timeline + ETA
// - Optional Live API (fallback to mock)
// - Shareable: ?train=INR12627

const $ = id => document.getElementById(id);

// DOM
const themeToggle = $('themeToggle');
const trainInput = $('trainInput');
const trackBtn = $('trackBtn');

const trainNameEl = $('trainName');
const trainNoEl = $('trainNo');
const lastUpdateEl = $('lastUpdate');
const currentStationEl = $('currentStation');
const nextStationEl = $('nextStation');
const delayInfoEl = $('delayInfo');

const etaCountdownEl = $('etaCountdown');
const distanceLeftEl = $('distanceLeft');
const etaExactEl = $('etaExact');

const timelineEl = $('timeline');
const toastContainer = $('toastContainer');

const useLiveApiEl = $('useLiveApi');
const apiUrlEl = $('apiUrl');
const apiKeyEl = $('apiKey');

// Map
let map, routeLine, trainMarker;

// State
let currentTrain = null;
let pollTimer = null;
let animFrame = null;
let animStartTs = 0;
let animDuration = 4000; // ms to animate segment
let fromLatLng = null;
let toLatLng = null;

// Theme
if(localStorage.getItem('rail_theme') === 'dark') document.body.classList.add('dark');
themeToggle.onclick = () => {
  document.body.classList.toggle('dark');
  localStorage.setItem('rail_theme', document.body.classList.contains('dark') ? 'dark' : 'light');
};

// Toast
function toast(msg, t=4000){
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(()=>{ el.style.opacity=0; setTimeout(()=>el.remove(), 350); }, t);
}

// Haversine distance (km)
function haversine(a, b){
  const R = 6371;
  const toRad = d => d * Math.PI/180;
  const dLat = toRad(b[0]-a[0]);
  const dLon = toRad(b[1]-a[1]);
  const lat1 = toRad(a[0]), lat2 = toRad(b[0]);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function polyDistanceKm(points){
  let sum = 0;
  for(let i=1;i<points.length;i++) sum += haversine(points[i-1], points[i]);
  return sum;
}

// India demo route (your provided data)
const MOCK_ROUTES = {
  // Demo number
  "INR12627": {
    trainNo: "INR12627",
    trainName: "BharatCourier Express (Demo)",
    delayMinutes: 0,
    // Stations along the way (Mumbai -> Pune -> Hyderabad -> Bangalore -> Chennai)
    stations: [
      { code:"CSMT", name:"Mumbai CSMT",     lat:19.0760, lng:72.8777, sch:"08:00", act:"08:00" },
      { code:"PUNE", name:"Pune Jn",         lat:18.5204, lng:73.8567, sch:"12:30", act:"12:30" },
      { code:"HYB",  name:"Hyderabad Deccan",lat:17.3850, lng:78.4867, sch:"20:30", act:"20:35" },
      { code:"SBC",  name:"Bengaluru City",  lat:12.9716, lng:77.5946, sch:"05:30", act:"05:45" },
      { code:"MAS",  name:"Chennai Central", lat:13.0827, lng:80.2707, sch:"11:30", act:"11:35" }
    ]
  }
};

// Map setup
function ensureMap(){
  if(!map){
    map = L.map('map', { zoomControl: true }).setView([22.3511, 78.6677], 5); // India center
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:'© OpenStreetMap contributors'
    }).addTo(map);
  }
}

// Draw route polyline and station markers
function drawRoute(stations){
  ensureMap();
  const points = stations.map(s => [s.lat, s.lng]);
  if(routeLine) routeLine.remove();
  routeLine = L.polyline(points, { weight:5 }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [20,20] });

  // Start marker at first station if none
  const start = points[0];
  if(!trainMarker){
    const trainIcon = L.divIcon({
      className: 'train-icon',
      html: '<div style="font-size:20px">🚆</div>',
      iconSize: [24,24],
      iconAnchor: [12,12]
    });
    trainMarker = L.marker(start, { icon: trainIcon }).addTo(map);
  }
}

// Animate marker from A -> B
function animateMarker(from, to, duration=animDuration){
  cancelAnimationFrame(animFrame);
  animStartTs = performance.now();
  function step(ts){
    const p = Math.min((ts - animStartTs) / duration, 1);
    const lat = from[0] + (to[0]-from[0]) * p;
    const lng = from[1] + (to[1]-from[1]) * p;
    trainMarker.setLatLng([lat, lng]);
    if(p < 1) animFrame = requestAnimationFrame(step);
  }
  animFrame = requestAnimationFrame(step);
}

// Build timeline UI
function renderTimeline(stations, index){
  timelineEl.innerHTML = '';
  stations.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = i === index ? 'active' : '';
    li.innerHTML = `
      <div class="title">${s.name} (${s.code})</div>
      <div class="meta">Sch: ${s.sch}${s.act ? ` • Act: ${s.act}` : ''}</div>
    `;
    timelineEl.appendChild(li);
  });
}

// Compute ETA & details
function updateEta(stations, currentIdx){
  const points = stations.map(s=>[s.lat,s.lng]);
  // distance left from current index to end
  const remainingPoints = points.slice(currentIdx);
  const remainingKm = polyDistanceKm(remainingPoints);
  const avgKmph = 70; // assumed cruising speed
  const hours = remainingKm / avgKmph;
  const etaMs = Date.now() + hours * 3600 * 1000;

  distanceLeftEl.textContent = `${remainingKm.toFixed(1)} km`;
  etaExactEl.textContent = new Date(etaMs).toLocaleString();

  // countdown display
  function updateCountdown(){
    const ms = etaMs - Date.now();
    if(ms <= 0){ etaCountdownEl.textContent = 'Arrived'; return; }
    const s = Math.floor(ms/1000);
    const h = Math.floor(s/3600);
    const m = Math.floor((s%3600)/60);
    const sec = s%60;
    etaCountdownEl.textContent = `${h}h ${m}m ${sec}s`;
    requestAnimationFrame(updateCountdown);
  }
  updateCountdown();
}

// -------- Live API hook (optional) --------
// Expected to return an object you can map in mapApiToRoute()
// If the call or mapping fails, the app falls back to MOCK_ROUTES.
async function tryFetchLiveRoute(trainNo, apiUrl, apiKey){
  if(!apiUrl) throw new Error('No API URL');
  const url = apiUrl.replace('{trainNo}', encodeURIComponent(trainNo));
  const headers = {};
  if(apiKey) headers['Authorization'] = apiKey;
  const res = await fetch(url, { headers });
  if(!res.ok) throw new Error('API error');
  const json = await res.json();
  return mapApiToRoute(json);
}

// Map your API JSON into our internal format:
// { trainNo, trainName, delayMinutes, stations:[{code,name,lat,lng,sch,act}] }
function mapApiToRoute(json){
  // *** EDIT THIS to match your actual API response structure ***
  // Below is a safe fallback that throws unless expected fields exist.
  if(!json || !json.trainNo || !Array.isArray(json.stations)){
    throw new Error('Unexpected API schema');
  }
  return {
    trainNo: json.trainNo,
    trainName: json.trainName || 'Live Train',
    delayMinutes: json.delayMinutes || 0,
    stations: json.stations.map(s => ({
      code: s.code || '',
      name: s.name || '',
      lat: s.lat,
      lng: s.lng,
      sch: s.scheduled || '',
      act: s.actual || ''
    }))
  };
}

// Select current segment based on time heuristic (demo):
// Move forward one station per poll, or keep within bounds.
function estimateCurrentIndex(stations){
  // Use URL hash memory so it looks continuous
  const key = 'rail_idx:' + (currentTrain || 'demo');
  let idx = parseInt(localStorage.getItem(key) || '0', 10);
  idx = Math.min(Math.max(idx, 0), stations.length - 2);
  // advance index ~every other poll to simulate motion
  const toggleKey = 'rail_toggle:' + (currentTrain || 'demo');
  const t = (parseInt(localStorage.getItem(toggleKey) || '0', 10) + 1) % 2;
  localStorage.setItem(toggleKey, String(t));
  if(t === 0 && idx < stations.length - 2) idx++;
  localStorage.setItem(key, String(idx));
  return idx;
}

// Update UI + Map from a route object
function renderRoute(route){
  currentTrain = route.trainNo;
  trainNameEl.textContent = route.trainName;
  trainNoEl.textContent = route.trainNo;
  lastUpdateEl.textContent = new Date().toLocaleString();
  delayInfoEl.textContent = route.delayMinutes > 0 ? `Delayed ${route.delayMinutes} min` : 'On time';
  delayInfoEl.style.background = route.delayMinutes > 0 ? '#fee2e2' : '#e2e8f0';
  delayInfoEl.style.color = route.delayMinutes > 0 ? '#991b1b' : '#0f172a';

  drawRoute(route.stations);

  // Determine current & next station
  const idx = estimateCurrentIndex(route.stations);
  const cur = route.stations[idx];
  const nxt = route.stations[idx+1] || route.stations[idx];

  currentStationEl.textContent = `Current station: ${cur.name} (${cur.code})`;
  nextStationEl.textContent = `Next station: ${nxt.name} (${nxt.code})`;

  // Animate marker from current -> next
  const from = [cur.lat, cur.lng];
  const to = [nxt.lat, nxt.lng];
  animateMarker(from, to);

  // Timeline + ETA
  renderTimeline(route.stations, idx);
  updateEta(route.stations, idx);
}

// Poll loop
function startPolling(routeProvider){
  if(pollTimer) clearInterval(pollTimer);
  const poll = async () => {
    try {
      const route = await routeProvider();
      renderRoute(route);
    } catch(e){
      toast('Update failed: ' + e.message);
    }
  };
  poll(); // initial
  pollTimer = setInterval(poll, 30000); // 30s
}

// Routing: decide live vs mock
function getRouteProvider(trainNo){
  const useLive = useLiveApiEl.checked;
  const apiUrl = apiUrlEl.value.trim();
  const apiKey = apiKeyEl.value.trim();

  if(useLive && apiUrl){
    return async () => {
      try {
        const r = await tryFetchLiveRoute(trainNo, apiUrl, apiKey);
        if(!r || !r.stations || !r.stations.length) throw new Error('Empty route');
        return r;
      } catch(e){
        toast('Live API failed, using demo route.');
        return (MOCK_ROUTES[trainNo] || MOCK_ROUTES['INR12627']);
      }
    };
  }
  // mock only
  return async () => (MOCK_ROUTES[trainNo] || MOCK_ROUTES['INR12627']);
}

// URL helpers
function setUrlTrain(trainNo){
  const u = new URL(location.href);
  u.searchParams.set('train', trainNo);
  history.replaceState(null, '', u.toString());
}
function getUrlTrain(){
  const u = new URL(location.href);
  return u.searchParams.get('train');
}

// Wire UI
trackBtn.onclick = () => {
  const t = (trainInput.value || '').trim().toUpperCase();
  if(!t){ toast('Enter a train number'); return; }
  setUrlTrain(t);
  const provider = getRouteProvider(t);
  startPolling(provider);
};

// Init
window.addEventListener('load', () => {
  ensureMap();

  // Prefill demo live API URL (optional): leave blank by default
  // Example placeholder: apiUrlEl.value = 'https://your-api.example.com/live?train={trainNo}';

  // Load from URL or default
  const t = (getUrlTrain() || 'INR12627').toUpperCase();
  trainInput.value = t;

  const provider = getRouteProvider(t);
  startPolling(provider);
});
