// Replace this with your "Published as CSV" link from Google Sheets
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTsQOS8r4GbYTOG_PBqeTNjTUBsvyURtrN2SqCw4lnoeeW7PvLdvcUqqIH0QOuDY8XBnLEjBiBJQI78/pub?output=csv';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyDsXcjTPKsRCXsK_2Wz7Xm-jVUOB5flDi9tMq0RTMP6IotOEXdaUh5gvjCRGsXbf1uYg/exec';

let airstripData = [];

let map;
let routeLine;
let markers = [];

function initMap() {
    map = L.map('routeMap').setView([-25.2744, 133.7751], 4); // Australia default

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
}

window.addEventListener('load', initMap);

function getSelectedLatLng(selectId) {
    const el = document.getElementById(selectId);
    if (!el || !el.selectedOptions[0]) return null;

    const opt = el.selectedOptions[0];
    const lat = parseFloat(opt.dataset.lat);
    const lon = parseFloat(opt.dataset.lon);

    if (isNaN(lat) || isNaN(lon)) return null;

    return [lat, lon];
}

//let firstDraw = true;

function updateRouteMap() {
    if (!map) return;

    const points = [];

    // 1. Get Origin (A)
    const origin = getSelectedLatLng('origin');
    if (origin) points.push(origin);

    // 2. Get Destination (B)
    const destination = getSelectedLatLng('destination');
    if (destination) points.push(destination);

    // 3. Get all the dynamically added stops (C, D, E...)
    const extraStops = Array.from(document.querySelectorAll('select[name="intermediateStop[]"]'))
        .map(s => {
            const opt = s.selectedOptions[0];
            if (!opt || !opt.dataset.lat) return null;
            const lat = parseFloat(opt.dataset.lat);
            const lon = parseFloat(opt.dataset.lon);
            return isNaN(lat) ? null : [lat, lon];
        })
        .filter(Boolean);

    // Add them to the end of the chain
    points.push(...extraStops);

    // --- RENDER LOGIC ---
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    if (routeLine) map.removeLayer(routeLine);
    if (points.length === 0) return;

    // Use labels A, B, C, D, E, F, G in order
    const labels = ["A", "B", "C", "D", "E", "F", "G"];

    points.forEach((p, i) => {
        const label = labels[i] || "?";
        
        // Define pin color/style logic
        let type = "stop"; 
        if (i === 0) type = "origin"; // A is Origin
        if (i === points.length - 1) type = "destination"; // The last point in the chain is the Destination

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

    routeLine = L.polyline(points, {
        color: 'blue',
        weight: 3
    }).addTo(map);

    if (points.length >= 2) {
        map.fitBounds(routeLine.getBounds(), { padding: [20, 20], maxZoom: 8 });
    }
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

        populateDropdown(document.getElementById('origin'));
        populateDropdown(document.getElementById('destination'));
    } catch (error) {
        console.error('Error loading airstrips:', error);
    }
}

function populateDropdown(selectElement) {
    if (!selectElement) return;

    selectElement.innerHTML = '<option value="">Select Location</option>';

    const options = airstripData
        .map(cols => {
            const optionText = `${cols?.[0] || ""} (${cols?.[1] || ""}) - ${cols?.[3] || ""}`;

            return {
                text: optionText,
                lat: cols[4],
                lon: cols[5]
            };
        })
        .sort((a, b) => a.text.localeCompare(b.text));

    options.forEach(optData => {
        const opt = new Option(optData.text, optData.text);
        opt.dataset.lat = optData.lat;
        opt.dataset.lon = optData.lon;
        selectElement.add(opt);
    });
}

/* ========================================
   DYNAMIC LEGS LOGIC
   ======================================== */
if (addLegBtn) {
    addLegBtn.addEventListener('click', () => {
        const currentLegs = document.querySelectorAll('.leg-row').length;
        if (currentLegs >= 5) return;

        // NEW: Labels logic
        const labels = ['C', 'D', 'E', 'F', 'G'];
        const legLabel = labels[currentLegs]; // This is the new stop (C, D, etc.)
        
        // If it's the first extra leg (C), previous was B. 
        // Otherwise, it was the letter before this one in the labels array.
        const prevStopLabel = (currentLegs === 0) ? 'B' : labels[currentLegs - 1];

        // 1. Show the static "Wait at B" box if we just added C
        const waitAtB = document.getElementById('waitAtBContainer');
        if (waitAtB) waitAtB.style.display = 'block';

        const legId = Date.now();
        const legDiv = document.createElement('div');
        legDiv.className = 'leg-row';
        legDiv.id = `leg-${legId}`;
        
        legDiv.innerHTML = `
            <div style="display: flex; align-items: flex-end; gap: 10px; margin-bottom: 15px;">
                <div style="flex: 2;">
                    <label style="font-weight: bold; font-size: 0.9rem; margin-top: 0;">${legLabel} (Destination):</label>
                    <select name="intermediateStop[]" required style="width: 100%; padding: 8px;"></select>
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
        populateDropdown(legDiv.querySelector('select'));
        legDiv.querySelector('select').addEventListener('change', scheduleRouteUpdate);
    });
}

function removeLeg(id) {
    const element = document.getElementById(id);
    if (element) element.remove();
    
    // If no more legs (C, D, etc.), hide Wait at B
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
    routeUpdateTimeout = setTimeout(updateRouteMap, 100);
}

function bindRouteListeners() {
    const origin = document.getElementById('origin');
    const destination = document.getElementById('destination');

    if (origin) origin.addEventListener('change', scheduleRouteUpdate);
    if (destination) destination.addEventListener('change', scheduleRouteUpdate);

    document.addEventListener('change', (e) => {
        if (e.target && e.target.name === 'intermediateStop[]') {
            scheduleRouteUpdate();
        }
    });
}

/* ========================================
   CLOCK GENERATOR (15-minute intervals)
   ======================================== */
const generateClockOptions = (maxHours, defaultH = 0, defaultM = 30) => {
    let options = '';
    for (let h = 0; h <= maxHours; h++) {
        for (let m = 0; m < 60; m += 15) { // Changed to 15-minute steps
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
    // These IDs must match your HTML input IDs exactly
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

        const stops = Array.from(document.querySelectorAll('select[name="intermediateStop[]"]'))
            .map(s => s.value)
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
            origin: document.getElementById('origin')?.value || "",
            destination: document.getElementById('destination')?.value || "",
            departureDate: document.getElementById('departureDate')?.value || "",
            departureTime: document.getElementById('departureTime')?.value || "",
            passengers: document.getElementById('passengers')?.value || "",
            intermediateStops: stops
        };

        summaryArea.innerHTML = `
            <p><strong>Name:</strong> ${pendingData.firstName} ${pendingData.surname}</p>
            <p><strong>Route:</strong> ${pendingData.origin} → ${pendingData.destination}</p>
            ${stops.length > 0 ? `<p><strong>Stops:</strong> ${stops.join(', ')}</p>` : ''}
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
            // -------------------------
            // BASIC VALIDATION
            // -------------------------
            const origin = get("origin");
            const destination = get("destination");

            if (!origin || !destination) {
                alert("Please select origin and destination");
                return;
            }

            // -------------------------
            // BUILD FORM DATA
            // -------------------------
            const formData = new URLSearchParams();

            // Contact & Personal Details
            formData.append("firstName", get("firstName"));
            formData.append("surname", get("surname"));
            formData.append("business", get("business"));
            formData.append("address", combineAddress());
            formData.append("email", get("email"));
            formData.append("phone", get("phone"));
            formData.append("departureDate", get("departureDate"));
            formData.append("departureTime", get("departureTime"));
            formData.append("passengers", get("passengers"));
            formData.append("origin", origin);

            // -------------------------
            // CLEAN ROUTE BUILD
            // -------------------------
            const stops = (pendingData.intermediateStops || []).filter(v => v && v.trim() !== "");
            const route = [origin, destination, ...stops]; 
            const totalDestinations = 1 + stops.length; // B + (any extra stops)

            // -------------------------
            // MAP DESTINATIONS (B-G)
            // -------------------------
            const destLetters = ['B', 'C', 'D', 'E', 'F', 'G'];
            for (let i = 0; i < 6; i++) {
                const label = `Destination ${destLetters[i]}`;
                formData.append(label, route[i + 1] || "");
            }

            // -------------------------
            // MAP WAIT TIMES (Conditional)
            // -------------------------
            // Only send Wait B if C exists
            if (totalDestinations > 1) {
                formData.append("waitTimeB", document.getElementById('waitTimeB')?.value || "");
            } else {
                formData.append("waitTimeB", "");
            }

            // Only send Wait C, D, E, F if a destination follows them
            const dynamicWaitSelects = document.querySelectorAll('select[name="waitTime[]"]');
            const waitLetters = ['C', 'D', 'E', 'F'];

            waitLetters.forEach((letter, index) => {
                // index 0 = Wait C. If totalDestinations is 3 (B, C, D), 3 > 2 is true.
                if (totalDestinations > (index + 2)) {
                    formData.append(`waitTime${letter}`, dynamicWaitSelects[index]?.value || "");
                } else {
                    formData.append(`waitTime${letter}`, "");
                }
            });

            // -------------------------
            // SEND TO APPS SCRIPT
            // -------------------------
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
        // 23 hours max, default to 08:00
        timeSelect.innerHTML = generateClockOptions(23, 8, 0);
    }
};