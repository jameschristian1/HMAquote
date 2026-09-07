// Replace this with your "Published as CSV" link from Google Sheets
// (Reuses the same airfield list as the fixed-wing form — helicopters can
// use registered airstrips too, this just isn't the ONLY option anymore.)
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTsQOS8r4GbYTOG_PBqeTNjTUBsvyURtrN2SqCw4lnoeeW7PvLdvcUqqIH0QOuDY8XBnLEjBiBJQI78/pub?output=csv';

// ⚠️ PLACEHOLDER — there is no rotary intake backend yet (no handler, no
// sheet). DO NOT point this at the fixed-wing APPS_SCRIPT_URL: a rotary
// submission would be written into the fixed-wing Requests sheet with
// mismatched columns, corrupting data silently. Replace this once a real
// rotary doPost handler + sheet exists.
const APPS_SCRIPT_URL = 'REPLACE_ME_ROTARY_BACKEND_NOT_YET_BUILT';

let airstripData = [];

let map;
let routeLine;
let markers = [];
let activeLocationInput = null;
let customLocationCoords = new Map(); // input element -> [lat, lon], for map-click-set points

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
        if (!activeLocationInput) {
            alert("Please click into a location field first (e.g. Location A), then click the map.");
            return;
        }

        const lat = e.latlng.lat;
        const lon = e.latlng.lng;

        activeLocationInput.value = `Custom location (${lat.toFixed(5)}, ${lon.toFixed(5)})`;
        customLocationCoords.set(activeLocationInput, [lat, lon]);

        advanceToNextLocationField();
        scheduleRouteUpdate();
    });
}

function getLocationInputsInOrder() {
    return [
        document.getElementById('locationA'),
        document.getElementById('locationB'),
        ...Array.from(document.querySelectorAll('input[name="intermediateStop[]"]'))
    ].filter(Boolean);
}

function setActiveLocationField(el) {
    activeLocationInput = el;
    document.querySelectorAll('.active-location-target').forEach(f => f.classList.remove('active-location-target'));
    if (el) el.classList.add('active-location-target');

    const label = document.getElementById('activeFieldLabel');
    if (label) {
        label.textContent = el
            ? `Click the map to set this location (currently editing: "${el.value || el.placeholder}")`
            : 'Click into a location field above, then click the map to set that location.';
    }
}

function advanceToNextLocationField() {
    const fields = getLocationInputsInOrder();
    const currentIndex = fields.indexOf(activeLocationInput);
    if (currentIndex === -1) return;
    const next = fields[currentIndex + 1];
    if (next) {
        next.focus();
        setActiveLocationField(next);
    }
}

window.addEventListener('load', initMap);

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

function getInputLatLng(inputId) {
    const el = document.getElementById(inputId);
    if (!el) return null;
    return findAirstripCoords(el.value);
}

