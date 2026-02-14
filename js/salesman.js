// 1. IMPORTS
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, query, where, getDocs, orderBy, addDoc, updateDoc, Timestamp, GeoPoint, increment, serverTimestamp 
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






// --- MULTI-ROUTE SWITCHER ---
window.switchRoute = function(newRouteId) {
    // 1. SECURITY GUARD: Prevent switching if visit is active
    if (currentVisitId) {
        // Reset dropdown to previous value
        if(appCache.route) document.getElementById('route-selector').value = appCache.route.id;
        alert("⚠️ Active Visit in Progress!\n\nYou cannot switch routes while inside a shop.\nPlease 'End Visit' first.");
        return;
    }

    // 2. Find data in cache
    const selectedRoute = appCache.allAssignedRoutes.find(r => r.id === newRouteId);
    if (!selectedRoute) return;

    // 3. Update Current Cache
    appCache.route = selectedRoute; // Set as active
    
    // 4. Reset UI
    console.log("🔄 Switching to Route:", selectedRoute.name);
    
    // Clear the shops list first to show loading state
    document.getElementById('shops-list').innerHTML = "<li style='padding:15px; text-align:center;'>Loading stops...</li>";
    
    // Load new shops
    loadShops(selectedRoute.id);
    
    // Refresh Map if active
    if(document.getElementById('map-view').classList.contains('hidden') === false) {
        loadRouteOnMap();
    }
};







// --- NEW: LOAD & MERGE SHOPS FROM ALL ROUTES ---
async function loadCombinedShops(routesArray) {
    const list = document.getElementById('shops-list');
    list.innerHTML = "<li class='text-center py-4 text-slate-400'>Merging routes...</li>";

    try {
        let allShops = [];

        // 1. Fetch Route Outlets for EACH Route (Parallel Fetch)
        const routePromises = routesArray.map(async (route) => {
            const q = query(collection(db, "route_outlets"), where("routeId", "==", route.id), orderBy("sequence", "asc"));
            const snap = await getDocs(q);
            
            // Map snap to simple array
            return snap.docs.map(d => ({
                linkId: d.id,
                outletId: d.data().outletId,
                routeName: route.name, // Tag the shop with its Route Name
                sequence: d.data().sequence
            }));
        });

        const results = await Promise.all(routePromises);
        // Flatten array of arrays
        const flatLinks = results.flat();

        if (flatLinks.length === 0) {
            list.innerHTML = "<li class='text-center py-4'>No shops found in assigned routes.</li>";
            return;
        }

        // 2. Fetch Actual Outlet Details (Parallel Fetch)
        // Optimization: Use a Set to avoid fetching the same shop twice if it's in multiple routes (rare but possible)
        const uniqueOutletIds = [...new Set(flatLinks.map(l => l.outletId))];
        
        const outletPromises = uniqueOutletIds.map(id => getDoc(doc(db, "outlets", id)));
        const outletSnaps = await Promise.all(outletPromises);
        
        // Create Map for fast lookup: ID -> Data
        const outletMap = {};
        outletSnaps.forEach(snap => {
            if(snap.exists()) outletMap[snap.id] = snap.data();
        });

        // 3. Build Final List
        allShops = flatLinks.map(link => {
            const data = outletMap[link.outletId];
            if (!data) return null; // Skip deleted shops
            return {
                id: link.outletId,
                name: data.shopName, // or link.outletName
                routeName: link.routeName, // Useful for display
                sequence: link.sequence,
                lat: data.geo ? data.geo.lat : 0,
                lng: data.geo ? data.geo.lng : 0,
                fullData: data
            };
        }).filter(s => s !== null);

        // 4. Update Cache (Unified List)
        appCache.routeOutlets = allShops;

        // 5. Render List & Map
        // We need to fetch visited status first
        const today = new Date();
        today.setHours(0,0,0,0);
        const visitQ = query(collection(db, "visits"), where("salesmanId", "==", auth.currentUser.uid), where("checkInTime", ">=", Timestamp.fromDate(today)));
        const visitSnap = await getDocs(visitQ);
        const visitedSet = new Set();
        visitSnap.forEach(doc => visitedSet.add(doc.data().outletId));

        renderCombinedShopsList(allShops, visitedSet);
        
        // If map is already open, reload markers
        if(!document.getElementById('map-view').classList.contains('hidden')) {
             loadRouteOnMap(); 
        }

    } catch (e) {
        console.error("Merge Shops Error:", e);
        list.innerHTML = "<li class='text-center text-red-500'>Error loading shops.</li>";
    }
}




















