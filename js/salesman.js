// 1. IMPORTS
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, query, where, getDocs, orderBy, addDoc, updateDoc, Timestamp, GeoPoint, increment, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";
import { appCache, getCachedUserProfile } from "./auth.js"; // <--- Add this import at the top
// --- GLOBAL VARIABLES ---
const content = document.getElementById('content');
const loader = document.getElementById('loader');

let map = null;
let userMarker = null;
let shopMarker = null;
let lastKnownLocation = null; 
let currentVisitId = null;
let visitStartTime = null;
let timerInterval = null;
let currentOrderOutlet = null; // Stores {id, name, status}
let orderCart = [];
let currentVisitTarget = null; 



// --- NAVIGATION GUARD (PREVENT BACK BUTTON) ---
window.addEventListener('popstate', (event) => {
    // If a visit is currently active (currentVisitId is not null)
    if (currentVisitId) {
        // Push the state back so the URL doesn't change
        history.pushState(null, null, window.location.href);
        alert("⚠️ Action Required\n\nYou cannot leave this screen while a visit is in progress.\n\nPlease click 'End Visit' to finish.");
    }
});







// --- CONFIGURATION ---
const GEO_FENCE_RADIUS = 50; // ✅ SET TO 50 METERS

console.log("Salesman Script Loaded");




















// --- HELPER: ON-DEMAND GPS FETCH ---
async function fetchCurrentGPS() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error("GPS not supported"));
            return;
        }
        
        console.log("🛰️ Requesting GPS...");
        
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                // Update Cache
                lastKnownLocation = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    timestamp: Date.now()
                };
                console.log("✅ GPS Cached:", lastKnownLocation);
                resolve(lastKnownLocation);
            },
            (err) => {
                console.error("GPS Error:", err);
                // Fallback to cache if recent (< 5 mins)
                if (lastKnownLocation && (Date.now() - lastKnownLocation.timestamp < 300000)) {
                    console.warn("⚠️ Using cached GPS due to error");
                    resolve(lastKnownLocation);
                } else {
                    reject(err);
                }
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 } // Force fresh
        );
    });
}















onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    try {
        // A. USE CACHED PROFILE
        const userData = await getCachedUserProfile(user.uid);
        
        // B. Check Salesman Role
        if (!userData || userData.role !== 'salesman') {
            alert("Access Denied: Salesman role required.");
            logoutUser();
            return;
        }

        // C. Initialize UI
        if (loader) loader.style.display = 'none';
        if (content) content.style.display = 'block';

        // D. Load Data
        checkTodayAttendance(user);
        loadAssignedRoute(user.uid);
        loadDailyTarget();

        // E. Attach Global Listener
        const checkInBtn = document.getElementById('checkInBtn');
        if(checkInBtn) {
            checkInBtn.addEventListener('click', () => handleDailyAttendance(user));
        }

    } catch (error) {
        console.error("Init Error:", error);
    }
});
// --- SAFE LOGOUT (Cleanup GPS) ---
document.getElementById('logoutBtn').addEventListener('click', () => {
    // Stop Visit Timer if active
    if (timerInterval) {
        clearInterval(timerInterval);
    }
    logoutUser();
});


// --- 3. ROUTE & SHOP LIST LOGIC (CACHED) ---

// --- 3. ROUTE & SHOP LIST LOGIC (CACHED) ---

// --- GLOBAL PAGINATION VARIABLES ---
let globalAllShops = [];
let globalDisplayedCount = 0;
const SHOPS_PER_BATCH = 7; // Load 7 at a time

// Updated: Fetches ALL routes assigned to salesman
async function loadAssignedRoute(uid) {
    const routeNameEl = document.getElementById('route-name');
    const shopsListEl = document.getElementById('shops-list');

    try {
        const q = query(
            collection(db, "routes"), 
            where("assignedSalesmanId", "==", uid),
            where("status", "==", "active")
        );
        const routeSnap = await getDocs(q);

        if (routeSnap.empty) {
            routeNameEl.innerText = "No Active Routes";
            shopsListEl.innerHTML = "<li class='p-10 text-center text-slate-400'>No active routes assigned.</li>";
            return;
        }

        const activeRoutes = [];
        routeSnap.forEach(doc => activeRoutes.push({ id: doc.id, ...doc.data() }));

        routeNameEl.innerText = activeRoutes.map(r => r.name).join(", ");
        appCache.routes = activeRoutes; 

        loadAllAssignedShops(activeRoutes);

    } catch (error) { console.error(error); }
}

