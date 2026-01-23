// 1. IMPORTS
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, query, where, getDocs, orderBy, addDoc, updateDoc, Timestamp, GeoPoint, increment, serverTimestamp 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

// --- GLOBAL VARIABLES ---
const content = document.getElementById('content');
const loader = document.getElementById('loader');

let map = null;
let userMarker = null;
let shopMarker = null;
let watchId = null;
let currentVisitId = null;
let visitStartTime = null;
let timerInterval = null;
let currentOrderOutlet = null; // Stores {id, name, status}
let orderCart = [];

// --- CONFIGURATION ---
const GEO_FENCE_RADIUS = 50; // ✅ SET TO 50 METERS

console.log("Salesman Script Loaded");

// --- 2. MAIN EXECUTION (AUTH GUARD) ---
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    try {
        // A. Verify Role
        const userDoc = await getDoc(doc(db, "users", user.uid));
        
        if (!userDoc.exists() || userDoc.data().role !== 'salesman') {
            alert("Access Denied: Salesman role required.");
            logoutUser();
            return;
        }

        // B. Initialize UI
        if (loader) loader.style.display = 'none';
        if (content) content.style.display = 'block';

        // C. Load Initial Data
        checkTodayAttendance(user);
        loadAssignedRoute(user.uid);
        loadDailyTarget();

        // D. Attach Global Listener for Daily Attendance
        const checkInBtn = document.getElementById('checkInBtn');
        if(checkInBtn) {
            checkInBtn.addEventListener('click', () => handleDailyAttendance(user));
        }

    } catch (error) {
        console.error("Init Error:", error);
        alert("System Error: " + error.message);
    }
});

document.getElementById('logoutBtn').addEventListener('click', logoutUser);


// --- 3. ROUTE & SHOP LIST LOGIC ---

async function loadAssignedRoute(uid) {
    const routeNameEl = document.getElementById('route-name');
    const shopsListEl = document.getElementById('shops-list');

    try {
        // Query routes assigned to this user
        const q = query(collection(db, "routes"), where("assignedSalesmanId", "==", uid));
        const routeSnap = await getDocs(q);

        if (routeSnap.empty) {
            routeNameEl.innerText = "No Route Assigned";
            shopsListEl.innerHTML = "<li style='padding:15px; color:orange;'>Contact Admin to assign a route.</li>";
            return;
        }

        const routeDoc = routeSnap.docs[0];
        const routeData = routeDoc.data();
        routeNameEl.innerText = routeData.name;
        
        // Load Outlets linked to this route
        loadShops(routeDoc.id);

    } catch (error) {
        console.error("Load Route Error:", error);
        routeNameEl.innerText = "Error Loading Route";
    }
}

async function loadShops(routeId) {
    const list = document.getElementById('shops-list');
    
    // Note: Requires Index (routeId ASC, sequence ASC)
    const q = query(collection(db, "route_outlets"), where("routeId", "==", routeId), orderBy("sequence", "asc"));
    
    try {
        const snap = await getDocs(q);
        list.innerHTML = "";
        
        if(snap.empty) { 
            list.innerHTML = "<li style='padding:15px;'>No shops in this route.</li>"; 
            return; 
        }

        // Iterate through route_outlets
        for (const docSnap of snap.docs) {
            const routeOutletData = docSnap.data();
            
            // Fetch the actual Outlet Document to get Coordinates (Lat/Lng)
            const outletDocRef = doc(db, "outlets", routeOutletData.outletId);
            const outletDoc = await getDoc(outletDocRef);
            
            if(!outletDoc.exists()) continue; // Skip if outlet was deleted
            
            const outletData = outletDoc.data();
            const shopLat = outletData.geo ? outletData.geo.lat : 0;
            const shopLng = outletData.geo ? outletData.geo.lng : 0;

            const li = document.createElement('li');
            li.style.cssText = "background:white; margin:10px 0; padding:15px; border-radius:8px; border:1px solid #ddd; display:flex; justify-content:space-between; align-items:center;";
            
            // --- UPDATED HTML STRUCTURE FOR TWO BUTTONS ---
            li.innerHTML = `
                <div>
                    <strong style="font-size:1.1rem;">${routeOutletData.outletName}</strong><br>
                    <small>Seq: ${routeOutletData.sequence}</small>
                </div>
                <div style="display:flex; gap:10px;">
                    <!-- Phone Order Button -->
                    <button class="btn-phone-order" style="background:#ffc107; color:black; border:none; padding:8px 12px; border-radius:5px; cursor:pointer;" title="Take Phone Order">
                        📞
                    </button>
                    
                    <!-- Map/Visit Button -->
                    <button class="btn-open-map" style="background:#007bff; color:white; border:none; padding:8px 15px; border-radius:5px; cursor:pointer;">
                        Open 🗺️
                    </button>
                </div>
            `;
            
            // --- 1. ATTACH PHONE ORDER LISTENER ---
            li.querySelector('.btn-phone-order').onclick = () => {
                // Ensure openOrderForm is defined (from the previous step)
                if (window.openOrderForm) {
                    window.openOrderForm(routeOutletData.outletId, routeOutletData.outletName);
                } else {
                    alert("Order system not loaded yet.");
                }
            };

            // --- 2. ATTACH MAP LISTENER ---
            li.querySelector('.btn-open-map').onclick = () => {
                if(shopLat === 0 && shopLng === 0) {
                    alert("This outlet has no GPS coordinates set by Admin.");
                } else {
                    openVisitPanel(routeOutletData.outletId, routeOutletData.outletName, shopLat, shopLng);
                }
            };

            list.appendChild(li);
        }

    } catch (error) {
        console.error("Load Shops Error:", error);
        if (error.message.includes("index")) {
            list.innerHTML = `<li style="color:red; font-weight:bold;">⚠️ Database Index Missing (Check Console)</li>`;
        }
    }
}