function parseTypedCoordinates(value) {
    if (!value) return null;
    // Accepts "lat, lon" or "lat,lon" — e.g. "-23.6980, 133.8807",
    // matching what a client would copy straight out of Google Maps.
    const match = value.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
    if (!match) return null;
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    if (isNaN(lat) || isNaN(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return [lat, lon];
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

/* ========================================
   MAP RENDERING
   ======================================== */
function updateRouteMap() {
    if (!map) return;

    const stopInputs = getLocationInputsInOrder();

    const resolvedPoints = [];
    const unresolvedLabels = [];
    const labels = ["A", "B", "C", "D", "E", "F", "G"];

    stopInputs.forEach((input, i) => {
        const value = input?.value?.trim();
        if (!value) return;

        const customCoords = customLocationCoords.get(input);
        const coords = customCoords || findAirstripCoords(value) || parseTypedCoordinates(value);

        if (coords) {
            resolvedPoints.push({ label: labels[i] || "?", coords });
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
        if (i === resolvedPoints.length - 1) type = "destination";

        const marker = L.marker(p.coords, {
            icon: L.divIcon({
                className: "route-label-marker",
                html: `<div class="route-pin ${type}">${p.label}</div>`,
                iconSize: [26, 26],
                iconAnchor: [13, 13]
            })
        }).addTo(map);
        markers.push(marker);
    });

    if (pointCoords.length > 0) {
        routeLine = L.polyline(pointCoords, { color: 'blue', weight: 3 }).addTo(map);
        if (pointCoords.length >= 2) {
            map.fitBounds(routeLine.getBounds(), { padding: [20, 20], maxZoom: 8 });
        }
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
   DYNAMIC LEGS LOGIC
   ======================================== */
const addLegBtn = document.getElementById('addLegBtn');
const legsContainer = document.getElementById('legsContainer');

if (addLegBtn) {
    addLegBtn.addEventListener('click', () => {
        const currentLegs = document.querySelectorAll('.leg-row').length;
        if (currentLegs >= 5) return;

        const labels = ['C', 'D', 'E', 'F', 'G'];
        const legLabel = labels[currentLegs];

        const waitAtB = document.getElementById('waitAtBContainer');
        if (waitAtB) waitAtB.style.display = 'block';

        const legId = Date.now();
        const legDiv = document.createElement('div');
        legDiv.className = 'leg-row';
        legDiv.id = `leg-${legId}`;

        legDiv.innerHTML = `
            <div style="display: flex; align-items: flex-end; gap: 10px; margin-bottom: 15px;">
                <div style="flex: 2;">
                    <label style="font-weight: bold; font-size: 0.9rem; margin-top: 0;">Location ${legLabel}</label>
                    <input type="text" name="intermediateStop[]" list="airstripOptions" placeholder="Airstrip, property name, or description" required style="width: 100%; padding: 8px;">
                </div>

                <div class="wait-time-group" style="flex: 1; min-width: 130px; background: #f0f7ff; padding: 8px; border-radius: 4px; border: 1px solid #d0e4ff;">
                    <label style="font-weight: bold; font-size: 0.8rem; margin-top: 0;">Wait at ${legLabel}:</label>
                    <select name="waitTime[]" style="width: 100%; padding: 4px; margin-top: 4px;">
                        ${generateClockOptions(12, 0, 30)}
                    </select>
                </div>

                <button type="button" onclick="removeLeg('leg-${legId}')"
                        style="background: #dc3545; color: white; width: 40px; height: 38px; border: none; border-radius: 4px; cursor: pointer; margin-top: 0; padding: 0;">X</button>
            </div>
        `;

        legsContainer.appendChild(legDiv);
        const newInput = legDiv.querySelector('input');
        newInput.addEventListener('input', scheduleRouteUpdate);

        // Automatically make the newly added stop the active map-click
        // target, so the very next map click fills THIS stop rather than
        // silently overwriting whichever field was last active.
        setActiveLocationField(newInput);
        newInput.focus();
    });
}

function removeLeg(id) {
    const element = document.getElementById(id);
    if (element) {
        const input = element.querySelector('input[name="intermediateStop[]"]');
        if (input) {
            customLocationCoords.delete(input);
            if (activeLocationInput === input) setActiveLocationField(null);
        }
        element.remove();
    }

    const currentLegs = document.querySelectorAll('.leg-row').length;
    if (currentLegs === 0) {
        const waitAtB = document.getElementById('waitAtBContainer');
        if (waitAtB) waitAtB.style.display = 'none';
    }
    scheduleRouteUpdate();
}

let routeUpdateTimeout;

function scheduleRouteUpdate() {
    clearTimeout(routeUpdateTimeout);
    routeUpdateTimeout = setTimeout(updateRouteMap, 250);
}

function bindRouteListeners() {
    const locationA = document.getElementById('locationA');
    const locationB = document.getElementById('locationB');

    if (locationA) locationA.addEventListener('input', scheduleRouteUpdate);
    if (locationB) locationB.addEventListener('input', scheduleRouteUpdate);

    document.addEventListener('input', (e) => {
        if (e.target && e.target.name === 'intermediateStop[]') {
            scheduleRouteUpdate();
        }
        // Manually editing a field invalidates any coordinate set by clicking the map
        if (e.target && (e.target.id === 'locationA' || e.target.id === 'locationB' || e.target.name === 'intermediateStop[]')) {
            if (customLocationCoords.has(e.target)) {
                customLocationCoords.delete(e.target);
            }
        }
    });

    document.addEventListener('focusin', (e) => {
        if (e.target && (e.target.id === 'locationA' || e.target.id === 'locationB' || e.target.name === 'intermediateStop[]')) {
            setActiveLocationField(e.target);
        }
    });
}

/* ========================================
   CLOCK GENERATOR (15-minute intervals)
   ======================================== */
const generateClockOptions = (maxHours, defaultH = 0, defaultM = 30) => {
    let options = '';
    for (let h = 0; h <= maxHours; h++) {
        for (let m = 0; m < 60; m += 15) {
            const hh = h.toString().padStart(2, '0');
            const mm = m.toString().padStart(2, '0');
            const isSelected = (h === defaultH && m === defaultM) ? 'selected' : '';
            options += `<option value="${hh}:${mm}" ${isSelected}>${hh}:${mm}</option>`;
        }
    }
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

        const stops = Array.from(document.querySelectorAll('input[name="intermediateStop[]"]'))
            .map(s => s.value.trim())
            .filter(v => v);

        if (stops.length > 5) {
            alert("Maximum 5 intermediate stops allowed.");
            return;
        }

        pendingData = {
            firstName: document.getElementById('firstName')?.value || "",
            surname: document.getElementById('surname')?.value || "",
            business: document.getElementById('business')?.value || "",
            address: combineAddress() || "",
            email: document.getElementById('email')?.value || "",
            phone: document.getElementById('phone')?.value || "",
            locationA: document.getElementById('locationA')?.value || "",
            locationB: document.getElementById('locationB')?.value || "",
            departureDate: document.getElementById('departureDate')?.value || "",
            departureTime: document.getElementById('departureTime')?.value || "",
            passengers: document.getElementById('passengers')?.value || "",
            accessNotes: document.getElementById('accessNotes')?.value || "",
            intermediateStops: stops
        };

        summaryArea.innerHTML = `
            <p><strong>Name:</strong> ${pendingData.firstName} ${pendingData.surname}</p>
            <p><strong>Route:</strong> ${pendingData.locationA} → ${pendingData.locationB}</p>
            ${stops.length > 0 ? `<p><strong>Stops:</strong> ${stops.join(', ')}</p>` : ''}
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

        if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.startsWith('REPLACE_ME')) {
            alert("Online rotary wing quote requests aren't available just yet — please contact us directly at quotes@hmair.com.au or call 08 8975 0777, and we'll help arrange your booking.");
            return;
        }

        finalSubmitBtn.innerText = "Sending...";
        finalSubmitBtn.disabled = true;

        const get = (id) => document.getElementById(id)?.value || "";

        try {
            const locationA = get("locationA");
            const locationB = get("locationB");

            if (!locationA || !locationB) {
                alert("Please enter location A and location B");
                return;
            }

            const formData = new URLSearchParams();

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

            const stops = (pendingData.intermediateStops || []).filter(v => v && v.trim() !== "");
            const route = [locationA, locationB, ...stops];
            const totalLocations = 1 + stops.length;

            const locLetters = ['B', 'C', 'D', 'E', 'F', 'G'];
            for (let i = 0; i < 6; i++) {
                const label = `Location ${locLetters[i]}`;
                formData.append(label, route[i + 1] || "");
            }

            if (totalLocations > 1) {
                formData.append("waitTimeB", document.getElementById('waitTimeB')?.value || "");
            } else {
                formData.append("waitTimeB", "");
            }

            const dynamicWaitSelects = document.querySelectorAll('select[name="waitTime[]"]');
            const waitLetters = ['C', 'D', 'E', 'F'];

            waitLetters.forEach((letter, index) => {
                if (totalLocations > (index + 2)) {
                    formData.append(`waitTime${letter}`, dynamicWaitSelects[index]?.value || "");
                } else {
                    formData.append(`waitTime${letter}`, "");
                }
            });

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

    const waitTimeB = document.getElementById('waitTimeB');
    if (waitTimeB) waitTimeB.innerHTML = generateClockOptions(12, 0, 30);

    const dateInput = document.getElementById('departureDate');
    if (dateInput) {
        dateInput.min = new Date().toISOString().split("T")[0];
    }

    const timeSelect = document.getElementById('departureTime');
    if (timeSelect) {
        timeSelect.innerHTML = generateClockOptions(23, 8, 0);
    }
};