// --- LOAD & MERGE SHOPS (OPTIMIZED) ---
async function loadAllAssignedShops(routes) {
    const routeIds = routes.map(r => r.id);
    const list = document.getElementById('shops-list');
    
    // UI: Show Skeleton/Loading
    list.innerHTML = `
        <li class="animate-pulse bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col gap-2">
            <div class="h-4 bg-slate-200 rounded w-3/4"></div>
            <div class="h-3 bg-slate-200 rounded w-1/2"></div>
        </li>
        <li class="animate-pulse bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col gap-2 opacity-50">
            <div class="h-4 bg-slate-200 rounded w-3/4"></div>
            <div class="h-3 bg-slate-200 rounded w-1/2"></div>
        </li>
    `;

    try {
        // 1. Get Activity Set (Visited Today)
        const todayStr = getTodayDateString(); 
        const activitySet = new Set();

        const vQ = query(collection(db, "visits"), where("salesmanId", "==", auth.currentUser.uid), where("status", "==", "completed"));
        const vSnap = await getDocs(vQ);
        vSnap.forEach(d => {
            const date = d.data().checkInTime.toDate().toISOString().split('T')[0];
            if(date === todayStr) activitySet.add(d.data().outletId);
        });

        // 2. Fetch all route_outlets IDs (Lightweight)
        let allRouteOutlets = [];
        const routePromises = routeIds.map(rId => 
            getDocs(query(collection(db, "route_outlets"), where("routeId", "==", rId)))
        );
        const routeSnaps = await Promise.all(routePromises);
        
        routeSnaps.forEach(snap => {
            snap.forEach(d => allRouteOutlets.push(d.data()));
        });

        const uniqueOutletIds = [...new Set(allRouteOutlets.map(item => item.outletId))];

        if(uniqueOutletIds.length === 0) {
             list.innerHTML = `<li class="text-center text-slate-400 py-10">No shops in this route.</li>`;
             return;
        }

        // 3. LIGHTNING FAST: Fetch Outlet Details in Parallel (Promise.all)
        const outletPromises = uniqueOutletIds.map(oId => getDoc(doc(db, "outlets", oId)));
        const outletSnaps = await Promise.all(outletPromises);

        let mergedShops = [];
        outletSnaps.forEach(snap => {
            if (snap.exists()) {
                const data = snap.data();
                mergedShops.push({
                    id: snap.id,
                    name: data.shopName,
                    lat: data.geo?.lat || 0,
                    lng: data.geo?.lng || 0,
                    sequence: data.sequence || 0,
                    // Fix: Ensure createdAt exists, default to 0 if missing
                    createdAt: data.createdAt ? (data.createdAt.toMillis ? data.createdAt.toMillis() : 0) : 0, 
                    isVisited: activitySet.has(snap.id)
                });
            }
        });

        // 4. SMART SORTING: 
        // Priority 1: Unvisited First
        // Priority 2: Latest Added First (createdAt desc)
        mergedShops.sort((a, b) => {
            // Put Unvisited before Visited
            if (a.isVisited !== b.isVisited) return a.isVisited ? 1 : -1;
            
            // Put Latest Created Shops on Top
            return b.createdAt - a.createdAt;
        });

        // 5. Store in Global & Init Pagination
        appCache.routeOutlets = mergedShops; // Update Cache
        globalAllShops = mergedShops;
        globalDisplayedCount = 0;
        
        // Clear list and Load First Batch
        list.innerHTML = "";
        loadMoreShops(); // Renders the first 7

    } catch (error) { 
        console.error("Shop Load Error:", error);
        list.innerHTML = `<li class="text-center text-red-400 py-4">Error loading data. Pull to refresh.</li>`;
    }
}

// --- PAGINATION RENDER FUNCTION ---
window.loadMoreShops = function() {
    const list = document.getElementById('shops-list');
    const loadMoreBtnId = "btn-load-more-container";
    
    // Remove existing Load More button if it exists
    const existingBtn = document.getElementById(loadMoreBtnId);
    if(existingBtn) existingBtn.remove();

    // Calculate Slice
    const nextBatch = globalAllShops.slice(globalDisplayedCount, globalDisplayedCount + SHOPS_PER_BATCH);
    
    if (nextBatch.length === 0 && globalDisplayedCount === 0) {
        list.innerHTML = `<li class="text-center text-slate-400 py-10">No shops assigned to this route.</li>`;
        return;
    }

    // Render Batch
    nextBatch.forEach(shop => {
        const li = createShopListItem(shop);
        list.appendChild(li);
    });

    // Update Counter
    globalDisplayedCount += nextBatch.length;

    // Check if more items exist
    if (globalDisplayedCount < globalAllShops.length) {
        const remaining = globalAllShops.length - globalDisplayedCount;
        
        const btnContainer = document.createElement('div');
        btnContainer.id = loadMoreBtnId;
        btnContainer.className = "py-4 flex justify-center pb-24"; // Extra padding at bottom
        btnContainer.innerHTML = `
            <button onclick="loadMoreShops()" class="bg-white text-indigo-600 font-bold py-3 px-8 rounded-full shadow-lg border border-indigo-100 hover:bg-indigo-50 active:scale-95 transition flex items-center gap-2 text-sm">
                <span>Load More Shops (${remaining})</span>
                <span class="material-icons-round text-sm">expand_more</span>
            </button>
        `;
        list.appendChild(btnContainer);
    } else if (globalDisplayedCount > 0) {
        // End of list indicator
        const endMsg = document.createElement('div');
        endMsg.className = "text-center text-[10px] text-slate-300 uppercase font-bold tracking-widest py-6 pb-24";
        endMsg.innerText = "End of Route";
        list.appendChild(endMsg);
    }
};