// --- ROUTE MAP LOGIC ---

let routeMapInstance = null; // Separate variable to avoid conflict with visit map

async function loadRouteOnMap() {
    console.log("Loading Route Map...");
    
    // 1. Initialize Map (Leaflet)
    // We check if it exists to avoid "Map container is already initialized" error
    if (routeMapInstance) {
        routeMapInstance.remove();
    }
    
    // Default center (will change later)
    routeMapInstance = L.map('routeMap').setView([20.5937, 78.9629], 5); 

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(routeMapInstance);

    // 2. Get Current User ID
    const uid = auth.currentUser.uid;
    const markers = []; // To store marker objects for auto-zooming

    try {
        // 3. Fetch Assigned Route
        const routeQ = query(collection(db, "routes"), where("assignedSalesmanId", "==", uid));
        const routeSnap = await getDocs(routeQ);

        if (routeSnap.empty) {
            alert("No route assigned to you.");
            return;
        }

        const routeId = routeSnap.docs[0].id;

        // 4. Fetch Route Outlets (Sequence)
        const roQ = query(collection(db, "route_outlets"), where("routeId", "==", routeId));
        const roSnap = await getDocs(roQ);

        if (roSnap.empty) return;

        // 5. Loop through assigned outlets and fetch their REAL GPS data
        // We use Promise.all to fetch all outlets in parallel (Faster than await in loop)
        const outletPromises = roSnap.docs.map(async (docSnap) => {
            const linkData = docSnap.data();
            const outletDoc = await getDoc(doc(db, "outlets", linkData.outletId));
            
            if (outletDoc.exists()) {
                const outData = outletDoc.data();
                if (outData.geo && outData.geo.lat && outData.geo.lng) {
                    return {
                        name: outData.shopName,
                        lat: outData.geo.lat,
                        lng: outData.geo.lng,
                        seq: linkData.sequence
                    };
                }
            }
            return null; // Skip if no geo or deleted
        });

        const validOutlets = (await Promise.all(outletPromises)).filter(o => o !== null);

        // 6. Plot Markers
        validOutlets.forEach(shop => {
            const marker = L.marker([shop.lat, shop.lng])
                .addTo(routeMapInstance)
                .bindPopup(`<b>${shop.seq}. ${shop.name}</b>`);
            
            markers.push(marker);
        });

        // 7. Auto-Fit Map to show all markers
        if (markers.length > 0) {
            const group = new L.featureGroup(markers);
            routeMapInstance.fitBounds(group.getBounds().pad(0.1)); // pad(0.1) adds a little breathing room
        }

    } catch (error) {
        console.error("Map Load Error:", error);
        alert("Error loading map data.");
    }
}









// --- 4. VISIT PANEL & MAP LOGIC ---

