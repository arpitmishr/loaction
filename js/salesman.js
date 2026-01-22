// 1. IMPORTS
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, query, where, getDocs, orderBy, addDoc, updateDoc, Timestamp, GeoPoint 
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
            
            li.innerHTML = `
                <div>
                    <strong style="font-size:1.1rem;">${routeOutletData.outletName}</strong><br>
                    <small>Seq: ${routeOutletData.sequence}</small>
                </div>
                <button class="btn-open-map" style="background:#007bff; color:white; border:none; padding:8px 15px; border-radius:5px; cursor:pointer;">
                    Open 🗺️
                </button>
            `;
            
            // Attach Click Event to open Map Panel
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


// --- 4. VISIT PANEL & MAP LOGIC ---

window.openVisitPanel = function(outletId, name, shopLat, shopLng) {
    // Switch Views
    document.getElementById('route-view').style.display = 'none';
    document.getElementById('visit-view').style.display = 'block';
    
    document.getElementById('visit-shop-name').innerText = name;
    document.getElementById('dist-display').innerText = "Locating...";
    
    // Reset Controls
    document.getElementById('btn-geo-checkin').style.display = 'block';
    document.getElementById('btn-geo-checkin').disabled = true;
    document.getElementById('btn-geo-checkin').innerText = "Waiting for GPS...";
    document.getElementById('in-shop-controls').style.display = 'none';
    
    // Initialize Map
    if(map) { map.remove(); } // Destroy previous instance
    map = L.map('map').setView([shopLat, shopLng], 18); // High zoom

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(map);

    // Add Shop Marker
    shopMarker = L.marker([shopLat, shopLng]).addTo(map)
        .bindPopup(`<b>${name}</b><br>Target Location`).openPopup();

    // Add User Marker (Blue Circle)
    userMarker = L.circleMarker([0,0], { radius: 8, color: 'blue', fillOpacity: 0.8 }).addTo(map);

    // Start Live Tracking
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
            alert("Opening Order Form..."); 
            // TODO: Redirect to order.html?outletId=...
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
    // Hide all
    document.getElementById('route-view').style.display = 'none';
    document.getElementById('visit-view').style.display = 'none';
    document.getElementById('catalog-view').style.display = 'none';

    // Show selected
    if(viewName === 'route') document.getElementById('route-view').style.display = 'block';
    if(viewName === 'visit') document.getElementById('visit-view').style.display = 'block';
    if(viewName === 'catalog') {
        document.getElementById('catalog-view').style.display = 'block';
        loadProductCatalog(); // Load data when tab is clicked
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