function renderCombinedShopsList(shops, visitedSet) {
    const list = document.getElementById('shops-list');
    list.innerHTML = "";

    // Sort Logic: 
    // 1. Visited at bottom
    // 2. Then by Route Name (Cluster shops by route)
    // 3. Then by Sequence
    shops.sort((a, b) => {
        const aVisit = visitedSet.has(a.id) ? 1 : 0;
        const bVisit = visitedSet.has(b.id) ? 1 : 0;
        if (aVisit !== bVisit) return aVisit - bVisit;
        
        if (a.routeName !== b.routeName) return a.routeName.localeCompare(b.routeName);
        
        return (a.sequence || 999) - (b.sequence || 999);
    });

    shops.forEach(shop => {
        const isVisited = visitedSet.has(shop.id);
        const li = document.createElement('li');
        
        const bgStyle = isVisited ? "background:#f0fdf4; border:1px solid #86efac;" : "background:white; border:1px solid #e2e8f0;";
        const checkMark = isVisited ? `<span style="color:green; font-weight:bold; font-size:12px;">✅ Done</span>` : "";

        li.style.cssText = `${bgStyle} margin:10px 0; padding:15px; border-radius:16px; transition: background 0.3s; box-shadow: 0 2px 5px rgba(0,0,0,0.02);`;
        
        li.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:start;">
                <div>
                    <!-- ROUTE BADGE -->
                    <span class="text-[10px] uppercase font-bold text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded-md mb-1 inline-block border border-indigo-100">${shop.routeName}</span>
                    
                    <h4 style="font-size:1rem; font-weight:700; color:${isVisited ? '#15803d' : '#1e293b'}">${shop.name}</h4>
                    <div style="display:flex; gap:5px; align-items:center; margin-top:4px;">
                        <span style="font-size:0.75rem; color:#64748b;">Seq: ${shop.sequence}</span>
                        ${checkMark}
                    </div>
                </div>
            </div>
            
            <div style="display:flex; gap:8px; justify-content:flex-end; border-top:1px dashed #eee; margin-top:10px; padding-top:10px;">
                <button class="btn-nav" style="background:#e0f2fe; color:#0284c7; width:36px; height:36px; border-radius:10px; display:flex; align-items:center; justify-content:center; border:none;" title="Navigate">
                    <span class="material-icons-round" style="font-size:18px;">near_me</span>
                </button>
                <button class="btn-collect" style="background:#ecfccb; color:#4d7c0f; width:36px; height:36px; border-radius:10px; display:flex; align-items:center; justify-content:center; border:none;" title="Collect">
                    <span class="material-icons-round" style="font-size:18px;">payments</span>
                </button>
                <button class="btn-phone-order" style="background:#fff7ed; color:#c2410c; width:36px; height:36px; border-radius:10px; display:flex; align-items:center; justify-content:center; border:none;" title="Phone Order">
                    <span class="material-icons-round" style="font-size:18px;">call</span>
                </button>
                <button class="btn-open-map" style="background:${isVisited ? '#f1f5f9' : '#eff6ff'}; color:${isVisited ? '#64748b' : '#2563eb'}; padding:0 12px; height:36px; border-radius:10px; border:none; font-weight:bold; font-size:0.75rem;">
                    ${isVisited ? 'View' : 'Visit'}
                </button>
            </div>
        `;
        
        // Attach Listeners
        li.querySelector('.btn-nav').onclick = () => openGoogleMapsNavigation(shop.lat, shop.lng);
        li.querySelector('.btn-collect').onclick = () => openQuickCollection(shop.id, shop.name);
        li.querySelector('.btn-phone-order').onclick = () => window.openOrderForm(shop.id, shop.name);
        li.querySelector('.btn-open-map').onclick = () => {
            if(shop.lat === 0 && shop.lng === 0) alert("No GPS coordinates set.");
            else openVisitPanel(shop.id, shop.name, shop.lat, shop.lng);
        };

        list.appendChild(li);
    });
}



// --- 3. ROUTE & SHOP LIST LOGIC (CACHED) ---

// --- UPDATED LOAD ROUTE (HANDLES MULTIPLE ROUTES) ---
async function loadAssignedRoute(uid) {
    const nameEl = document.getElementById('route-name');
    const selectEl = document.getElementById('route-selector');
    const listEl = document.getElementById('shops-list');

    try {
        console.log("🌐 Fetching Routes...");
        
        // 1. Fetch ALL routes for this salesman
        const q = query(collection(db, "routes"), where("assignedSalesmanId", "==", uid));
        const snap = await getDocs(q);

        if (snap.empty) {
            nameEl.innerText = "No Route Assigned";
            nameEl.classList.remove('hidden');
            selectEl.classList.add('hidden');
            listEl.innerHTML = "<li style='padding:15px; color:orange; text-align:center;'>Contact Admin to assign a route.</li>";
            return;
        }

        // 2. Prepare Data
        const routes = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        appCache.allAssignedRoutes = routes; // Store all in cache

        // 3. UI Logic
        if (routes.length === 1) {
            // SCENARIO A: Single Route (Standard)
            const r = routes[0];
            appCache.route = r; // Set active
            
            nameEl.innerText = r.name;
            nameEl.classList.remove('hidden');
            selectEl.classList.add('hidden');
            
            loadShops(r.id);
        } else {
            // SCENARIO B: Multiple Routes (Dropdown)
            nameEl.classList.add('hidden'); // Hide text title
            selectEl.classList.remove('hidden'); // Show dropdown
            
            // Populate Options
            selectEl.innerHTML = "";
            routes.forEach(r => {
                const opt = document.createElement('option');
                opt.value = r.id;
                opt.textContent = r.name;
                selectEl.appendChild(opt);
            });

            // Auto-select the first one (or the last one they used if we cached it, but let's keep it simple)
            appCache.route = routes[0];
            selectEl.value = routes[0].id;
            
            loadShops(routes[0].id);
        }

    } catch (error) {
        console.error("Load Route Error:", error);
        nameEl.innerText = "Error Loading";
    }
}










async function loadShops(routeId) {
    const list = document.getElementById('shops-list');
    
    // 1. Fetch Today's Visits (To mark them green)
    // We do this every time to keep the "Visited" status fresh
    const today = new Date();
    today.setHours(0,0,0,0);
    const todayTs = Timestamp.fromDate(today);
    
    let visitedSet = new Set();
    
    try {
        const visitQ = query(
            collection(db, "visits"), 
            where("salesmanId", "==", auth.currentUser.uid),
            where("checkInTime", ">=", todayTs)
        );
        const visitSnap = await getDocs(visitQ);
        visitSnap.forEach(doc => visitedSet.add(doc.data().outletId));
    } catch(e) { console.error("Error fetching daily visits:", e); }

    // 2. Check Cache for Outlets List (Heavy Data)
    if (appCache.routeOutlets) {
        console.log("⚡ Loaded Shops from Cache");
        renderShopsList(appCache.routeOutlets, visitedSet); // Pass visitedSet
        return;
    }

    // 3. Network Fetch (If not cached)
    console.log("🌐 Fetching Outlets from Firestore...");
    const q = query(collection(db, "route_outlets"), where("routeId", "==", routeId), orderBy("sequence", "asc"));
    
    try {
        const snap = await getDocs(q);
        
        if(snap.empty) { 
            list.innerHTML = "<li style='padding:15px;'>No shops in this route.</li>"; 
            return; 
        }

        // Process & Merge Data
        const outletPromises = snap.docs.map(async (docSnap) => {
            const linkData = docSnap.data();
            const outletDoc = await getDoc(doc(db, "outlets", linkData.outletId));
            if (!outletDoc.exists()) return null;
            const outletData = outletDoc.data();
            
            return {
                id: linkData.outletId,
                name: linkData.outletName,
                sequence: linkData.sequence,
                lat: outletData.geo ? outletData.geo.lat : 0,
                lng: outletData.geo ? outletData.geo.lng : 0,
                fullData: outletData 
            };
        });

        const results = await Promise.all(outletPromises);
        const validShops = results.filter(s => s !== null);

        // Save to Cache
        appCache.routeOutlets = validShops;

        // Render
        renderShopsList(validShops, visitedSet); // Pass visitedSet

    } catch (error) {
        console.error("Load Shops Error:", error);
    }
}

// --- UPDATED RENDER LIST WITH NAVIGATION BUTTON ---
function renderShopsList(shops, visitedSet = new Set()) {
    const list = document.getElementById('shops-list');
    list.innerHTML = "";

    // Sort: Visited at bottom, then by sequence
    shops.sort((a, b) => {
        const aVisit = visitedSet.has(a.id) ? 1 : 0;
        const bVisit = visitedSet.has(b.id) ? 1 : 0;
        if (aVisit !== bVisit) return aVisit - bVisit;
        return (a.sequence || 999) - (b.sequence || 999);
    });

    shops.forEach(shop => {
        const isVisited = visitedSet.has(shop.id);
        const li = document.createElement('li');
        
        const bgStyle = isVisited ? "background:#f0fdf4; border:1px solid #86efac;" : "background:white; border:1px solid #ddd;";
        const checkMark = isVisited ? `<span style="color:green; font-weight:bold; font-size:12px;">✅ Visited</span>` : "";

        li.style.cssText = `${bgStyle} margin:10px 0; padding:15px; border-radius:16px; display:flex; flex-direction:column; gap:10px; transition: background 0.3s; box-shadow: 0 2px 5px rgba(0,0,0,0.02);`;
        
        li.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <strong style="font-size:1rem; color:${isVisited ? '#15803d' : '#1e293b'}">${shop.name}</strong><br>
                    <div style="display:flex; gap:5px; align-items:center; margin-top:2px;">
                        <span style="font-size:0.7rem; background:#f1f5f9; color:#64748b; padding:2px 6px; border-radius:4px;">Seq: ${shop.sequence || 'New'}</span>
                        ${checkMark}
                    </div>
                </div>
            </div>
            
            <div style="display:flex; gap:8px; justify-content:flex-end; border-top:1px dashed #eee; padding-top:10px;">
                <!-- NAVIGATION BUTTON (NEW) -->
                <button class="btn-nav" style="background:#e0f2fe; color:#0284c7; border:1px solid #bae6fd; width:36px; height:36px; border-radius:10px; display:flex; align-items:center; justify-content:center; cursor:pointer;" title="Navigate">
                    <span class="material-icons-round" style="font-size:18px;">near_me</span>
                </button>

                <!-- COLLECTION BUTTON -->
                <button class="btn-collect" style="background:#ecfccb; color:#4d7c0f; border:1px solid #d9f99d; width:36px; height:36px; border-radius:10px; display:flex; align-items:center; justify-content:center; cursor:pointer;" title="Collect Payment">
                    <span class="material-icons-round" style="font-size:18px;">payments</span>
                </button>

                <!-- PHONE ORDER -->
                <button class="btn-phone-order" style="background:#fff7ed; color:#c2410c; border:1px solid #ffedd5; width:36px; height:36px; border-radius:10px; display:flex; align-items:center; justify-content:center; cursor:pointer;" title="Phone Order">
                    <span class="material-icons-round" style="font-size:18px;">call</span>
                </button>

                <!-- VISIT BUTTON -->
                <button class="btn-open-map" style="background:${isVisited ? '#f1f5f9' : '#eff6ff'}; color:${isVisited ? '#64748b' : '#2563eb'}; border:1px solid ${isVisited ? '#e2e8f0' : '#bfdbfe'}; padding:0 12px; height:36px; border-radius:10px; cursor:pointer; font-weight:bold; font-size:0.75rem;">
                    ${isVisited ? 'View' : 'Visit'}
                </button>
            </div>
        `;
        
        // Attach Listeners
        li.querySelector('.btn-nav').onclick = () => openGoogleMapsNavigation(shop.lat, shop.lng);
        li.querySelector('.btn-collect').onclick = () => openQuickCollection(shop.id, shop.name);
        li.querySelector('.btn-phone-order').onclick = () => window.openOrderForm(shop.id, shop.name);
        li.querySelector('.btn-open-map').onclick = () => {
            if(shop.lat === 0 && shop.lng === 0) alert("No GPS coordinates set.");
            else openVisitPanel(shop.id, shop.name, shop.lat, shop.lng);
        };

        list.appendChild(li);
    });
}