window.openVisitPanel = async function(outletId, name, shopLat, shopLng) {

    // ── Switch Views ─────────────────────────────
    document.getElementById('route-view').style.display = 'none';
    document.getElementById('visit-view').style.display = 'block';

    document.getElementById('visit-shop-name').innerText = name;
    document.getElementById('dist-display').innerText = "Locating...";

    // ── Reset Controls ───────────────────────────
    const geoBtn = document.getElementById('btn-geo-checkin');
    geoBtn.style.display = 'block';
    geoBtn.disabled = true;
    geoBtn.innerText = "Waiting for GPS...";
    document.getElementById('in-shop-controls').style.display = 'none';

    // ── NEW: Fetch Outstanding Balance ───────────
    const balEl = document.getElementById('visit-outstanding-bal');
    balEl.innerText = "Loading...";

    try {
        const docSnap = await getDoc(doc(db, "outlets", outletId));
        if (docSnap.exists()) {
            const bal = docSnap.data().currentBalance || 0;
            balEl.innerText = "₹" + bal.toFixed(2);

            // Save outlet info for payment modal
            const payEl = document.getElementById('pay-outlet-name');
            payEl.dataset.id = outletId;
            payEl.innerText = name;
        } else {
            balEl.innerText = "₹0.00";
        }
    } catch (e) {
        console.error("Balance fetch failed:", e);
        balEl.innerText = "Error";
    }

    // ── Initialize Map ───────────────────────────
    if (map) map.remove(); // Destroy previous instance

    map = L.map('map').setView([shopLat, shopLng], 18);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(map);

    // ── Shop Marker ──────────────────────────────
    shopMarker = L.marker([shopLat, shopLng])
        .addTo(map)
        .bindPopup(`<b>${name}</b><br>Target Location`)
        .openPopup();

    // ── User Marker ──────────────────────────────
    userMarker = L.circleMarker([0, 0], {
        radius: 8,
        color: 'blue',
        fillOpacity: 0.8
    }).addTo(map);

    // ── Start Geo-Fencing ─────────────────────────
    startGeoFencing(shopLat, shopLng, outletId, name);
};


window.closeVisitPanel = function() {
    if(watchId) navigator.geolocation.clearWatch(watchId);
    document.getElementById('route-view').style.display = 'block';
    document.getElementById('visit-view').style.display = 'none';
};

function startGeoFencing(targetLat, targetLng, outletId, outletName) {
    const checkInBtn = document.getElementById('btn-geo-checkin');
    const distDisplay = document.getElementById('dist-display');

    if(!navigator.geolocation) { alert("GPS not supported on this device."); return; }

    watchId = navigator.geolocation.watchPosition((pos) => {
        const userLat = pos.coords.latitude;
        const userLng = pos.coords.longitude;
        const accuracy = pos.coords.accuracy;

        // Update Map Marker
        userMarker.setLatLng([userLat, userLng]);
        
        // Calculate Distance
        const distMeters = getDistanceFromLatLonInM(userLat, userLng, targetLat, targetLng);
        distDisplay.innerText = `${Math.round(distMeters)}m (GPS Acc: ±${Math.round(accuracy)}m)`;

        // GEO-FENCE CHECK
        if (distMeters <= GEO_FENCE_RADIUS) {
            checkInBtn.disabled = false;
            checkInBtn.innerText = `📍 Check In Now (${Math.round(distMeters)}m)`;
            checkInBtn.style.background = "#28a745"; // Green
            checkInBtn.onclick = () => performVisitCheckIn(outletId, outletName, userLat, userLng);
        } else {
            checkInBtn.disabled = true;
            checkInBtn.innerText = `Move Closer (${Math.round(distMeters)}m)`;
            checkInBtn.style.background = "#6c757d"; // Grey
        }

    }, (err) => {
        console.error("GPS Watch Error:", err);
        distDisplay.innerText = "GPS Signal Lost";
    }, { 
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 5000 
    });
}


// --- 5. VISIT ACTIONS (CHECK-IN / END) ---

async function performVisitCheckIn(outletId, outletName, lat, lng) {
    const btn = document.getElementById('btn-geo-checkin');
    const controls = document.getElementById('in-shop-controls');
    
    try {
        btn.innerText = "Signing in...";
        
        // Save Visit to Firestore
        const docRef = await addDoc(collection(db, "visits"), {
            salesmanId: auth.currentUser.uid,
            outletId: outletId,
            outletName: outletName,
            checkInTime: Timestamp.now(),
            location: new GeoPoint(lat, lng),
            status: "in-progress"
        });

        currentVisitId = docRef.id;
        visitStartTime = new Date();

        // Update UI
        btn.style.display = 'none';
        controls.style.display = 'block';
        
        startTimer();

        // Bind Button Actions
        document.getElementById('btn-take-order').onclick = () => {
    // Pass outlet ID and Name from the current visit context
    openOrderForm(outletId, outletName);
};
        document.getElementById('btn-end-visit').onclick = () => performEndVisit();

    } catch (error) {
        console.error("Visit Start Error:", error);
        alert("Check-in failed: " + error.message);
    }
}

async function performEndVisit() {
    if(!confirm("Are you done with this shop?")) return;
    
    try {
        const endTime = new Date();
        const duration = Math.round((endTime - visitStartTime) / 1000 / 60); // Minutes

        await updateDoc(doc(db, "visits", currentVisitId), {
            checkOutTime: Timestamp.now(),
            status: "completed",
            durationMinutes: duration
        });

        stopTimer();
        alert(`Visit Ended. Duration: ${duration} mins.`);
        closeVisitPanel();

    } catch (error) {
        console.error("End Visit Error:", error);
        alert("Error ending visit.");
    }
}


