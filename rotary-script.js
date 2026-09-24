// Replace this with your "Published as CSV" link from Google Sheets
// (Reuses the same airfield list as the fixed-wing form — helicopters can
// use registered airstrips too, this just isn't the ONLY option anymore.)
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTsQOS8r4GbYTOG_PBqeTNjTUBsvyURtrN2SqCw4lnoeeW7PvLdvcUqqIH0QOuDY8XBnLEjBiBJQI78/pub?output=csv';

// ⚠️ PLACEHOLDER — there is no rotary intake backend yet (no handler, no
// sheet). DO NOT point this at the fixed-wing APPS_SCRIPT_URL: a rotary
// submission would be written into the fixed-wing Requests sheet with
// mismatched columns, corrupting data silently. Replace this once a real
// rotary doPost handler + sheet exists.
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxChdsB11TPcY3TATTVYFq2Vg7Mi_Qh2NnRuoyqKJgof3Z6Mm5CXUnSmgj5gjOJbzYXww/exec';

// Max destinations beyond Location A. A + 10 destinations = Locations A-K.
const MAX_DESTINATIONS = 10;

let airstripData = [];

let map;
let routeLine;
let markers = [];

// Location A is tracked separately (fixed origin, not part of the
// open-ended list). routeStops holds the up to 10 destination stops
// (B through K) in order - single source of truth for the whole
// route, same convention the ops Sandboxes use for compiledRouteStops.
let locationAStop = { name: "", lat: null, lon: null, isCustomLocation: false };
let routeStops = []; // [{ name, lat, lon, isCustomLocation, stopType, groundWaitMins }]

// Which field a map click or marker drag should update: "A" for the
// origin, or an integer index into routeStops for a destination. Using a
// logical key rather than a raw DOM element reference means it stays valid
// across re-renders, which replace the destination rows' actual DOM nodes.
let activeFieldKey = null;

function initMap() {
    map = L.map('routeMap').setView([-25.2744, 133.7751], 4); // Australia default

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    map.on('mousemove', (e) => {
        const el = document.getElementById('cursorLatLon');
        if (el) el.textContent = e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5);
    });

    map.on('click', (e) => {
        if (activeFieldKey === null) {
            alert("Please click into a location field first (e.g. Location A), then click the map.");
            return;
        }
        setStopFromCoords(activeFieldKey, e.latlng.lat, e.latlng.lng);
        renderRouteStops();
        advanceToNextLocationField();
        scheduleRouteUpdate();
    });
}

window.addEventListener('load', initMap);

function setStopFromCoords(key, lat, lon) {
    const label = `Custom location (${lat.toFixed(5)}, ${lon.toFixed(5)})`;
    if (key === "A") {
        locationAStop = { name: label, lat, lon, isCustomLocation: true };
        const el = document.getElementById('locationA');
        if (el) el.value = label;
    } else if (routeStops[key]) {
        routeStops[key].name = label;
        routeStops[key].lat = lat;
        routeStops[key].lon = lon;
        routeStops[key].isCustomLocation = true;
    }
}

function getLocationFieldKeysInOrder() {
    return ["A", ...routeStops.map((_, i) => i)];
}

function getLocationInputElement(key) {
    if (key === "A") return document.getElementById('locationA');
    const row = document.querySelector(`.leg-row[data-index="${key}"]`);
    return row ? row.querySelector('[data-role="location-input"]') : null;
}

function setActiveLocationField(key) {
    activeFieldKey = key;
    document.querySelectorAll('.active-location-target').forEach(f => f.classList.remove('active-location-target'));

    const el = key !== null ? getLocationInputElement(key) : null;
    if (el) el.classList.add('active-location-target');

    const label = document.getElementById('activeFieldLabel');
    if (label) {
        const currentVal = key === "A" ? locationAStop.name : (routeStops[key] ? routeStops[key].name : "");
        label.textContent = el
            ? `Click the map to set this location (currently editing: "${currentVal || el.placeholder}")`
            : 'Click into a location field above, then click the map to set that location.';
    }
}

function advanceToNextLocationField() {
    const keys = getLocationFieldKeysInOrder();
    const currentIndex = keys.indexOf(activeFieldKey);
    if (currentIndex === -1) return;
    const nextKey = keys[currentIndex + 1];
    if (nextKey !== undefined) {
        setActiveLocationField(nextKey);
        const el = getLocationInputElement(nextKey);
        if (el) el.focus();
    }
}

