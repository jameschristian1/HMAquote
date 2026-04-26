// Replace this with your "Published as CSV" link from Google Sheets
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTsQOS8r4GbYTOG_PBqeTNjTUBsvyURtrN2SqCw4lnoeeW7PvLdvcUqqIH0QOuDY8XBnLEjBiBJQI78/pub?output=csv';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz7QwPFhouoBGZvQbg0REuRze2vWlvcESErZ1njq8A3uue4tJJTwgVLUxwoPZyjzi77eA/exec';

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

    const origin = getSelectedLatLng('origin');
    if (origin) points.push(origin);

    const stops = Array.from(document.querySelectorAll('select[name="intermediateStop[]"]'))
        .map(s => {
            const opt = s.selectedOptions[0];
            if (!opt) return null;
            const lat = parseFloat(opt.dataset.lat);
            const lon = parseFloat(opt.dataset.lon);
            return isNaN(lat) ? null : [lat, lon];
        })
        .filter(Boolean);

    points.push(...stops);

    const destination = getSelectedLatLng('destination');
    if (destination) points.push(destination);

    markers.forEach(m => map.removeLayer(m));
    markers = [];

    if (routeLine) map.removeLayer(routeLine);

    if (points.length === 0) return;

    const labels = ["A", "B", "C", "D", "E", "F", "G"];

    points.forEach((p, i) => {
        const label = labels[i] || "?";

        let type = "stop";
        if (i === 0) type = "origin";
        else if (i === points.length - 1) type = "destination";

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
        const bounds = routeLine.getBounds();

        map.fitBounds(bounds, {
            padding: [20, 20],
            maxZoom: 8   // prevents zooming too far into remote airstrips
        });
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
const legsContainer = document.getElementById('legsContainer');
const addLegBtn = document.getElementById('addLegBtn');

if (addLegBtn) {
    addLegBtn.addEventListener('click', () => {
        const currentLegs = document.querySelectorAll('select[name="intermediateStop[]"]').length;

        if (currentLegs >= 5) {
            alert("Maximum 5 intermediate stops allowed (6 landings total including origin and destination).");
            return;
        }

        const legId = Date.now();
        const legDiv = document.createElement('div');
        legDiv.className = 'leg-row';
        legDiv.id = `leg-${legId}`;
        legDiv.innerHTML = `
            <div style="display: flex; align-items: flex-end; gap: 10px;">
                <div style="flex-grow: 1;">
                    <label>Intermediate Stop:</label>
                    <select name="intermediateStop[]" required></select>
                </div>
                <button type="button" class="remove-btn" onclick="removeLeg('leg-${legId}')" 
                        style="background: #dc3545; width: 40px; margin-bottom: 10px;">X</button>
            </div>
        `;
        legDiv.querySelector('select').addEventListener('change', scheduleRouteUpdate);
        legsContainer.appendChild(legDiv);
        populateDropdown(legDiv.querySelector('select'));
    });
}

function removeLeg(id) {
    const element = document.getElementById(id);
    if (element) element.remove();
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
            depDate: document.getElementById('depDate')?.value || "",
            depTime: document.getElementById('depTime')?.value || "",
            passengers: document.getElementById('passengers')?.value || "",
            intermediateStops: stops
        };

        summaryArea.innerHTML = `
            <p><strong>Name:</strong> ${pendingData.firstName} ${pendingData.surname}</p>
            <p><strong>Route:</strong> ${pendingData.origin} → ${pendingData.destination}</p>
            ${stops.length > 0 ? `<p><strong>Stops:</strong> ${stops.join(', ')}</p>` : ''}
            <p><strong>Departure:</strong> ${pendingData.depDate} at ${pendingData.depTime}</p>
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

            formData.append("firstName", get("firstName"));
            formData.append("surname", get("surname"));
            formData.append("business", get("business"));
            formData.append("address", combineAddress());
            formData.append("email", get("email"));
            formData.append("phone", get("phone"));

            formData.append("origin", origin);
            formData.append("destination", destination);

            formData.append("depDate", get("depDate"));
            formData.append("depTime", get("depTime"));
            formData.append("passengers", get("passengers"));

            // -------------------------
            // CLEAN ROUTE BUILD
            // -------------------------
            const stops = (pendingData.intermediateStops || [])
                .filter(v => v && v.trim() !== "");

            const route = [origin, ...stops, destination];

            // -------------------------
            // MAP TO GAS FIELDS
            // (Destination 1–6 = route legs AFTER origin)
            // -------------------------
            for (let i = 0; i < 6; i++) {
                formData.append(`Destination ${i + 1}`, route[i + 1] || "");
            }

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

    const dateInput = document.getElementById('depDate');
    if (dateInput) dateInput.min = new Date().toISOString().split("T")[0];
};