// --- 6. DAILY ATTENDANCE (Dashboard Top) ---

function getTodayDateString() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, '0') + "-" + String(d.getDate()).padStart(2, '0');
}

async function checkTodayAttendance(user) {
    const statusEl = document.getElementById('attendance-status');
    const btn = document.getElementById('checkInBtn');
    if(!statusEl) return;

    try {
        const todayStr = getTodayDateString();
        const q = query(collection(db, "attendance"), where("salesmanId", "==", user.uid), where("date", "==", todayStr));
        const snap = await getDocs(q);

        if (!snap.empty) {
            const data = snap.docs[0].data();
            const time = data.checkInTime.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            statusEl.innerHTML = `✅ Checked in at <b>${time}</b>`;
            statusEl.style.color = "green";
            if(btn) { btn.innerText = "Attendance Marked"; btn.disabled = true; }
        } else {
            statusEl.innerText = "You haven't checked in today.";
            if(btn) btn.disabled = false;
        }
    } catch (e) { 
        console.error("Attendance Check Error:", e);
        if(e.message.includes("index")) console.warn("Attendance Index Missing");
    }
}

function handleDailyAttendance(user) {
    const btn = document.getElementById('checkInBtn');
    if (!navigator.geolocation) return alert("No GPS available");
    
    btn.innerText = "Locating...";
    
    navigator.geolocation.getCurrentPosition(async (pos) => {
        try {
            await addDoc(collection(db, "attendance"), {
                salesmanId: user.uid,
                salesmanEmail: user.email,
                date: getTodayDateString(),
                checkInTime: Timestamp.now(),
                location: new GeoPoint(pos.coords.latitude, pos.coords.longitude)
            });
            alert("Daily Attendance Marked!");
            checkTodayAttendance(user);
        } catch (e) { 
            alert("Error: " + e.message); 
            btn.innerText = "Check In Now"; 
        }
    });
}

// --- 7. MATH UTILS ---

function startTimer() {
    const el = document.getElementById('visit-timer');
    if(!el) return;
    timerInterval = setInterval(() => {
        const now = new Date();
        const diff = Math.floor((now - visitStartTime) / 1000); 
        const mins = String(Math.floor(diff / 60)).padStart(2, '0');
        const secs = String(diff % 60).padStart(2, '0');
        el.innerText = `${mins}:${secs}`;
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval);
}

// Haversine Formula for Distance
function getDistanceFromLatLonInM(lat1, lon1, lat2, lon2) {
  var R = 6371; 
  var dLat = deg2rad(lat2-lat1); 
  var dLon = deg2rad(lon2-lon1); 
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2); 
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  var d = R * c; 
  return d * 1000; // Meters
}

function deg2rad(deg) {
  return deg * (Math.PI/180)
}





window.switchView = function(viewName) {
    // 1. Hide all views
    document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));

    // 2. Show selected view
    if (viewName === 'route') document.getElementById('route-view').classList.remove('hidden');
    if (viewName === 'visit') document.getElementById('visit-view').classList.remove('hidden');
    if (viewName === 'catalog') {
        document.getElementById('catalog-view').classList.remove('hidden');
        if(window.loadProductCatalog) window.loadProductCatalog();
    }
    if (viewName === 'map') {
        document.getElementById('map-view').classList.remove('hidden');
        loadRouteOnMap(); // <--- New Function we will write below
    }

    // 3. Update Bottom Nav Styles
    document.querySelectorAll('.bottom-nav-item').forEach(el => {
        el.classList.remove('active', 'text-blue-600'); 
        el.classList.add('text-gray-400');
    });

    const activeBtn = document.getElementById('nav-' + viewName);
    if(activeBtn) {
        activeBtn.classList.add('active', 'text-blue-600');
        activeBtn.classList.remove('text-gray-400');
    }
};






// ==========================================
//      PRODUCT CATALOG LOGIC
// ==========================================

let allProducts = []; // Cache for search

async function loadProductCatalog() {
    const list = document.getElementById('catalog-list');
    list.innerHTML = '<p>Loading products...</p>';

    try {
        const q = query(collection(db, "products"), orderBy("name"));
        const snap = await getDocs(q);

        allProducts = []; // Clear cache
        list.innerHTML = "";

        if (snap.empty) {
            list.innerHTML = "<p>No products available.</p>";
            return;
        }

        snap.forEach(doc => {
            const d = doc.data();
            allProducts.push(d); // Store for search
            list.innerHTML += createProductCard(d);
        });

        // Attach Search Listener
        document.getElementById('searchProd').addEventListener('keyup', filterProducts);

    } catch (error) {
        console.error("Catalog Error:", error);
        list.innerHTML = "<p>Error loading catalog.</p>";
    }
}