// --- ROUTE MAP LOGIC ---

let routeMapInstance = null; // Separate variable to avoid conflict with visit map

// --- UPDATED: MAP LOADER (READS FROM CACHE) ---
async function loadRouteOnMap() {
    console.log("Loading Map...");
    
    if (routeMapInstance) routeMapInstance.remove();
    routeMapInstance = L.map('routeMap').setView([20.5937, 78.9629], 5); 

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(routeMapInstance);

    // 1. Check Cache
    if (!appCache.routeOutlets || appCache.routeOutlets.length === 0) {
        // If map is opened before list is loaded, trigger load
        // But usually, list loads on init.
        return; 
    }

    const markers = [];
    
    // 2. Plot All Shops from Cache
    appCache.routeOutlets.forEach(shop => {
        if(shop.lat && shop.lng) {
            const marker = L.marker([shop.lat, shop.lng])
                .addTo(routeMapInstance)
                .bindPopup(`
                    <b>${shop.name}</b><br>
                    <span style="font-size:10px; color:gray;">${shop.routeName}</span>
                `);
            markers.push(marker);
        }
    });

    // 3. Auto-Fit
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

    if (currentVisitId) {
        alert("⚠️ You have an active visit!\n\nPlease click 'End Visit' before switching tabs.");
        return; // STOP execution
    }
   


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
        if(typeof loadRouteOnMap === 'function') loadRouteOnMap(); 
        // Leaflet resize fix
        setTimeout(() => { if(window.map) window.map.invalidateSize(); }, 100);
    }

    // 3. Update Bottom Nav Styles
    document.querySelectorAll('.bottom-nav-item').forEach(el => {
        el.classList.remove('active', 'text-indigo-600'); 
        el.classList.add('text-slate-400');
    });

    const activeBtn = document.getElementById('nav-' + viewName);
    if(activeBtn) {
        activeBtn.classList.add('active', 'text-indigo-600');
        activeBtn.classList.remove('text-slate-400');
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

        // 2. Prepare Order Data (DENORMALIZED)
        const orderData = {
            salesmanId: auth.currentUser.uid,
            salesmanName: appCache.user?.fullName || auth.currentUser.email, // Store Name
            outletId: currentOrderOutlet.id,
            outletName: currentOrderOutlet.name, // Store Name
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
