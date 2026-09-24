// Replace this with your "Published as CSV" link from Google Sheets
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTsQOS8r4GbYTOG_PBqeTNjTUBsvyURtrN2SqCw4lnoeeW7PvLdvcUqqIH0QOuDY8XBnLEjBiBJQI78/pub?output=csv';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxChdsB11TPcY3TATTVYFq2Vg7Mi_Qh2NnRuoyqKJgof3Z6Mm5CXUnSmgj5gjOJbzYXww/exec';

// Max destinations beyond Location A. A + 10 destinations = Locations A-K.
const MAX_DESTINATIONS = 10;

let airstripData = [];
let airstripOptionsCache = []; // [{text, lat, lon}] - built once, used to resolve a stop's coords instantly on selection

let map;
let routeLine;
let markers = [];

// Single source of truth for the route's destinations (Location B onward).
// Location A stays its own separate field, same as before, since it's the
// fixed origin rather than one of an open-ended list.
let routeStops = []; // [{ name, stopType, groundWaitMins }]

function initMap() {
    map = L.map('routeMap').setView([-25.2744, 133.7751], 4); // Australia default

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
}

window.addEventListener('load', initMap);

function resolveAirstripCoords(name) {
    if (!name) return null;
    const match = airstripOptionsCache.find(o => o.text === name.toString().trim());
    if (!match) return null;
    const lat = parseFloat(match.lat);
    const lon = parseFloat(match.lon);
    if (isNaN(lat) || isNaN(lon)) return null;
    return [lat, lon];
}

function isResolvedAirstrip(name) {
    return !!airstripOptionsCache.find(o => o.text === (name || "").toString().trim());
}

function updateRouteMap() {
    if (!map) return;

    const points = [];
    const stopTypes = [];

    const locationA = resolveAirstripCoords(document.getElementById('locationA')?.value || "");
    if (locationA) { points.push(locationA); stopTypes.push('LAND'); }

    routeStops.forEach(stop => {
        if (stop.lat == null || stop.lon == null || stop.lat === "" || stop.lon === "") return;
        const lat = parseFloat(stop.lat);
        const lon = parseFloat(stop.lon);
        if (isNaN(lat) || isNaN(lon)) return;
        points.push([lat, lon]);
        stopTypes.push(stop.stopType || 'LAND');
    });

    markers.forEach(m => map.removeLayer(m));
    markers = [];
    if (routeLine) map.removeLayer(routeLine);
    if (points.length === 0) return;

    const labels = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)); // A-Z

    points.forEach((p, i) => {
        const label = labels[i] || "?";
        let type = "stop";
        if (i === 0) type = "locationA";
        else if (i === points.length - 1) type = "destination";
        else if (stopTypes[i] === "WAYPOINT") type = "waypoint";

        const marker = L.marker(p, {
            icon: L.divIcon({
                className: "route-label-marker",
                html: `<div class="route-pin ${type}">${label}</div>`,
                iconSize: [26, 26],
                iconAnchor: [13, 13]
            })
        }).addTo(map);
        markers.push(marker);
    });

    routeLine = L.polyline(points, { color: 'blue', weight: 3 }).addTo(map);
    if (points.length >= 2) {
        map.fitBounds(routeLine.getBounds(), { padding: [20, 20], maxZoom: 8 });
    }
}

/* ========================================
   DYNAMIC ROUTE STOPS (Location B onward)
   ======================================== */

async function loadAirstrips() {
    try {
        const response = await fetch(SHEET_URL);
        const data = await response.text();
        const rows = data.split('\n').slice(1);
        airstripData = rows.map(row => {
            const cols = row.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g);
            return cols;
        }).filter(cols => cols && cols.length >= 6);

        airstripOptionsCache = airstripData.map(cols => ({
            text: `${cols?.[0] || ""} (${cols?.[1] || ""}) - ${cols?.[3] || ""}`,
            lat: cols[4],
            lon: cols[5]
        }));

        populateAirstripDatalist();
        renderRouteStops(); // re-renders any destination rows already on screen
    } catch (error) {
        console.error('Error loading airstrips:', error);
    }
}

function populateAirstripDatalist() {
    const datalist = document.getElementById('fwAirstripOptions');
    if (!datalist) return;

    datalist.innerHTML = '';

    [...airstripOptionsCache]
        .sort((a, b) => a.text.localeCompare(b.text))
        .forEach(optData => {
            const opt = document.createElement('option');
            opt.value = optData.text;
            datalist.appendChild(opt);
        });
}