// --- HELPER: CREATE ITEM HTML ---
function createShopListItem(shop) {
    const li = document.createElement('li');
    const isVisited = shop.isVisited;
    
    // Visited: Greenish background, dim opacity. Unvisited: White, pop-out shadow.
    const bgStyle = isVisited 
        ? "background:#f0fdf4; border:1px solid #bbf7d0; opacity:0.8;" 
        : "background:white; border:1px solid #f1f5f9; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);";
    
    const checkMark = isVisited 
        ? `<span class="bg-green-100 text-green-700 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1"><span class="material-icons-round text-[10px]">check</span> Done</span>` 
        : `<span class="bg-indigo-50 text-indigo-600 text-[10px] font-bold px-2 py-0.5 rounded-full">Pending</span>`;

    li.className = "rounded-2xl p-4 transition-all mb-3 relative overflow-hidden group";
    li.style.cssText = bgStyle;
    
    li.innerHTML = `
        <div class="flex justify-between items-start">
            <div>
                <h4 class="font-bold text-slate-800 text-[15px] leading-tight mb-1">${shop.name}</h4>
                <div class="flex gap-2 items-center">
                    ${checkMark}
                    <span class="text-[10px] text-slate-400 font-mono">ID: ${shop.id.substr(0,4)}</span>
                </div>
            </div>
            <!-- Quick GPS Nav Button (Top Right) -->
             <button class="btn-nav bg-blue-50 text-blue-600 w-8 h-8 rounded-xl flex items-center justify-center active:scale-90 transition" title="Navigate">
                <span class="material-icons-round text-sm">near_me</span>
            </button>
        </div>
        
        <!-- Action Bar -->
        <div class="flex gap-2 mt-4 pt-3 border-t border-dashed border-slate-100">
            <button class="btn-open-map flex-1 bg-slate-800 text-white py-2 rounded-xl text-xs font-bold shadow hover:bg-slate-900 active:scale-95 transition flex items-center justify-center gap-1">
                ${isVisited ? 'View Details' : 'Start Visit'} 
                <span class="material-icons-round text-[14px]">arrow_forward</span>
            </button>
            
            <button class="btn-collect flex-1 bg-emerald-50 text-emerald-700 border border-emerald-100 py-2 rounded-xl text-xs font-bold hover:bg-emerald-100 active:scale-95 transition">
                Collect
            </button>

            <button class="btn-phone-order w-10 bg-orange-50 text-orange-600 border border-orange-100 py-2 rounded-xl flex items-center justify-center hover:bg-orange-100 active:scale-95 transition">
                <span class="material-icons-round text-sm">call</span>
            </button>
        </div>
    `;
    
    // Attach Listeners
    li.querySelector('.btn-nav').onclick = (e) => { e.stopPropagation(); openGoogleMapsNavigation(shop.lat, shop.lng); };
    li.querySelector('.btn-collect').onclick = (e) => { e.stopPropagation(); openQuickCollection(shop.id, shop.name); };
    li.querySelector('.btn-phone-order').onclick = (e) => { e.stopPropagation(); window.openOrderForm(shop.id, shop.name); };
    li.querySelector('.btn-open-map').onclick = () => {
        if(shop.lat === 0 && shop.lng === 0) alert("No GPS coordinates set.");
        else openVisitPanel(shop.id, shop.name, shop.lat, shop.lng);
    };

    return li;
}



// --- ROUTE MAP LOGIC ---

let routeMapInstance = null; // Separate variable to avoid conflict with visit map

// Updated: Plots shops from ALL assigned routes on one map
async function loadRouteOnMap() {
    if (routeMapInstance) routeMapInstance.remove();
    routeMapInstance = L.map('routeMap').setView([20.5937, 78.9629], 5); 
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(routeMapInstance);

    if (!appCache.routeOutlets) return;

    const blueIcon = new L.Icon({
        iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
        iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
    });

    const greenIcon = new L.Icon({
        iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
        iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
    });

    const markers = [];
    appCache.routeOutlets.forEach(shop => {
        if (shop.lat !== 0) {
            const marker = L.marker([shop.lat, shop.lng], {
                icon: shop.isVisited ? greenIcon : blueIcon
            }).addTo(routeMapInstance);

            // CHANGED: Instead of a simple popup, we trigger a detailed fetch
            marker.on('click', () => {
                openOutletMapDetails(shop.id, shop.name, shop.lat, shop.lng);
            });

            markers.push(marker);
        }
    });

    if (markers.length > 0) {
        const group = new L.featureGroup(markers);
        routeMapInstance.fitBounds(group.getBounds().pad(0.1));
    }
}









// --- 4. VISIT PANEL & MAP LOGIC ---