function createProductCard(d) {
    return `
        <div style="border:1px solid #eee; padding:10px; border-radius:8px; text-align:center; background:#fff;">
            <div style="font-weight:bold; font-size:1rem;">${d.name}</div>
            <div style="color:#666; font-size:0.8rem;">${d.category}</div>
            <div style="color:#28a745; font-weight:bold; margin-top:5px;">₹${d.price}</div>
        </div>
    `;
}

function filterProducts(e) {
    const term = e.target.value.toLowerCase();
    const list = document.getElementById('catalog-list');
    list.innerHTML = "";

    const filtered = allProducts.filter(p => 
        p.name.toLowerCase().includes(term) || 
        p.category.toLowerCase().includes(term)
    );

    if(filtered.length === 0) {
        list.innerHTML = "<p>No matches found.</p>";
    } else {
        filtered.forEach(p => {
            list.innerHTML += createProductCard(p);
        });
    }
}






// ==========================================
//      ORDER TAKING LOGIC (UPDATED)
// ==========================================

// 1. OPEN ORDER FORM
window.openOrderForm = async function(outletId, outletName) {
    // A. Fetch Outlet Status First (Security Check)
    try {
        const docSnap = await getDoc(doc(db, "outlets", outletId));
        if (!docSnap.exists()) return alert("Outlet not found.");
        
        const data = docSnap.data();
        if (data.status === 'blocked') {
            alert("⛔ This outlet is BLOCKED. You cannot take orders.");
            return;
        }
        currentOrderOutlet = { id: outletId, name: outletName, data: data };

    } catch (e) {
        console.error(e);
        alert("Error verifying outlet.");
        return;
    }

    // B. Switch UI
    document.getElementById('visit-view').style.display = 'none';
    document.getElementById('order-view').style.display = 'block';
    
    document.getElementById('order-outlet-name').innerText = outletName;
    
    // Reset Form & Settings
    orderCart = [];
    document.getElementById('isPhoneOrder').checked = false; // Default: Physical Visit
    document.getElementById('applyGst').checked = false;     // Default: No Tax
    
    renderCart();
    populateProductDropdown();
    
    // Attach Listeners for Toggles to Re-calculate Totals
    document.getElementById('applyGst').onchange = renderCart;
};

window.cancelOrder = function() {
    if(orderCart.length > 0 && !confirm("Discard current order?")) return;
    document.getElementById('order-view').style.display = 'none';
    
    // Return to previous view
    if(currentVisitId) {
        document.getElementById('visit-view').style.display = 'block';
    } else {
        document.getElementById('route-view').style.display = 'block';
    }
};

// 2. POPULATE DROPDOWN
async function populateProductDropdown() {
    const select = document.getElementById('order-product-select');
    if(select.options.length > 1) return; 

    try {
        const q = query(collection(db, "products"), orderBy("name")); 
        const snap = await getDocs(q);

        select.innerHTML = '<option value="">Select Product...</option>';
        snap.forEach(doc => {
            const p = doc.data();
            const opt = document.createElement('option');
            opt.value = doc.id;
            opt.textContent = `${p.name} (₹${p.price})`;
            opt.dataset.price = p.price;
            opt.dataset.name = p.name;
            select.appendChild(opt);
        });
    } catch (e) { console.error("Prod Load Error:", e); }
}

// 3. ADD TO CART
window.addToCart = function() {
    const select = document.getElementById('order-product-select');
    const qtyInput = document.getElementById('order-qty');
    const qty = parseInt(qtyInput.value);

    if (!select.value || !qty || qty <= 0) {
        alert("Please select a product and valid quantity.");
        return;
    }

    const productId = select.value;
    const price = parseFloat(select.options[select.selectedIndex].dataset.price);
    const name = select.options[select.selectedIndex].dataset.name;

    const existing = orderCart.find(item => item.productId === productId);
    if (existing) {
        existing.qty += qty;
        existing.lineTotal = existing.qty * existing.price;
    } else {
        orderCart.push({
            productId: productId,
            name: name,
            price: price,
            qty: qty,
            lineTotal: qty * price
        });
    }

    qtyInput.value = ""; 
    renderCart();
};

