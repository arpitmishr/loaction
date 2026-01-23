// 1. IMPORTS
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, query, where, getDocs, orderBy, addDoc, updateDoc, Timestamp, GeoPoint, increment 
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
let fullMapInstance = null;

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
        loadDailyTarget(user.uid); 

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
            list.innerHTML = "<li style='padding:15px; text-align:center;'>No shops in this route.</li>"; 
            return; 
        }

        // Iterate through route_outlets
        for (const docSnap of snap.docs) {
            const routeOutletData = docSnap.data();
            
            // Fetch the actual Outlet Document to get Coordinates (Lat/Lng)
            const outletDocRef = doc(db, "outlets", routeOutletData.outletId);
            const outletDoc = await getDoc(outletDocRef);
            
            if(!outletDoc.exists()) continue; 
            
            const outletData = outletDoc.data();
            const shopLat = outletData.geo ? outletData.geo.lat : 0;
            const shopLng = outletData.geo ? outletData.geo.lng : 0;

            const li = document.createElement('li');
            // Clean modern styling for the list item
            li.className = "bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex items-center justify-between gap-3";
            
            li.innerHTML = `
                <div class="flex-grow">
                    <h4 class="font-bold text-slate-800 text-base">${routeOutletData.outletName}</h4>
                    <p class="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Stop ${routeOutletData.sequence}</p>
                </div>
                <div class="flex gap-2">
                    <!-- NEW: Direct Payment Button (Green) -->
                    <button class="btn-collect-direct bg-emerald-50 text-emerald-600 p-2 rounded-xl border border-emerald-100 active:scale-95 transition-transform" title="Collect Payment">
                        <span class="material-icons-round text-lg">payments</span>
                    </button>
                    
                    <!-- Phone Order Button (Yellow) -->
                    <button class="btn-phone-order bg-amber-50 text-amber-600 p-2 rounded-xl border border-amber-100 active:scale-95 transition-transform" title="Phone Order">
                        <span class="material-icons-round text-lg">phone_callback</span>
                    </button>
                    
                    <!-- Visit/Map Button (Blue) -->
                    <button class="btn-open-map bg-blue-50 text-blue-600 p-2 rounded-xl border border-blue-100 active:scale-95 transition-transform">
                        <span class="material-icons-round text-lg">directions</span>
                    </button>
                </div>
            `;
            
            // 1. ATTACH PAYMENT LISTENER
            li.querySelector('.btn-collect-direct').onclick = () => {
                const payEl = document.getElementById('pay-outlet-name');
                payEl.dataset.id = routeOutletData.outletId;
                payEl.innerText = routeOutletData.outletName;
                window.openPaymentModal();
            };

            // 2. ATTACH PHONE ORDER LISTENER
            li.querySelector('.btn-phone-order').onclick = () => {
                if (window.openOrderForm) {
                    window.openOrderForm(routeOutletData.outletId, routeOutletData.outletName);
                }
            };

            // 3. ATTACH MAP LISTENER
            li.querySelector('.btn-open-map').onclick = () => {
                if(shopLat === 0 && shopLng === 0) {
                    alert("This outlet has no GPS coordinates set.");
                } else {
                    openVisitPanel(routeOutletData.outletId, routeOutletData.outletName, shopLat, shopLng);
                }
            };

            list.appendChild(li);
        }

    } catch (error) {
        console.error("Load Shops Error:", error);
        list.innerHTML = `<li class="p-4 text-red-500 text-center font-bold">Error loading shops. Check console.</li>`;
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
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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
    // Hide all
    document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
    
    // Show selected
    const target = document.getElementById(viewName + '-view');
    if (target) target.classList.remove('hidden');

    // Trigger map load
    if (viewName === 'full-map') {
        setTimeout(() => {
            window.initFullRouteMap();
        }, 100);
    }

    // Update Bottom Nav
    document.querySelectorAll('.bottom-nav-item').forEach(el => {
        el.classList.remove('active', 'text-blue-600');
        el.classList.add('text-gray-400');
    });
    const btn = document.getElementById('nav-' + viewName);
    if (btn) {
        btn.classList.add('active', 'text-blue-600');
        btn.classList.remove('text-gray-400');
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
    const btn = document.querySelector('#paymentModal button[onclick="submitPayment()"]');

    if(!amount || amount <= 0) return alert("Enter valid amount");

    // UI State
    btn.disabled = true;
    btn.innerHTML = `<span class="animate-spin mr-2">⏳</span> Capturing GPS...`;

    // FORCE GPS CAPTURE
    if (!navigator.geolocation) {
        alert("GPS not supported.");
        btn.disabled = false;
        btn.innerText = "Collect";
        return;
    }

    navigator.geolocation.getCurrentPosition(async (pos) => {
        try {
            await addDoc(collection(db, "payments"), {
                salesmanId: auth.currentUser.uid,
                outletId: outletId,
                outletName: outletName,
                amount: amount,
                method: method,
                date: Timestamp.now(),
                status: "pending",
                
                // NEW MANDATORY GPS FIELDS
                collectedWithoutVisit: currentVisitId ? false : true,
                gpsLat: pos.coords.latitude,
                gpsLng: pos.coords.longitude,
                gpsAccuracy: pos.coords.accuracy
            });

            alert("Payment recorded! GPS coordinates saved.");
            modal.classList.add('hidden'); // Close modal
            document.getElementById('payAmount').value = "";

        } catch (error) {
            console.error("Payment Submission Error:", error);
            alert("Error: " + error.message);
        } finally {
            btn.disabled = false;
            btn.innerText = "Collect";
        }
    }, (err) => {
        alert("GPS Error: You must allow location access to collect payment.");
        btn.disabled = false;
        btn.innerText = "Collect";
    }, { enableHighAccuracy: true, timeout: 8000 });
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








    // Make sure fullMapInstance is declared at the top of your file


window.initFullRouteMap = async function() {
    console.log("Initializing Map View...");
    const container = document.getElementById('all-shops-map');
    if (!container) return;

    // 1. Cleanup old instance to prevent "Map already initialized" error
    if (fullMapInstance) {
        fullMapInstance.remove();
        fullMapInstance = null;
    }

    // 2. Setup Leaflet Map
    fullMapInstance = L.map('all-shops-map', {
        zoomControl: false // Cleaner for mobile
    }).setView([20.5937, 78.9629], 5);

    // 3. Use Browser-Friendly Tiles
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '©OpenStreetMap',
        maxZoom: 18
    }).addTo(fullMapInstance);

    // 4. Force tile refresh after container is visible
    setTimeout(() => {
        fullMapInstance.invalidateSize();
    }, 400);

    try {
        // 5. FETCH DATA STEP A: Find the route assigned to this salesman
        const routeQuery = query(
            collection(db, "routes"), 
            where("assignedSalesmanId", "==", auth.currentUser.uid)
        );
        const routeSnap = await getDocs(routeQuery);

        if (routeSnap.empty) {
            console.warn("No route assigned to this user.");
            return;
        }

        const routeId = routeSnap.docs[0].id;

        // 6. FETCH DATA STEP B: Find all outlet stops for this route
        const stopsQuery = query(
            collection(db, "route_outlets"), 
            where("routeId", "==", routeId), 
            orderBy("sequence", "asc")
        );
        const stopsSnap = await getDocs(stopsQuery);

        const markers = [];

        // 7. FETCH DATA STEP C: Get details for each outlet and Plot
        for (const docSnap of stopsSnap.docs) {
            const routeStop = docSnap.data();
            const outletRef = doc(db, "outlets", routeStop.outletId);
            const outletDoc = await getDoc(outletRef);

            if (outletDoc.exists()) {
                const outletData = outletDoc.data();
                
                if (outletData.geo && outletData.geo.lat && outletData.geo.lng) {
                    const lat = outletData.geo.lat;
                    const lng = outletData.geo.lng;

                    // Create Marker
                    const marker = L.marker([lat, lng]).addTo(fullMapInstance);
                    
                    // Create Popup
                    marker.bindPopup(`
                        <div class="p-1">
                            <h4 class="font-bold text-blue-600">${outletData.shopName}</h4>
                            <p class="text-xs text-gray-500">Stop Sequence: ${routeStop.sequence}</p>
                            <p class="text-xs text-gray-500">Type: ${outletData.outletType}</p>
                            <button onclick="window.openVisitPanel('${outletDoc.id}', '${outletData.shopName}', ${lat}, ${lng})" 
                                    class="mt-2 w-full bg-blue-600 text-white text-[10px] py-1 rounded">
                                Visit Now
                            </button>
                        </div>
                    `);

                    markers.push([lat, lng]);
                }
            }
        }

        // 8. Auto-Zoom to fit all markers
        if (markers.length > 0) {
            const bounds = L.latLngBounds(markers);
            fullMapInstance.fitBounds(bounds, { padding: [50, 50] });
        }

    } catch (error) {
        console.error("Map Logic Error:", error);
    }
};