window.openVisitPanel = async function(outletId, name, shopLat, shopLng) {
    // 1. Existing Logic...
    currentVisitTarget = { lat: shopLat, lng: shopLng };
    document.getElementById('route-view').style.display = 'none';
    document.getElementById('visit-view').style.display = 'block';
    document.getElementById('visit-shop-name').innerText = name;



// 2. NEW: Attach Navigation Listener to the Floating Button
    const navBtn = document.getElementById('btn-visit-navigate');
    if(navBtn) {
        // Remove old listeners to prevent stacking (cloning trick)
        const newBtn = navBtn.cloneNode(true);
        navBtn.parentNode.replaceChild(newBtn, navBtn);
        
        // Add new listener with current coordinates
        newBtn.onclick = () => openGoogleMapsNavigation(shopLat, shopLng);
    }

    // 3. Existing Map Logic...
    if (map) map.remove();
    map = L.map('map').setView([shopLat, shopLng], 18);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);

    shopMarker = L.marker([shopLat, shopLng]).addTo(map).bindPopup(`<b>${name}</b>`).openPopup();


    
    
    // 3. Setup "Check-In" Button (Declare geoBtn ONLY ONCE here)
    const geoBtn = document.getElementById('btn-geo-checkin');
    
    // Reset Button State
    geoBtn.style.display = 'block';
    geoBtn.disabled = false;
    geoBtn.innerText = "📍 Verify Location to Start";
    geoBtn.onclick = () => verifyLocationForVisit(outletId, name, shopLat, shopLng);
    geoBtn.style.background = "#2563eb"; // Blue

    // Reset UI Texts
    document.getElementById('dist-display').innerText = "Tap Verify";
    document.getElementById('in-shop-controls').style.display = 'none';

    // 4. Load Balance
    const balEl = document.getElementById('visit-outstanding-bal');
    balEl.innerText = "Loading...";
    try {
        const docSnap = await getDoc(doc(db, "outlets", outletId));
        if (docSnap.exists()) {
            balEl.innerText = "₹" + (docSnap.data().currentBalance || 0).toFixed(2);
            // Setup Payment Modal Data
            const payEl = document.getElementById('pay-outlet-name');
            if(payEl) {
                payEl.dataset.id = outletId;
                payEl.innerText = name;
            }
        } else {
            balEl.innerText = "₹0.00";
        }
    } catch (e) { 
        console.error("Balance Load Error:", e);
        balEl.innerText = "Error"; 
    }

    // 5. Initialize Map
    if (map) map.remove();
    map = L.map('map').setView([shopLat, shopLng], 18);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);

    // Add Shop Marker
    shopMarker = L.marker([shopLat, shopLng]).addTo(map).bindPopup(`<b>${name}</b>`).openPopup();
    
    // Add User Marker (Hidden initially or set to last known)
    userMarker = L.circleMarker([0,0], { radius: 8, color: 'blue', fillOpacity: 0.8 }).addTo(map);
    if(lastKnownLocation) {
        userMarker.setLatLng([lastKnownLocation.lat, lastKnownLocation.lng]);
    }
};



window.closeVisitPanel = function() {
    if (currentVisitId) {
        alert("⚠️ Active Visit!\n\nYou must 'End Visit' to calculate duration before going back.");
        return;
    }
    
    // Switch Views
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
        btn.innerText = "Saving...";
        btn.disabled = true;
        
        const routeName = appCache.route ? appCache.route.name : (document.getElementById('route-name')?.innerText || "Unknown");

        // Save Visit
        const docRef = await addDoc(collection(db, "visits"), {
            salesmanId: auth.currentUser.uid,
            salesmanName: appCache.user?.fullName || auth.currentUser.email,
            outletId: outletId,
            outletName: outletName,
            routeName: routeName,
            checkInTime: Timestamp.now(),
            location: new GeoPoint(lat, lng), // Use passed coords
            status: "in-progress"
        });

        currentVisitId = docRef.id;
        visitStartTime = new Date();



        history.pushState(null, null, window.location.href); 
        btn.style.display = 'none';
        controls.style.display = 'block';
        startTimer();

        // Bind Actions
        document.getElementById('btn-take-order').onclick = () => openOrderForm(outletId, outletName);
        document.getElementById('btn-end-visit').onclick = () => performEndVisit();

    } catch (error) {
        console.error("Visit Start Error:", error);
        alert("Check-in failed: " + error.message);
        btn.disabled = false;
        btn.innerText = "Retry Confirm";
    }
}