// 4. RENDER CART & CALCULATE TOTALS (GST INDEPENDENT)
function renderCart() {
    const tbody = document.getElementById('order-cart-body');
    const applyTax = document.getElementById('applyGst').checked; // Check GST Toggle
    
    tbody.innerHTML = "";
    let subtotal = 0;

    orderCart.forEach((item, index) => {
        subtotal += item.lineTotal;
        tbody.innerHTML += `
            <tr style="border-bottom:1px solid #eee;">
                <td style="padding:5px;">${item.name}<br><small>@ ₹${item.price}</small></td>
                <td style="text-align:center;">${item.qty}</td>
                <td style="text-align:right;">₹${item.lineTotal.toFixed(2)}</td>
                <td style="text-align:center; cursor:pointer;" onclick="removeFromCart(${index})">❌</td>
            </tr>
        `;
    });

    // GST Calculation based ONLY on checkbox
    let gstAmount = 0;
    if (applyTax) {
        gstAmount = subtotal * 0.05; // 5% GST
        document.getElementById('tax-row').style.display = 'block';
    } else {
        document.getElementById('tax-row').style.display = 'none';
    }

    const grandTotal = subtotal + gstAmount;

    document.getElementById('ord-subtotal').innerText = "₹" + subtotal.toFixed(2);
    document.getElementById('ord-tax').innerText = "₹" + gstAmount.toFixed(2);
    document.getElementById('ord-grand-total').innerText = "₹" + grandTotal.toFixed(2);
}

window.removeFromCart = function(index) {
    orderCart.splice(index, 1);
    renderCart();
};

// 5. SUBMIT ORDER
// js/salesman.js - Updated submitOrder

window.submitOrder = async function() {
    const isPhone = document.getElementById('isPhoneOrder').checked;
    const applyTax = document.getElementById('applyGst').checked;
    const btn = document.getElementById('btn-submit-order');

    // Validation
    if (orderCart.length === 0) return alert("Cart is empty!");
    if (!isPhone && !currentVisitId) {
        alert("❌ Geo-Fence Error: You must be Checked-In.");
        return;
    }

    if (!confirm("Confirm Order Submission?")) return;

    btn.disabled = true;
    btn.innerText = "Processing...";

    try {
        // 1. Calculate Financials
        const subtotal = orderCart.reduce((sum, item) => sum + item.lineTotal, 0);
        const tax = applyTax ? (subtotal * 0.05) : 0;
        const total = subtotal + tax;

        // 2. Prepare Order Data
        const orderData = {
            salesmanId: auth.currentUser.uid,
            outletId: currentOrderOutlet.id,
            outletName: currentOrderOutlet.name,
            visitId: isPhone ? null : currentVisitId,
            orderDate: Timestamp.now(),
            orderType: isPhone ? "Phone Call" : "Physical Visit",
            isGstApplied: applyTax,
            items: orderCart,
            financials: {
                subtotal: subtotal,
                tax: tax,
                totalAmount: total
            },
            status: "pending"
        };

        // 3. Save to 'orders' Collection
        await addDoc(collection(db, "orders"), orderData);

        // 4. CRITICAL: Update Outlet Balance (Credit in Market)
        // This adds the order amount to the shop's current debt
        const outletRef = doc(db, "outlets", currentOrderOutlet.id);
        await updateDoc(outletRef, {
            currentBalance: increment(total),
            lastOrderDate: Timestamp.now()
        });

        alert("✅ Order Placed Successfully!");
        
        // 5. Cleanup UI
        document.getElementById('order-view').style.display = 'none';
        
        if(currentVisitId) {
            document.getElementById('visit-view').style.display = 'block';
        } else {
            document.getElementById('route-view').style.display = 'block';
        }

    } catch (error) {
        console.error("Order Error:", error);
        alert("Failed to submit order: " + error.message);
    } finally {
        btn.disabled = false;
        btn.innerText = "Confirm Order";
    }
};




window.openPaymentModal = function() {
    document.getElementById('paymentModal').style.display = 'flex';
    document.getElementById('payAmount').value = "";
};

window.submitPayment = async function() {
    const outletId = document.getElementById('pay-outlet-name').dataset.id;
    const outletName = document.getElementById('pay-outlet-name').innerText;
    const amount = parseFloat(document.getElementById('payAmount').value);
    const method = document.getElementById('payMethod').value;
    const modal = document.getElementById('paymentModal');

    if(!amount || amount <= 0) return alert("Enter valid amount");

    // 1. Close Modal immediately
    modal.style.display = 'none';

    try {
        // 2. Add 'Pending' Payment
        await addDoc(collection(db, "payments"), {
            salesmanId: auth.currentUser.uid,
            outletId: outletId,
            outletName: outletName,
            amount: amount,
            method: method,
            date: Timestamp.now(),
            status: "pending" // Critical: Admin must approve
        });

        alert("Payment Recorded! Waiting for Admin Approval.");

    } catch (error) {
        console.error("Payment Error:", error);
        alert("Failed to record payment: " + error.message);
        modal.style.display = 'flex'; // Reopen on error
    }
};