// Renders every destination row from routeStops. Fully re-creates the DOM
// each time (matching how the operational Sandbox modals render their
// route cards) - safe here since every mutation is a discrete select/button
// action, never continuous typing, so there's no focus to lose.
function renderRouteStops() {
    // The last stop is always a landing, and never bills wait time before a
    // wait control even exists for it — enforced on the data itself here,
    // not just the display, so a stale value can never sneak into what
    // actually gets submitted (same pattern used in the ops Sandboxes).
    if (routeStops.length > 0) {
        routeStops[routeStops.length - 1].stopType = "LAND";
        routeStops[routeStops.length - 1].groundWaitMins = 0;
    }

    const container = document.getElementById('routeStopsContainer');
    if (!container) return;

    const labels = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)); // A-Z; B = labels[1]

    container.innerHTML = routeStops.map((stop, i) => {
        const label = labels[i + 1] || "?";
        const isLast = (i === routeStops.length - 1);
        const isWaypoint = stop.stopType === "WAYPOINT";
        const showWait = !isLast && !isWaypoint;
        const waitMins = stop.groundWaitMins || 0;
        const safeName = (stop.name || "").replace(/"/g, '&quot;');

        return `
          <div class="leg-row" data-index="${i}" style="margin-top: 15px;">
            <div style="display: flex; align-items: flex-end; gap: 10px;">
                <div style="flex: 2;">
                    <label style="font-weight: bold; font-size: 0.9rem; margin-top: 0;">Location ${label}</label>
                    <input type="text" data-role="location-input" list="fwAirstripOptions" value="${safeName}"
                        placeholder="Start typing an airfield name or code..." required style="width: 100%; padding: 8px;"
                        oninput="updateStopName(${i}, this.value)">
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

    updateAddButtonState();
}

// Typing only updates the data + schedules a map refresh - it deliberately
// never calls renderRouteStops(), which would replace this very input's
// DOM node mid-keystroke and lose focus/cursor position.
function updateStopName(index, value) {
    if (!routeStops[index]) return;
    routeStops[index].name = value;
    const match = airstripOptionsCache.find(o => o.text === value.toString().trim());
    routeStops[index].lat = match ? match.lat : null;
    routeStops[index].lon = match ? match.lon : null;
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
    renderRouteStops();
    scheduleRouteUpdate();
}

function shiftStopDown(index) {
    if (index === routeStops.length - 1) return;
    [routeStops[index + 1], routeStops[index]] = [routeStops[index], routeStops[index + 1]];
    renderRouteStops();
    scheduleRouteUpdate();
}

function removeRouteStop(index) {
    routeStops.splice(index, 1);
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
if (addLegBtn) {
    addLegBtn.addEventListener('click', () => {
        if (routeStops.length >= MAX_DESTINATIONS) return;
        // 30-minute default matches this form's original convention (the
        // ops Sandboxes default new stops to 15 minutes, but that's a
        // different tool with different conventions - kept separate
        // deliberately rather than copied over unasked).
        routeStops.push({ name: "", stopType: "LAND", groundWaitMins: 30 });
        renderRouteStops();
    });
}

let routeUpdateTimeout;

function scheduleRouteUpdate() {
    clearTimeout(routeUpdateTimeout);
    routeUpdateTimeout = setTimeout(updateRouteMap, 100);
}

function bindRouteListeners() {
    const locationA = document.getElementById('locationA');
    if (locationA) locationA.addEventListener('input', scheduleRouteUpdate);
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

        const locationA = document.getElementById('locationA')?.value || "";
        const namedStops = routeStops.filter(s => s.name && s.name.trim() !== "");

        if (!locationA || !isResolvedAirstrip(locationA)) {
            alert("Please select Location A from the suggested list of airfields.");
            return;
        }
        const unresolvedStop = namedStops.find(s => !isResolvedAirstrip(s.name));
        if (unresolvedStop) {
            alert(`"${unresolvedStop.name}" isn't a recognised airfield. Please pick from the suggested list as you type.`);
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
            locationA: locationA,
            departureDate: document.getElementById('departureDate')?.value || "",
            departureTime: document.getElementById('departureTime')?.value || "",
            passengers: document.getElementById('passengers')?.value || "",
            stops: namedStops
        };

        summaryArea.innerHTML = `
            <p><strong>Name:</strong> ${pendingData.firstName} ${pendingData.surname}</p>
            <p><strong>Route:</strong> ${pendingData.locationA} → ${namedStops.map(s => s.name).join(' → ')}</p>
            <p><strong>Departure:</strong> ${pendingData.departureDate} at ${pendingData.departureTime}</p>
            <p><strong>Passengers:</strong> ${pendingData.passengers}</p>
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
            const locationA = get("locationA");
            const namedStops = routeStops.filter(s => s.name && s.name.trim() !== "");

            if (!locationA || !isResolvedAirstrip(locationA)) {
                alert("Please select Location A from the suggested list of airfields.");
                return;
            }
            const unresolvedStop = namedStops.find(s => !isResolvedAirstrip(s.name));
            if (unresolvedStop) {
                alert(`"${unresolvedStop.name}" isn't a recognised airfield. Please pick from the suggested list as you type.`);
                return;
            }
            if (namedStops.length === 0) {
                alert("Please select location A and at least one destination.");
                return;
            }

            const formData = new URLSearchParams();

            formData.append("formType", "fixedwing");
            formData.append("firstName", get("firstName"));
            formData.append("surname", get("surname"));
            formData.append("business", get("business"));
            formData.append("address", combineAddress());
            formData.append("email", get("email"));
            formData.append("phone", get("phone"));
            formData.append("departureDate", get("departureDate"));
            formData.append("departureTime", get("departureTime"));
            formData.append("passengers", get("passengers"));
            formData.append("locationA", locationA);

            // Single JSON payload for every destination, in order - replaces
            // the old fixed Location B-G / waitTimeB-F / stopTypeB-F fields.
            // Only the resolved fields the backend actually needs travel
            // across; lat/lon ride along too since the ops side already
            // expects that shape.
            const routeJson = namedStops.map(s => ({
                name: s.name,
                lat: s.lat != null ? Number(s.lat) : null,
                lon: s.lon != null ? Number(s.lon) : null,
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
        // 23 hours max, default to 08:00
        timeSelect.innerHTML = generateClockOptions(23, 8, 0);
    }
};