async function loadDailyTarget(uid) {
    const today = getTodayDateString();
    const card = document.getElementById('target-card');
    const msgBox = document.getElementById('target-message');
    const incentiveSection = document.getElementById('incentive-stats');
    const confetti = document.getElementById('target-confetti');
    
    if (!card) return;

    try {
        // 1. Fetch Target Data
        const targetQ = query(collection(db, "daily_targets"), 
            where("salesmanId", "==", uid), 
            where("date", "==", today)
        );
        const targetSnap = await getDocs(targetQ);

        if (targetSnap.empty) {
            card.classList.add('hidden');
            return;
        }

        const t = targetSnap.docs[0].data();
        const targetBoxes = Number(t.targetBoxes);
        const rate = Number(t.incentivePerBox);

        card.classList.remove('hidden');
        document.getElementById('total-target').innerText = targetBoxes;
        document.getElementById('target-incentive-rate').innerText = `₹${rate}/box bonus`;

        // 2. Calculate Achieved (Today's boxes)
        const ordersQ = query(collection(db, "orders"), where("salesmanId", "==", uid));
        const ordersSnap = await getDocs(ordersQ);
        
        let totalSold = 0;
        ordersSnap.forEach(docSnap => {
            const order = docSnap.data();
            if (order.orderDate && order.orderDate.toDate().toISOString().split('T')[0] === today) {
                order.items.forEach(item => totalSold += (Number(item.qty) || 0));
            }
        });

        // 3. UI Updates & Logic
        const progress = Math.min(Math.round((totalSold / targetBoxes) * 100), 100);
        document.getElementById('current-progress').innerText = totalSold;
        document.getElementById('percent-label').innerText = progress + "%";
        
        const progressBar = document.getElementById('target-progress-bar');
        progressBar.style.width = progress + "%";

        // Reset Styles
        msgBox.className = "text-xs font-bold p-3 rounded-xl text-center";
        incentiveSection.classList.add('hidden');
        confetti.classList.add('hidden');
        progressBar.classList.remove('bg-emerald-500', 'bg-amber-500');
        progressBar.classList.add('bg-blue-600');

        // Logic Rules
        if (totalSold >= targetBoxes) {
            // STATE: 100% or more
            const extraBoxes = totalSold - targetBoxes;
            const earned = extraBoxes * rate;

            progressBar.classList.replace('bg-blue-600', 'bg-emerald-500');
            msgBox.classList.add('bg-emerald-50', 'text-emerald-700');
            msgBox.innerHTML = `🎉 Target achieved! Incentive unlocked at ₹${rate} per box.`;
            confetti.classList.remove('hidden');

            // Show Incentive Stats
            if (extraBoxes > 0) {
                incentiveSection.classList.remove('hidden');
                document.getElementById('extra-boxes-label').innerText = `+${extraBoxes} extra boxes`;
                document.getElementById('total-earned-incentive').innerText = `₹${earned.toFixed(2)}`;
            }

        } else if (progress >= 80) {
            // STATE: 80% to 99%
            progressBar.classList.replace('bg-blue-600', 'bg-amber-500');
            msgBox.classList.add('bg-amber-50', 'text-amber-700', 'border', 'border-amber-100');
            msgBox.innerHTML = `✨ Almost there! Complete the target to unlock incentive.`;
        } else {
            // STATE: Below 80%
            msgBox.classList.add('bg-slate-50', 'text-slate-500');
            const remaining = targetBoxes - totalSold;
            msgBox.innerHTML = `Sell ${remaining} more boxes to reach your goal.`;
        }

    } catch (error) {
        console.error("Target logic error:", error);
    }
}