// ==========================================
//      LEAVE REQUEST LOGIC
// ==========================================

window.openLeaveModal = function() {
    document.getElementById('leaveModal').style.display = 'flex';
    // Set default date to tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    document.getElementById('leaveDate').valueAsDate = tomorrow;
};

window.submitLeaveRequest = async function() {
    const date = document.getElementById('leaveDate').value;
    const type = document.getElementById('leaveType').value;
    const reason = document.getElementById('leaveReason').value.trim();
    const btn = document.querySelector('#leaveModal button[onclick="submitLeaveRequest()"]');

    if(!date || !reason) return alert("Please select date and provide a reason.");

    btn.disabled = true;
    btn.innerText = "Sending...";

    try {
        await addDoc(collection(db, "leaves"), {
            salesmanId: auth.currentUser.uid,
            salesmanEmail: auth.currentUser.email, // Store email/name for display
            date: date, // Format YYYY-MM-DD
            type: type,
            reason: reason,
            status: "pending",
            createdAt: Timestamp.now()
        });

        alert("Request Sent! Waiting for Admin approval.");
        document.getElementById('leaveModal').style.display = 'none';
        document.getElementById('leaveReason').value = ""; // Reset

    } catch (error) {
        console.error("Leave Error:", error);
        alert("Failed to send request: " + error.message);
    } finally {
        btn.disabled = false;
        btn.innerText = "Submit";
    }
};











// --- DAILY TARGET SYSTEM (FIXED) ---

async function loadDailyTarget() {
    const card = document.getElementById('target-card');
    const uid = auth.currentUser.uid;

    // 1. FIX: Generate Local Date String (YYYY-MM-DD) manually to match Admin Input
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;

    console.log("Looking for Target ID:", `${uid}_${todayStr}`); // Debugging

    try {
        // 2. Fetch Target Document
        const targetId = `${uid}_${todayStr}`;
        const targetSnap = await getDoc(doc(db, "daily_targets", targetId));

        if (!targetSnap.exists()) {
            console.log("No target found for today.");
            card.style.display = 'none';
            return;
        }

        const targetData = targetSnap.data();
        const targetBoxes = Number(targetData.targetBoxes) || 0;
        const incentiveRate = Number(targetData.incentivePerBox) || 0;

        card.classList.remove('hidden'); // Show card
        card.style.display = 'block';    // Force display

        // 3. Calculate Actual Sales
        const startOfDay = new Date();
        startOfDay.setHours(0,0,0,0);
        
        const endOfDay = new Date();
        endOfDay.setHours(23,59,59,999);

        const q = query(
            collection(db, "orders"), 
            where("salesmanId", "==", uid),
            where("orderDate", ">=", Timestamp.fromDate(startOfDay)),
            where("orderDate", "<=", Timestamp.fromDate(endOfDay))
        );

        const orderSnaps = await getDocs(q);
        
        let totalBoxesSold = 0;
        
        orderSnaps.forEach(doc => {
            const order = doc.data();
            // Count items only if status is NOT rejected (optional, based on your rule)
            if(order.items && Array.isArray(order.items)) {
                order.items.forEach(item => {
                    totalBoxesSold += (Number(item.qty) || 0);
                });
            }
        });

        console.log(`Target: ${targetBoxes}, Sold: ${totalBoxesSold}`);

        // 4. Update UI
        const progress = targetBoxes > 0 ? Math.min((totalBoxesSold / targetBoxes) * 100, 100) : 0;
        const remaining = Math.max(0, targetBoxes - totalBoxesSold);
        
        // Incentive: Only for boxes ABOVE target
        const extraBoxes = Math.max(0, totalBoxesSold - targetBoxes);
        const incentiveEarned = extraBoxes * incentiveRate;

        document.getElementById('tgt-total').innerText = targetBoxes;
        document.getElementById('tgt-max').innerText = targetBoxes;
        document.getElementById('tgt-achieved').innerText = totalBoxesSold;
        document.getElementById('tgt-left').innerText = remaining;
        document.getElementById('tgt-bar').style.width = `${progress}%`;
        document.getElementById('tgt-rate').innerText = incentiveRate;
        document.getElementById('tgt-incentive-amt').innerText = `₹${incentiveEarned.toFixed(2)}`;

        // Message Logic
        const msgRemaining = document.getElementById('msg-remaining');
        const msgAlmost = document.getElementById('msg-almost');
        const msgSuccess = document.getElementById('msg-success');
        const bar = document.getElementById('tgt-bar');

        msgRemaining.classList.add('hidden');
        msgAlmost.classList.add('hidden');
        msgSuccess.classList.add('hidden');
        bar.className = "h-3 rounded-full transition-all duration-1000 ease-out"; // Reset colors

        if (totalBoxesSold >= targetBoxes && targetBoxes > 0) {
            msgSuccess.classList.remove('hidden');
            bar.classList.add('bg-green-500');
        } else if (progress >= 80) {
            msgAlmost.classList.remove('hidden');
            bar.classList.add('bg-amber-500');
        } else {
            msgRemaining.classList.remove('hidden');
            bar.classList.add('bg-blue-600');
        }

    } catch (error) {
        console.error("Target Load Error:", error);
        // CRITICAL: Check console if index is missing
        if(error.message.includes("index")) {
            alert("⚠️ Admin needs to create a Database Index. Check Console.");
        }
    }
}