/* ========================================
   AIRSTRIP LOOKUP (hybrid: known airstrip OR free-text description)
   ======================================== */
function buildOptionText(cols) {
    return `${cols?.[0] || ""} (${cols?.[1] || ""}) - ${cols?.[3] || ""}`;
}

function findAirstripCoords(inputValue) {
    if (!inputValue) return null;
    const trimmed = inputValue.trim();
    const match = airstripData.find(cols => buildOptionText(cols) === trimmed);
    if (!match) return null;
    const lat = parseFloat(match[4]);
    const lon = parseFloat(match[5]);
    if (isNaN(lat) || isNaN(lon)) return null;
    return [lat, lon];
}

// Client-side coordinate parser for a typed "lat, lon" string (e.g. a
// bare paste from Google Maps: "-23.698, 133.881"). This was previously
// called from updateRouteMap() but never actually defined anywhere in
// this file - only its server-side twin (parseTypedCoordinatesServer,
// below) existed, meaning any typed-but-unmatched location silently threw
// instead of resolving. Fixed here as part of this rewrite.
function parseTypedCoordinates(value) {
    if (!value) return null;
    const match = value.toString().trim().match(/(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
    if (!match) return null;
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    if (isNaN(lat) || isNaN(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return [lat, lon];
}

function resolveStopCoords(stop) {
    if (stop.isCustomLocation && stop.lat != null && stop.lon != null) return [stop.lat, stop.lon];
    return findAirstripCoords(stop.name) || parseTypedCoordinates(stop.name);
}

/**
 * Server-side twin of this file's parseTypedCoordinates. Matches "lat, lon"
 * wherever it appears in the string — covers both a bare paste from Google
 * Maps ("-23.698, 133.881") and the map-click feature's own generated label
 * ("Custom location (-23.698, 133.881)"). Not currently called by anything
 * in this client file — kept here as the reference implementation for the
 * Apps Script backend, where a real copy of this function should live as
 * its own .gs function if the backend ever needs to re-resolve a typed
 * location independently of what the client already sends.
 */
function parseTypedCoordinatesServer(value) {
  if (!value) return null;
  const match = value.toString().trim().match(/(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (!match) return null;
  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);
  if (isNaN(lat) || isNaN(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

async function loadAirstrips() {
    try {
        const response = await fetch(SHEET_URL);
        const data = await response.text();
        const rows = data.split('\n').slice(1);
        airstripData = rows.map(row => {
            const cols = row.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g);
            return cols;
        }).filter(cols => cols && cols.length >= 6);

        populateSharedDatalist();
    } catch (error) {
        console.error('Error loading airstrips:', error);
    }
}

function populateSharedDatalist() {
    const datalist = document.getElementById('airstripOptions');
    if (!datalist) return;

    datalist.innerHTML = '';

    const options = airstripData
        .map(cols => buildOptionText(cols))
        .sort((a, b) => a.localeCompare(b));

    options.forEach(text => {
        const opt = document.createElement('option');
        opt.value = text;
        datalist.appendChild(opt);
    });
}

function updateRouteMap() {
    if (!map) return;

    const allStops = [
        { key: "A", stopType: "LAND", name: locationAStop.name, lat: locationAStop.lat, lon: locationAStop.lon, isCustomLocation: locationAStop.isCustomLocation },
        ...routeStops.map((s, i) => ({ key: i, ...s }))
    ];

    const resolvedPoints = [];
    const unresolvedLabels = [];
    const labels = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

    allStops.forEach((stop, i) => {
        const value = (stop.name || "").trim();
        if (!value) return;
        const coords = resolveStopCoords(stop);
        if (coords) {
            resolvedPoints.push({ label: labels[i] || "?", coords, key: stop.key, stopType: stop.stopType });
        } else {
            unresolvedLabels.push(`${labels[i] || "?"}: "${value}"`);
        }
    });

    markers.forEach(m => map.removeLayer(m));
    markers = [];
    if (routeLine) map.removeLayer(routeLine);

    const pointCoords = resolvedPoints.map(p => p.coords);

    resolvedPoints.forEach((p, i) => {
        let type = "stop";
        if (i === 0) type = "locationA";
        else if (i === resolvedPoints.length - 1) type = "destination";
        else if (p.stopType === "WAYPOINT") type = "waypoint";

        const marker = L.marker(p.coords, {
            draggable: true,
            icon: L.divIcon({
                className: "route-label-marker",
                html: `<div class="route-pin ${type}">${p.label}</div>`,
                iconSize: [26, 26],
                iconAnchor: [13, 13]
            })
        }).addTo(map).bindTooltip("Drag to move this location", { direction: 'top', offset: [0, -10] });

        marker.on('dragend', () => {
            const newPos = marker.getLatLng();
            setStopFromCoords(p.key, newPos.lat, newPos.lng);
            renderRouteStops();
            scheduleRouteUpdate();
        });

        markers.push(marker);
    });

    if (pointCoords.length > 0) {
        routeLine = L.polyline(pointCoords, { color: 'blue', weight: 3 }).addTo(map);
        if (pointCoords.length >= 2) map.fitBounds(routeLine.getBounds(), { padding: [20, 20], maxZoom: 8 });
    }

    const notice = document.getElementById('unresolvedNotice');
    if (notice) {
        if (unresolvedLabels.length > 0) {
            notice.style.display = 'block';
            notice.textContent = `Note: the following locations aren't registered airstrips and won't show on the map, but have been recorded — our team will confirm access with you: ${unresolvedLabels.join('; ')}`;
        } else {
            notice.style.display = 'none';
            notice.textContent = '';
        }
    }
}

/* ========================================
   DYNAMIC ROUTE STOPS (Location B onward)
   ======================================== */

// Renders every destination row from routeStops. Rebuilds the destination
// rows' DOM each time (add/remove/stop-type-change/drag), but NEVER on a
// plain keystroke in a location field (see updateStopName) - that would
// wipe focus and cursor position mid-typing.
function renderRouteStops() {
    // Keep Location A's displayed value in sync - it isn't part of this
    // dynamic list, but a map click/drag can still set it programmatically.
    const locAInput = document.getElementById('locationA');
    if (locAInput && locAInput.value !== locationAStop.name) locAInput.value = locationAStop.name;

    // Last stop is always a landing with no wait before it even has a
    // control - enforced on the data itself, not just the display, same
    // pattern as the ops Sandboxes' enforceEndpointStopTypes().
    if (routeStops.length > 0) {
        routeStops[routeStops.length - 1].stopType = "LAND";
        routeStops[routeStops.length - 1].groundWaitMins = 0;
    }

    const container = document.getElementById('legsContainer');
    if (!container) return;

    const labels = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

    container.innerHTML = routeStops.map((stop, i) => {
        const label = labels[i + 1] || "?";
        const isLast = (i === routeStops.length - 1);
        const isWaypoint = stop.stopType === "WAYPOINT";
        const showWait = !isLast && !isWaypoint;
        const waitMins = stop.groundWaitMins || 0;
        const safeName = (stop.name || "").replace(/"/g, '&quot;');

        return `
          <div class="leg-row" data-index="${i}">
            <div style="display: flex; align-items: flex-end; gap: 10px; margin-bottom: 15px;">
                <div style="flex: 2;">
                    <label style="font-weight: bold; font-size: 0.9rem; margin-top: 0;">Location ${label}</label>
                    <input type="text" data-role="location-input" list="airstripOptions" value="${safeName}"
                        placeholder="Airstrip, property name, or description" required style="width: 100%; padding: 8px;">
                </div>

                <div style="flex: 0.9; min-width: 110px;">
                    <label style="font-weight: bold; font-size: 0.8rem; margin-top: 0;">Stop type:</label>
                    <select style="width: 100%; padding: 8px;" ${isLast ? 'disabled title="The final stop on your route is always a landing."' : ''} onchange="updateStopType(${i}, this.value)">
                        <option value="LAND" ${stop.stopType === "LAND" ? "selected" : ""}>🛬 Land</option>
                        <option value="WAYPOINT" ${isWaypoint ? "selected" : ""}>📍 Fly over</option>
                    </select>
                </div>

                <div class="wait-time-group" style="flex: 1; min-width: 130px; background: #f0f7ff; padding: 8px; border-radius: 4px; border: 1px solid #d0e4ff; ${showWait ? 'display:block;' : 'display:none;'}">
                    <label style="font-weight: bold; font-size: 0.8rem; margin-top: 0;">Wait at ${label}:</label>
                    <select style="width: 100%; padding: 4px; margin-top: 4px;" onchange="updateStopWait(${i}, this.value)">
                        ${generateClockOptions(12, Math.floor(waitMins / 60), waitMins % 60)}
                    </select>
                </div>

                <div style="display: flex; gap: 4px; flex-shrink: 0;">
                    <button type="button" onclick="shiftStopUp(${i})" ${i === 0 ? 'disabled' : ''}
                        style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; width: 32px; height: 38px; border-radius: 4px; cursor: pointer; font-weight: bold; padding: 0; margin-top: 0;${i === 0 ? ' opacity: 0.3;' : ''}">▲</button>
                    <button type="button" onclick="shiftStopDown(${i})" ${isLast ? 'disabled' : ''}
                        style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; width: 32px; height: 38px; border-radius: 4px; cursor: pointer; font-weight: bold; padding: 0; margin-top: 0;${isLast ? ' opacity: 0.3;' : ''}">▼</button>
                    <button type="button" onclick="removeRouteStop(${i})"
                        style="background: #dc3545; color: white; width: 40px; height: 38px; border: none; border-radius: 4px; cursor: pointer; margin-top: 0; padding: 0;">X</button>
                </div>
            </div>
          </div>`;
    }).join('');

    // Event listeners re-attached fresh each render, since the input
    // elements themselves are newly created above.
    container.querySelectorAll('[data-role="location-input"]').forEach((inputEl, i) => {
        inputEl.addEventListener('input', () => updateStopName(i, inputEl.value));
        inputEl.addEventListener('focus', () => setActiveLocationField(i));
    });

    updateAddButtonState();
}

// Typing only updates the data + schedules a map refresh - it deliberately
// never calls renderRouteStops(), which would replace this very input's
// DOM node mid-keystroke and lose focus/cursor position.
function updateStopName(index, value) {
    if (!routeStops[index]) return;
    routeStops[index].name = value;
    if (!value.startsWith("Custom location (")) {
        routeStops[index].lat = null;
        routeStops[index].lon = null;
        routeStops[index].isCustomLocation = false;
    }
    scheduleRouteUpdate();
}

function updateStopType(index, value) {
    if (!routeStops[index]) return;
    routeStops[index].stopType = value;
    if (value === "WAYPOINT") routeStops[index].groundWaitMins = 0;
    renderRouteStops();
    scheduleRouteUpdate();
}

function updateStopWait(index, hhmm) {
    if (!routeStops[index]) return;
    const parts = hhmm.split(':');
    routeStops[index].groundWaitMins = (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
}

function shiftStopUp(index) {
    if (index === 0) return;
    [routeStops[index - 1], routeStops[index]] = [routeStops[index], routeStops[index - 1]];
    // A numeric activeFieldKey means "map clicks target this destination by
    // position" - after a swap that position now holds a different stop,
    // so clear it rather than have a map click silently land on the wrong
    // one. The user just needs to click back into a field to resume.
    if (typeof activeFieldKey === "number") setActiveLocationField(null);
    renderRouteStops();
    scheduleRouteUpdate();
}

function shiftStopDown(index) {
    if (index === routeStops.length - 1) return;
    [routeStops[index + 1], routeStops[index]] = [routeStops[index], routeStops[index + 1]];
    if (typeof activeFieldKey === "number") setActiveLocationField(null);
    renderRouteStops();
    scheduleRouteUpdate();
}

function removeRouteStop(index) {
    routeStops.splice(index, 1);
    if (activeFieldKey === index || (typeof activeFieldKey === "number" && activeFieldKey >= routeStops.length)) {
        setActiveLocationField(null);
    }
    renderRouteStops();
    scheduleRouteUpdate();
}

function updateAddButtonState() {
    const btn = document.getElementById('addLegBtn');
    if (!btn) return;
    if (routeStops.length >= MAX_DESTINATIONS) {
        btn.disabled = true;
        btn.textContent = `Maximum ${MAX_DESTINATIONS} additional stops reached`;
    } else {
        btn.disabled = false;
        btn.textContent = "+ Add Stop";
    }
}

const addLegBtn = document.getElementById('addLegBtn');
const legsContainer = document.getElementById('legsContainer');

if (addLegBtn) {
    addLegBtn.addEventListener('click', () => {
        if (routeStops.length >= MAX_DESTINATIONS) return;
        // 30-minute default matches this form's original convention (the
        // ops Sandboxes default new stops to 15 minutes, but that's a
        // different tool with different conventions - kept separate
        // deliberately rather than copied over unasked).
        routeStops.push({ name: "", lat: null, lon: null, isCustomLocation: false, stopType: "LAND", groundWaitMins: 30 });
        renderRouteStops();
        setActiveLocationField(routeStops.length - 1);
        const el = getLocationInputElement(routeStops.length - 1);
        if (el) el.focus();
    });
}

let routeUpdateTimeout;

function scheduleRouteUpdate() {
    clearTimeout(routeUpdateTimeout);
    routeUpdateTimeout = setTimeout(updateRouteMap, 250);
}

function bindRouteListeners() {
    const locationAInput = document.getElementById('locationA');

    if (locationAInput) {
        locationAInput.addEventListener('input', () => {
            locationAStop.name = locationAInput.value;
            if (!locationAInput.value.startsWith("Custom location (")) {
                locationAStop.lat = null;
                locationAStop.lon = null;
                locationAStop.isCustomLocation = false;
            }
            scheduleRouteUpdate();
        });
        locationAInput.addEventListener('focus', () => setActiveLocationField("A"));
    }
}

/* ========================================
   CLOCK GENERATOR
   0 and 5 minutes as two short entries, then clean 15-minute steps from
   there up — matches the wait-time dropdown used in the ops Sandboxes.
   ======================================== */
const generateClockOptions = (maxHours, defaultH = 0, defaultM = 30) => {
    let options = '';
    const totalMaxMins = maxHours * 60;
    const minuteMarks = [0, 5];
    for (let m = 15; m <= totalMaxMins; m += 15) minuteMarks.push(m);

    minuteMarks.forEach(totalMins => {
        const h = Math.floor(totalMins / 60);
        const m = totalMins % 60;
        const hh = h.toString().padStart(2, '0');
        const mm = m.toString().padStart(2, '0');
        const isSelected = (h === defaultH && m === defaultM) ? 'selected' : '';
        options += `<option value="${hh}:${mm}" ${isSelected}>${hh}:${mm}</option>`;
    });
    return options;
};

/* ========================================
   FORMATTING (PHONE & POSTCODE)
   ======================================== */
const phoneInput = document.getElementById('phone');
if (phoneInput) {
    phoneInput.addEventListener('input', () => {
        let digits = phoneInput.value.replace(/\D/g, '').slice(0, 10);
        if (digits.length > 0 && digits[0] !== '0') digits = digits.slice(1);
        if (digits.length > 1 && !'23478'.includes(digits[1])) digits = digits[0];

        let formatted = digits;
        if (digits.startsWith('04')) {
            if (digits.length > 4) formatted = digits.slice(0, 4) + ' ' + digits.slice(4);
            if (digits.length > 7) formatted = digits.slice(0, 4) + ' ' + digits.slice(4, 7) + ' ' + digits.slice(7);
        } else if (digits.length > 2) {
            formatted = digits.slice(0, 2) + ' ' + digits.slice(2, 6) + (digits.length > 6 ? ' ' + digits.slice(6) : '');
        }
        phoneInput.value = formatted;
    });
}

const postcodeInput = document.getElementById('postcode');
if (postcodeInput) {
    postcodeInput.addEventListener('input', () => {
        postcodeInput.value = postcodeInput.value.replace(/\D/g, '').slice(0, 4);
    });
}

function combineAddress() {
    const postal = document.getElementById('postal')?.value.trim() || "";
    const suburb = document.getElementById('suburb')?.value.trim() || "";
    const state = document.getElementById('state')?.value || "";
    const postcode = document.getElementById('postcode')?.value.trim() || "";
    return [postal, suburb, state, postcode].filter(x => x).join(', ');
}

/* ========================================
   MODAL & SUBMIT LOGIC
   ======================================== */
const quoteForm = document.getElementById('quoteForm');
const modal = document.getElementById('confirmModal');
const summaryArea = document.getElementById('summaryArea');
const editBtn = document.getElementById('editBtn');
const finalSubmitBtn = document.getElementById('finalSubmitBtn');

let pendingData = {};

if (quoteForm) {
    quoteForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const namedStops = routeStops.filter(s => s.name && s.name.trim() !== "");

        if (!locationAStop.name.trim()) {
            alert("Please enter Location A.");
            return;
        }
        if (namedStops.length === 0) {
            alert("Please add at least one destination (Location B).");
            return;
        }

        pendingData = {
            firstName: document.getElementById('firstName')?.value || "",
            surname: document.getElementById('surname')?.value || "",
            business: document.getElementById('business')?.value || "",
            address: combineAddress() || "",
            email: document.getElementById('email')?.value || "",
            phone: document.getElementById('phone')?.value || "",
            locationA: locationAStop.name,
            departureDate: document.getElementById('departureDate')?.value || "",
            departureTime: document.getElementById('departureTime')?.value || "",
            passengers: document.getElementById('passengers')?.value || "",
            accessNotes: document.getElementById('accessNotes')?.value || "",
            stops: namedStops
        };

        summaryArea.innerHTML = `
            <p><strong>Name:</strong> ${pendingData.firstName} ${pendingData.surname}</p>
            <p><strong>Route:</strong> ${pendingData.locationA} → ${namedStops.map(s => s.name).join(' → ')}</p>
            <p><strong>Departure:</strong> ${pendingData.departureDate} at ${pendingData.departureTime}</p>
            <p><strong>Passengers:</strong> ${pendingData.passengers}</p>
            ${pendingData.accessNotes ? `<p><strong>Landing Site Notes:</strong> ${pendingData.accessNotes}</p>` : ''}
            <p><strong>Contact:</strong> ${pendingData.email}</p>
        `;
        modal.style.display = 'block';
    });
}

if (editBtn) editBtn.onclick = () => modal.style.display = 'none';

if (finalSubmitBtn) {
    finalSubmitBtn.onclick = async () => {

        finalSubmitBtn.innerText = "Sending...";
        finalSubmitBtn.disabled = true;

        const get = (id) => document.getElementById(id)?.value || "";

        try {
            const locationA = locationAStop.name.trim();
            const namedStops = routeStops.filter(s => s.name && s.name.trim() !== "");

            if (!locationA || namedStops.length === 0) {
                alert("Please enter location A and at least one destination.");
                return;
            }

            const formData = new URLSearchParams();

            formData.append("formType", "rotary");
            formData.append("firstName", get("firstName"));
            formData.append("surname", get("surname"));
            formData.append("business", get("business"));
            formData.append("address", combineAddress());
            formData.append("email", get("email"));
            formData.append("phone", get("phone"));
            formData.append("departureDate", get("departureDate"));
            formData.append("departureTime", get("departureTime"));
            formData.append("passengers", get("passengers"));
            formData.append("accessNotes", get("accessNotes"));
            formData.append("locationA", locationA);

            // Single JSON payload for every destination, in order - replaces
            // the old fixed Location B-G / waitTimeB-F / stopTypeB-F fields.
            const routeJson = namedStops.map(s => ({
                name: s.name,
                lat: s.lat != null ? Number(s.lat) : null,
                lon: s.lon != null ? Number(s.lon) : null,
                isCustomLocation: !!s.isCustomLocation,
                stopType: s.stopType || "LAND",
                groundWaitMins: s.groundWaitMins || 0
            }));
            formData.append("routeJson", JSON.stringify(routeJson));

            const res = await fetch(APPS_SCRIPT_URL, {
                method: "POST",
                body: formData
            });

            const result = await res.json();

            if (!result || result.result !== "success") {
                throw new Error(result?.error || "Submission failed");
            }

            window.location.href = `success.html?quoteId=${result.quoteId}`;

        } catch (err) {
            console.error(err);
            alert("Submission failed. Please try again or check connection.");
        } finally {
            finalSubmitBtn.innerText = "Confirm & Send";
            finalSubmitBtn.disabled = false;
        }
    };
}

window.onload = () => {
    loadAirstrips();
    bindRouteListeners();
    renderRouteStops();

    const dateInput = document.getElementById('departureDate');
    if (dateInput) {
        dateInput.min = new Date().toISOString().split("T")[0];
    }

    const timeSelect = document.getElementById('departureTime');
    if (timeSelect) {
        timeSelect.innerHTML = generateClockOptions(23, 8, 0);
    }
};