async function performEndVisit() {
    if(!confirm("Are you sure you want to end this visit?")) return;
    
    const btn = document.getElementById('btn-end-visit');
    const originalText = btn.innerText;
    btn.innerText = "Verifying Location...";
    btn.disabled = true;

    try {


// In salesman.js inside performEndVisit and submitOrder
if (appCache.routes) {
    appCache.routes.forEach(async (r) => {
        await updateDoc(doc(db, "routes", r.id), { 
            lastVisitDate: new Date().toLocaleDateString() 
        });
    });
}

        
        // 1. Get Current GPS
        const loc = await fetchCurrentGPS();
        
        // 2. VALIDATION: Check if inside 50m Fence
        if (currentVisitTarget) {
            const dist = getDistanceFromLatLonInM(loc.lat, loc.lng, currentVisitTarget.lat, currentVisitTarget.lng);
            
            // Allow a small buffer (e.g. GPS inaccuracy), but strictly enforce logic
            if (dist > GEO_FENCE_RADIUS) {
                // ALERT AND BLOCK
                alert(`🚫 OUT OF ZONE!\n\nYou are ${Math.round(dist)} meters away from the shop.\n\nPlease move back within ${GEO_FENCE_RADIUS} meters to close the visit.`);
                
                // Reset button and STOP
                btn.innerText = originalText;
                btn.disabled = false;
                return; 
            }
        }

        // 3. If validation passes, calculate duration
        const endTime = new Date();
        const duration = Math.round((endTime - visitStartTime) / 1000 / 60); // Minutes

        // 4. Update Firestore
        // ... inside try block ...

        await updateDoc(doc(db, "visits", currentVisitId), {
            checkOutTime: Timestamp.now(),
            checkOutLocation: new GeoPoint(loc.lat, loc.lng),
            status: "completed",
            durationMinutes: duration
        });

        stopTimer();



currentVisitId = null; // 1. Release the guard variable
// 2. Clean up the history stack we pushed in CheckIn (optional but cleaner UI behavior)
if(window.history.state === null) history.back(); 
        
        alert(`✅ Visit Closed Successfully.\nDuration: ${duration} mins.`);
        closeVisitPanel();

        // NEW: REFRESH THE SHOP LIST TO SHOW GREEN COLOR
        if (appCache.route) {
            loadShops(appCache.route.id);
        }

      

    } catch (error) {
        console.error("End Visit Error:", error);
        
        // Detailed Error Messages
        let msg = "Error ending visit.";
        if (error.code === 1) msg = "GPS Permission Denied. Enable Location.";
        else if (error.code === 2 || error.code === 3) msg = "GPS Signal Weak/Timeout. Move to open area.";
        else if (error.message.includes("network")) msg = "Network Error. Check Internet.";
        
        alert(`⚠️ ${msg}\n\nTechnical details: ${error.message}`);
    } finally {
        btn.innerText = "End Visit";
        btn.disabled = false;
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

async function handleDailyAttendance(user) {
    const btn = document.getElementById('checkInBtn');
    
    try {
        btn.disabled = true;
        btn.innerText = "Locating...";

        // 1. Get GPS On-Demand
        const loc = await fetchCurrentGPS();
        
        // 2. Submit to Firestore
        await addDoc(collection(db, "attendance"), {
            salesmanId: user.uid,
            salesmanName: appCache.user?.fullName || user.email, 
            salesmanEmail: user.email,
            date: getTodayDateString(),
            checkInTime: Timestamp.now(),
            location: new GeoPoint(loc.lat, loc.lng)
        });

        alert("Daily Attendance Marked!");
        checkTodayAttendance(user); // Refresh UI

    } catch (e) {
        alert("Error: " + e.message);
        btn.disabled = false;
        btn.innerText = "Check In Now";
    }
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


 // 1. Check if Visit is Active
    if (currentVisitId) {
        alert("⚠️ You have an active visit!\n\nPlease click 'End Visit' before switching tabs.");
        return; // STOP execution
    }

    
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
    const dueDateVal = document.getElementById('orderDueDate').value;
    const btn = document.getElementById('btn-submit-order');

    // Validation
    if (orderCart.length === 0) return alert("Cart is empty!");
    if (!dueDateVal) return alert("⚠️ Please select a Delivery Due Date.");
    
    if (!isPhone && !currentVisitId) {
        alert("❌ Geo-Fence Error: You must be Checked-In.");
        return;
    }

    if (!confirm("Confirm Order Submission?")) return;

    btn.disabled = true;
    btn.innerText = "Processing...";

    try {
        // CAPTURE ROUTE NAME (From UI or Default)
        // This grabs the route name displayed on the dashboard
        const currentRouteName = document.getElementById('route-name')?.innerText || "Unassigned/Phone";

        // Update route last visit date
        if (appCache.routes) {
            appCache.routes.forEach(async (r) => {
                try {
                    await updateDoc(doc(db, "routes", r.id), { 
                        lastVisitDate: new Date().toLocaleDateString() 
                    });
                } catch(e) { console.warn("Route update silent fail"); }
            });
        }
        
        // Calculate Financials
        const subtotal = orderCart.reduce((sum, item) => sum + item.lineTotal, 0);
        const tax = applyTax ? (subtotal * 0.05) : 0;
        const total = subtotal + tax;

        // Prepare Order Data
        const orderData = {
            salesmanId: auth.currentUser.uid,
            salesmanName: appCache.user?.fullName || auth.currentUser.email,
            outletId: currentOrderOutlet.id,
            outletName: currentOrderOutlet.name,
            routeName: currentRouteName, // <--- NEW FIELD ADDED HERE
            visitId: isPhone ? null : currentVisitId,
            orderDate: Timestamp.now(),
            deliveryDueDate: Timestamp.fromDate(new Date(dueDateVal)),
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

        // Save to 'orders' Collection
        await addDoc(collection(db, "orders"), orderData);

        // Update Outlet Balance
        const outletRef = doc(db, "outlets", currentOrderOutlet.id);
        await updateDoc(outletRef, {
            currentBalance: increment(total),
            lastOrderDate: Timestamp.now()
        });

        alert("✅ Order Placed Successfully!");
        
        // Cleanup UI
        document.getElementById('order-view').style.display = 'none';
        document.getElementById('orderDueDate').value = "";
        
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

    // Temporarily disable UI but keep modal open until GPS is fetched
    const submitBtn = modal.querySelector('button[onclick="submitPayment()"]');
    const origText = submitBtn.innerText;
    submitBtn.innerText = "Locating...";
    submitBtn.disabled = true;

    try {
        // 1. Active GPS Fetch
        const loc = await fetchCurrentGPS();

        // 2. Submit Data
        await addDoc(collection(db, "payments"), {
            salesmanId: auth.currentUser.uid,
            salesmanName: appCache.user?.fullName || auth.currentUser.email,
            outletId: outletId,
            outletName: outletName,
            amount: amount,
            method: method,
            date: Timestamp.now(),
            gpsLat: loc.lat, // Store Coords
            gpsLng: loc.lng,
            status: "pending"
        });

        alert("Payment Recorded successfully!");
        modal.style.display = 'none';

    } catch (error) {
        console.error("Payment Error:", error);
        alert("Failed: " + error.message);
    } finally {
        submitBtn.innerText = origText;
        submitBtn.disabled = false;
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











// --- DAILY TARGET SYSTEM (CACHED) ---

async function loadDailyTarget() {
    const card = document.getElementById('target-card');
    const uid = auth.currentUser.uid;

    // 1. Generate ID (uid_YYYY-MM-DD)
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;
    const targetId = `${uid}_${todayStr}`;

    try {
        let targetData;

        // 2. Check Cache
        if (appCache.dailyTarget && appCache.dailyTarget.id === targetId) {
            console.log("⚡ Loaded Target from Cache");
            targetData = appCache.dailyTarget.data;
        } else {
            // 3. Network Fetch
            console.log("🌐 Fetching Target from Firestore...");
            const targetSnap = await getDoc(doc(db, "daily_targets", targetId));

            if (!targetSnap.exists()) {
                console.log("No target found for today.");
                card.style.display = 'none';
                return;
            }

            targetData = targetSnap.data();
            // Cache It
            appCache.dailyTarget = { id: targetId, data: targetData };
        }

        // --- RENDER LOGIC (Same as before) ---
        const targetBoxes = Number(targetData.targetBoxes) || 0;
        const incentiveRate = Number(targetData.incentivePerBox) || 0;

        card.classList.remove('hidden'); 
        card.style.display = 'block';

        // 4. Calculate Actual Sales (We DO NOT Cache this, as it changes with every order)
        // Optimization: We could cache this but invalidating it after every order is complex.
        // For now, we only query the orders, but we saved the read on the 'daily_targets' doc.
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
            if(order.items && Array.isArray(order.items)) {
                order.items.forEach(item => totalBoxesSold += (Number(item.qty) || 0));
            }
        });

        // Update UI
        const progress = targetBoxes > 0 ? Math.min((totalBoxesSold / targetBoxes) * 100, 100) : 0;
        const remaining = Math.max(0, targetBoxes - totalBoxesSold);
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
        bar.className = "h-3 rounded-full transition-all duration-1000 ease-out"; 

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

// --- REPLACE EXISTING submitNewShop FUNCTION ---

async function submitNewShop() {
    const btn = document.getElementById('btnSaveShop');
    
    // 1. Gather Data
    const name = document.getElementById('newShopName').value.trim();
    const owner = document.getElementById('newOwnerName').value.trim();
    const phone = document.getElementById('newShopPhone').value.trim();
    const address = document.getElementById('newShopAddress').value.trim();
    const gst = document.getElementById('newShopGST').value.trim() || "N/A";
    
    const catType = document.getElementById('newShopType').value;
    const storeType = document.getElementById('newStoreType').value;
    const creditDays = storeType === 'Credit' ? Number(document.getElementById('newCreditDays').value) : 0;
    const creditLimit = storeType === 'Credit' ? Number(document.getElementById('newCreditLimit').value) : 0;

    const lat = document.getElementById('newShopLat').value;
    const lng = document.getElementById('newShopLng').value;

    if(!lat || !lng) {
        alert("⚠️ GPS Location is required. Please click 'Capture'.");
        return;
    }

    try {
        btn.disabled = true;
        btn.innerText = "Saving...";

        // 2. Construct Data Object
        const shopData = {
            shopName: name,
            ownerName: owner,
            contactPhone: phone,
            address: address,
            gstNumber: gst,
            outletType: catType,
            storeType: storeType,
            creditDays: creditDays,
            creditLimit: creditLimit,
            currentBalance: 0,
            geo: { lat: parseFloat(lat), lng: parseFloat(lng) },
            createdBySalesman: auth.currentUser.uid,
            createdAt: serverTimestamp(),
            status: 'active'
        };

        // 3. Save to 'outlets' Collection
        const docRef = await addDoc(collection(db, "outlets"), shopData);

        // --- THE FIX: LINK TO CURRENT ROUTE ---
        // We must add an entry to 'route_outlets' so it loads on refresh
        if (appCache.route && appCache.route.id) {
            await addDoc(collection(db, "route_outlets"), {
                routeId: appCache.route.id,
                outletId: docRef.id,
                outletName: name, // Denormalized for faster loading
                sequence: 0 // 0 puts it at the top as "New"
            });
            console.log("✅ Linked new shop to Route:", appCache.route.id);
        } else {
            console.warn("⚠️ No active route found in cache. Shop saved but not linked to route.");
        }
        // --------------------------------------

        // 4. Update UI Locally (Immediate Feedback)
        const newLocalShop = {
            id: docRef.id,
            name: name,
            sequence: 0, 
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            fullData: shopData
        };

        if (!appCache.routeOutlets) appCache.routeOutlets = [];
        appCache.routeOutlets.push(newLocalShop);

        renderShopsList(appCache.routeOutlets);
        
        alert("✅ Shop Added! It is now permanently in your route.");
        document.getElementById('addShopModal').classList.add('hidden');

    } catch (e) {
        console.error("Add Shop Error:", e);
        alert("Error saving shop: " + e.message);
    } finally {
        btn.disabled = false;
        btn.innerText = "Save Shop";
    }
}




// ==========================================
//      GPS CAPTURE LOGIC (Missing Part)
// ==========================================

function captureNewShopLocation() {
    const msg = document.getElementById('newShopGeoMsg');
    
    if(!navigator.geolocation) return alert("GPS not supported");

    msg.innerText = "Locating...";
    msg.className = "text-[10px] text-orange-500 font-bold";
    
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            
            document.getElementById('newShopLat').value = lat;
            document.getElementById('newShopLng').value = lng;
            
            msg.innerText = `✅ GPS Captured: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
            msg.className = "text-[10px] text-green-600 font-bold";
        },
        (err) => {
            console.error(err);
            msg.innerText = "GPS Failed. Please Enable Location.";
            msg.className = "text-[10px] text-red-500 font-bold";
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ==========================================
//      EXPOSE FUNCTIONS TO HTML
// ==========================================
// This makes the functions clickable from the HTML buttons

window.toggleCreditFields = toggleCreditFields;
window.captureNewShopLocation = captureNewShopLocation;
window.submitNewShop = submitNewShop;
window.openAddShopModal = openAddShopModal;


async function verifyLocationForVisit(outletId, outletName, targetLat, targetLng) {
    const btn = document.getElementById('btn-geo-checkin');
    const distDisplay = document.getElementById('dist-display');

    try {
        btn.innerText = "Locating...";
        btn.disabled = true;

        // 1. Active GPS Request
        const loc = await fetchCurrentGPS();

        // 2. Update Map
        userMarker.setLatLng([loc.lat, loc.lng]);
        map.setView([loc.lat, loc.lng], 18);

        // 3. Calculate Distance
        const distMeters = getDistanceFromLatLonInM(loc.lat, loc.lng, targetLat, targetLng);
        const distInt = Math.round(distMeters);
        distDisplay.innerText = `${distInt}m`;

        // 4. Check Fence
        if (distMeters <= GEO_FENCE_RADIUS) {
            btn.style.background = "#28a745"; // Green
            btn.innerText = `✅ Confirm Check-In (${distInt}m)`;
            btn.disabled = false;
            // Next click performs the actual DB write
            btn.onclick = () => performVisitCheckIn(outletId, outletName, loc.lat, loc.lng);
        } else {
            btn.style.background = "#dc3545"; // Red
            btn.innerText = `❌ Too Far (${distInt}m) - Retry`;
            btn.disabled = false;
            // Click to retry
            btn.onclick = () => verifyLocationForVisit(outletId, outletName, targetLat, targetLng);
        }

    } catch (e) {
        alert("GPS Error: " + e.message);
        btn.innerText = "Retry Location";
        btn.disabled = false;
    }
}















// --- ADD THIS NEW HELPER FUNCTION ---

window.openQuickCollection = function(outletId, outletName) {
    const modal = document.getElementById('paymentModal');
    const label = document.getElementById('pay-outlet-name');
    const input = document.getElementById('payAmount');
    
    // 1. Set Outlet Data
    label.innerText = outletName;
    label.dataset.id = outletId; // Store ID for the fetch function
    
    // 2. RESET Balance View (Crucial for optimization)
    // We wipe previous data so we don't show wrong balances from other shops
    document.getElementById('pay-balance-display').innerText = "---";
    document.getElementById('pay-balance-display').className = "text-sm font-bold text-slate-700";
    
    const viewBtn = document.getElementById('btn-view-bal');
    viewBtn.style.display = "inline-block"; // Show the button
    viewBtn.innerText = "VIEW";
    viewBtn.disabled = false;

    // 3. Reset Inputs
    input.value = "";
    document.getElementById('payMethod').value = "Cash";
    
    // 4. Show Modal
    modal.style.display = 'flex';
}




// --- NEW FUNCTION: ON-DEMAND BALANCE FETCH ---
window.fetchOutletBalance = async function() {
    const label = document.getElementById('pay-outlet-name');
    const outletId = label.dataset.id;
    const display = document.getElementById('pay-balance-display');
    const btn = document.getElementById('btn-view-bal');

    if(!outletId) return;

    // UI: Show loading state
    btn.disabled = true;
    btn.innerText = "...";
    display.innerText = "Loading...";

    try {
        console.log("💰 Fetching Balance from Firestore (1 Read Cost)");
        
        // DIRECT FIRESTORE READ
        // We do this here specifically to get the absolute latest money data
        const docRef = doc(db, "outlets", outletId);
        const docSnap = await getDoc(docRef);

        if(docSnap.exists()) {
            const bal = docSnap.data().currentBalance || 0;
            
            // Format Currency
            display.innerText = "₹" + bal.toFixed(2);
            
            // Color Logic: Red if they owe money, Green if 0 or positive
            if(bal > 0) {
                display.className = "text-sm font-bold text-red-600";
            } else {
                display.className = "text-sm font-bold text-green-600";
            }
            
            // Hide button after successful fetch to prevent re-clicks
            btn.style.display = "none";
        } else {
            display.innerText = "Error";
        }
    } catch (e) {
        console.error("Balance Fetch Error:", e);
        display.innerText = "Failed";
        btn.innerText = "Retry";
        btn.disabled = false;
    }
};






// --- NEW NAVIGATION HELPER (Zero Firebase Reads/Writes) ---
window.openGoogleMapsNavigation = function(lat, lng) {
    // 1. Validation (Memory check only)
    if (!lat || !lng || (lat === 0 && lng === 0)) {
        alert("⚠️ No GPS coordinates available for this shop.");
        return;
    }

    // 2. Hardware Check (Constraint: Alert if no GPS, but don't block)
    if (!navigator.geolocation) {
        alert("Please enable GPS to navigate");
    }

    // 3. Construct URL (Google Maps Intent)
    // api=1: Uses the new universal cross-platform syntax
    // destination: The target lat,lng
    // travelmode: driving
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;

    // 4. Execute (Opens Native App on Mobile, New Tab on Desktop)
    window.open(url, '_blank');
};






















async function openOutletMapDetails(outletId, name, lat, lng) {
    const modal = document.getElementById('mapDetailModal');
    modal.classList.remove('hidden');

    // UI Initial State
    document.getElementById('md-shopName').innerText = name;
    document.getElementById('md-ordersList').innerHTML = "Loading history...";
    document.getElementById('md-paymentsList').innerHTML = "Loading history...";
    document.getElementById('md-bestSeller').innerText = "Calculating...";

    // Setup Direction & Visit Buttons
    document.getElementById('md-navBtn').onclick = () => openGoogleMapsNavigation(lat, lng);
    document.getElementById('md-visitBtn').onclick = () => {
        modal.classList.add('hidden');
        openVisitPanel(outletId, name, lat, lng);
    };

    try {
        // 1. Fetch Outlet Doc (Balance/Type)
        const outletSnap = await getDoc(doc(db, "outlets", outletId));
        const outletData = outletSnap.data();
        document.getElementById('md-shopType').innerText = outletData.outletType || 'Shop';
        document.getElementById('md-balance').innerText = `₹${(outletData.currentBalance || 0).toFixed(2)}`;

        // 2. Fetch Last 5 Orders
        const orderQ = query(collection(db, "orders"), where("outletId", "==", outletId), orderBy("orderDate", "desc"), limit(5));
        const orderSnap = await getDocs(orderQ);
        
        // 3. Fetch Last 5 Payments
        const payQ = query(collection(db, "payments"), where("outletId", "==", outletId), orderBy("date", "desc"), limit(5));
        const paySnap = await getDocs(payQ);

        // Render Orders & Calculate Best Seller
        let orderHtml = "";
        let productCounts = {};
        
        if(orderSnap.empty) orderHtml = "<p class='text-slate-400'>No previous orders</p>";
        orderSnap.forEach(d => {
            const ord = d.data();
            const date = ord.orderDate.toDate().toLocaleDateString();
            orderHtml += `
                <div class="flex justify-between bg-slate-50 p-2 rounded-lg border border-slate-100">
                    <span>${date}</span>
                    <span class="font-bold text-slate-700">₹${ord.financials.totalAmount}</span>
                </div>`;
            
            // Tally products for Best Seller
            ord.items.forEach(item => {
                productCounts[item.name] = (productCounts[item.name] || 0) + item.qty;
            });
        });
        document.getElementById('md-ordersList').innerHTML = orderHtml;

        // Determine Best Seller
        const bestSeller = Object.keys(productCounts).reduce((a, b) => productCounts[a] > productCounts[b] ? a : b, "None");
        document.getElementById('md-bestSeller').innerText = bestSeller;

        // Render Payments
        let payHtml = "";
        if(paySnap.empty) payHtml = "<p class='text-slate-400'>No previous payments</p>";
        paySnap.forEach(d => {
            const pay = d.data();
            const date = pay.date.toDate().toLocaleDateString();
            const statusColor = pay.status === 'approved' ? 'text-emerald-600' : 'text-orange-500';
            payHtml += `
                <div class="flex justify-between bg-emerald-50/50 p-2 rounded-lg border border-emerald-100">
                    <span>${date} (${pay.method})</span>
                    <span class="font-bold ${statusColor}">₹${pay.amount}</span>
                </div>`;
        });
        document.getElementById('md-paymentsList').innerHTML = payHtml;

    } catch (e) {
        console.error("Detail Fetch Error:", e);
        alert("Error loading outlet history. Check Firestore Indexes.");
    }
}