// ==========================================
//      ADD NEW SHOP LOGIC (UPDATED)
// ==========================================

function openAddShopModal() {
    document.getElementById('addShopModal').classList.remove('hidden');
    document.getElementById('newShopForm').reset();
    document.getElementById('newShopGeoMsg').innerText = "Required to save";
    document.getElementById('newShopGeoMsg').className = "text-[10px] text-indigo-400";
    toggleCreditFields(); // Ensure correct initial state
}

// Toggle Credit Fields Visibility
window.toggleCreditFields = function() {
    const type = document.getElementById('newStoreType').value;
    const fields = document.getElementById('creditFields');
    if(type === 'Credit') {
        fields.classList.remove('hidden');
        document.getElementById('newCreditDays').required = true;
        document.getElementById('newCreditLimit').required = true;
    } else {
        fields.classList.add('hidden');
        document.getElementById('newCreditDays').required = false;
        document.getElementById('newCreditLimit').required = false;
        document.getElementById('newCreditDays').value = "";
        document.getElementById('newCreditLimit').value = "";
    }
};

async function submitNewShop() {
    const btn = document.getElementById('btnSaveShop');
    
    // 1. Gather Basic Data
    const name = document.getElementById('newShopName').value.trim();
    const owner = document.getElementById('newOwnerName').value.trim();
    const phone = document.getElementById('newShopPhone').value.trim();
    
    // 2. Gather Extended Data
    const authName = document.getElementById('newAuthName').value.trim() || owner; // Default to owner if empty
    const authPhone = document.getElementById('newAuthPhone').value.trim() || phone;
    const address = document.getElementById('newShopAddress').value.trim();
    const gst = document.getElementById('newShopGST').value.trim() || "N/A";
    
    // 3. Gather Types & Credit
    const catType = document.getElementById('newShopType').value;
    const storeType = document.getElementById('newStoreType').value;
    const creditDays = storeType === 'Credit' ? Number(document.getElementById('newCreditDays').value) : 0;
    const creditLimit = storeType === 'Credit' ? Number(document.getElementById('newCreditLimit').value) : 0;

    // 4. Gather GPS
    const lat = document.getElementById('newShopLat').value;
    const lng = document.getElementById('newShopLng').value;

    if(!lat || !lng) {
        alert("⚠️ GPS Location is required. Please click 'Capture'.");
        return;
    }

    try {
        btn.disabled = true;
        btn.innerText = "Saving...";

        // 5. Construct Data Object (Matching Admin Schema)
        const shopData = {
            shopName: name,
            ownerName: owner,
            contactPhone: phone,
            
            // Extended Fields
            contactPerson: authName, // Admin calls this 'contactPerson'
            authPhone: authPhone,    // Extra field
            address: address,
            gstNumber: gst,
            
            outletType: catType,     // e.g. Restaurant, Shop
            storeType: storeType,    // Cash vs Credit
            creditDays: creditDays,
            creditLimit: creditLimit,
            
            currentBalance: 0,       // New shops start with 0 debt
            
            geo: { lat: parseFloat(lat), lng: parseFloat(lng) },
            
            createdBySalesman: auth.currentUser.uid,
            createdAt: serverTimestamp(),
            status: 'active'         // Default active
        };

        // 6. Save to Firestore
        await addDoc(collection(db, "outlets"), shopData);

        alert("✅ Shop Added Successfully!");
        document.getElementById('addShopModal').classList.add('hidden');

    } catch (e) {
        console.error("Add Shop Error:", e);
        alert("Error saving shop: " + e.message); // If this still says permission denied, check Part 1
    } finally {
        btn.disabled = false;
        btn.innerText = "Save Shop";
    }
}

// EXPOSE FUNCTIONS
window.openAddShopModal = openAddShopModal;
window.captureNewShopLocation = captureNewShopLocation;
window.submitNewShop = submitNewShop;
