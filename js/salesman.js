// js/salesman.js

// 1. IMPORTS
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, query, where, getDocs, orderBy, addDoc, Timestamp, GeoPoint 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const content = document.getElementById('content');
const loader = document.getElementById('loader');

console.log("Script loaded. Waiting for Auth...");

// --- 2. MAIN EXECUTION ---
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        console.log("No user. Redirecting...");
        window.location.href = 'index.html';
        return;
    }

    console.log("User logged in:", user.uid);

    try {
        // A. Check Role
        const userDoc = await getDoc(doc(db, "users", user.uid));
        
        if (!userDoc.exists()) {
            alert("Error: User profile not found in 'users' collection.");
            return;
        }

        if (userDoc.data().role !== 'salesman') {
            alert("Access Denied: Salesman role required.");
            logoutUser();
            return;
        }

        // B. Show Dashboard
        if (loader) loader.style.display = 'none';
        if (content) content.style.display = 'block';

        // C. Load Data
        checkTodayAttendance(user);
        
        // D. Load Route (Critical Step)
        loadAssignedRoute(user.uid);

        // E. Attach Event Listeners
        const checkInBtn = document.getElementById('checkInBtn');
        if(checkInBtn) checkInBtn.addEventListener('click', () => handleCheckIn(user));

    } catch (error) {
        console.error("Init Error:", error);
        alert("System Error: " + error.message);
    }
});

document.getElementById('logoutBtn').addEventListener('click', logoutUser);


// --- 3. ROUTE LOGIC (DEBUGGED) ---

async function loadAssignedRoute(uid) {
    const routeNameEl = document.getElementById('route-name');
    const shopsListEl = document.getElementById('shops-list');
    const debugEl = document.getElementById('route-debug'); // Ensure this element exists in HTML or ignore

    console.log("Looking for route for UID:", uid);
    if(routeNameEl) routeNameEl.innerText = "Searching for Route...";

    try {
        // Query: Find route where assignedSalesmanId == current user ID
        const q = query(collection(db, "routes"), where("assignedSalesmanId", "==", uid));
        const routeSnap = await getDocs(q);

        if (routeSnap.empty) {
            console.warn("No route document found for this UID.");
            if(routeNameEl) routeNameEl.innerText = "No Route Assigned";
            if(shopsListEl) shopsListEl.innerHTML = "<li style='padding:15px; color:orange;'>Contact Admin to assign a route.</li>";
            return;
        }

        // Route Found
        const routeDoc = routeSnap.docs[0];
        const routeData = routeDoc.data();
        console.log("Route Found:", routeData.name, "ID:", routeDoc.id);

        if(routeNameEl) routeNameEl.innerText = routeData.name;
        
        // Load Outlets for this Route
        loadRouteOutlets(routeDoc.id, uid);

    } catch (error) {
        console.error("Load Route Error:", error);
        if(routeNameEl) routeNameEl.innerText = "Error Loading Route";
        if(shopsListEl) shopsListEl.innerHTML = `<li style="color:red; padding:15px;">Error: ${error.message}</li>`;
    }
}

async function loadRouteOutlets(routeId, uid) {
    const list = document.getElementById('shops-list');
    if(!list) return;
    
    list.innerHTML = '<li>Loading shops...</li>';
    console.log("Loading outlets for Route ID:", routeId);

    try {
        // Query: Get outlets for route, ordered by sequence
        // NOTE: This often fails if Index is missing
        const q = query(
            collection(db, "route_outlets"), 
            where("routeId", "==", routeId),
            orderBy("sequence", "asc")
        );
        
        const snap = await getDocs(q);
        
        list.innerHTML = ""; // Clear loading text

        if (snap.empty) {
            console.log("Route has no outlets.");
            list.innerHTML = '<li style="padding:15px;">No shops added to this route yet.</li>';
            return;
        }

        console.log(`Found ${snap.size} outlets.`);

        snap.forEach(doc => {
            const data = doc.data();
            const li = document.createElement('li');
            li.style.cssText = "background:white; margin:10px 0; padding:15px; border-radius:8px; border:1px solid #ddd; display:flex; justify-content:space-between; align-items:center;";

            li.innerHTML = `
                <div>
                    <strong style="font-size:1.1rem;">${data.outletName}</strong>
                    <div style="font-size:0.9rem; color:#666;">Seq: ${data.sequence}</div>
                </div>
                <button class="visit-btn" data-id="${data.outletId}" data-name="${data.outletName}" 
                    style="background:#007bff; color:white; border:none; padding:8px 15px; border-radius:5px; cursor:pointer;">
                    Visit 🚀
                </button>
            `;
            list.appendChild(li);
        });

        // Attach listeners to new buttons
        document.querySelectorAll('.visit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => handleVisit(uid, e.target.dataset.id, e.target.dataset.name, e.target));
        });

    } catch (error) {
        console.error("Load Outlets Error:", error);
        
        // SPECIFIC ERROR MESSAGE FOR MISSING INDEX
        if (error.message.includes("index")) {
            list.innerHTML = `<li style="color:red; font-weight:bold; padding:15px;">
                ⚠️ Database Index Missing.<br>
                1. Open Console (F12)<br>
                2. Click the Firebase Link in Red<br>
                3. Create Index
            </li>`;
        } else {
            list.innerHTML = `<li style="color:red; padding:15px;">Error: ${error.message}</li>`;
        }
    }
}

// --- 4. ACTION LOGIC ---

async function handleVisit(uid, outletId, outletName, btnElement) {
    if(!confirm(`Start visit for ${outletName}?`)) return;

    if (!navigator.geolocation) {
        alert("Geolocation not supported.");
        return;
    }

    btnElement.disabled = true;
    btnElement.innerText = "Locating...";

    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            try {
                await addDoc(collection(db, "visits"), {
                    salesmanId: uid,
                    outletId: outletId,
                    outletName: outletName,
                    checkInTime: Timestamp.now(),
                    location: new GeoPoint(pos.coords.latitude, pos.coords.longitude),
                    type: "routine_visit"
                });

                alert("Visit Started! ✅");
                btnElement.innerText = "Visited";
                btnElement.style.background = "#28a745";

            } catch (error) {
                console.error("Visit Error:", error);
                alert("Failed: " + error.message);
                btnElement.disabled = false;
                btnElement.innerText = "Visit 🚀";
            }
        },
        (err) => {
            alert("Location required.");
            btnElement.disabled = false;
            btnElement.innerText = "Visit 🚀";
        }
    );
}

// --- 5. ATTENDANCE LOGIC ---

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
        console.error("Attendance Error:", e);
        if(e.message.includes("index")) console.warn("Missing Index for Attendance");
    }
}

function handleCheckIn(user) {
    const btn = document.getElementById('checkInBtn');
    if (!navigator.geolocation) return alert("No GPS");
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
            alert("Checked In!");
            checkTodayAttendance(user);
        } catch (e) { 
            alert("Error: " + e.message); 
            btn.innerText = "Check In"; 
        }
    });
}


import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, query, where, getDocs, orderBy, addDoc, updateDoc, Timestamp, GeoPoint 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

// Global Variables for Map & Tracking
let map = null;
let userMarker = null;
let shopMarker = null;
let watchId = null;
let currentVisitId = null;
let visitStartTime = null;
let timerInterval = null;

// --- SETTINGS ---
const GEO_FENCE_RADIUS = 10; // ✅ CHANGED TO 10 METERS

// --- INIT ---
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'index.html'; return; }
    
    try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (!snap.exists() || snap.data().role !== 'salesman') {
            alert("Access Denied"); logoutUser(); return;
        }

        document.getElementById('loader').style.display = 'none';
        document.getElementById('content').style.display = 'block';

        loadAssignedRoute(user.uid);
    } catch (e) {
        console.error("Init Error", e);
    }
});

document.getElementById('logoutBtn').addEventListener('click', logoutUser);


// --- ROUTE LOGIC ---

async function loadAssignedRoute(uid) {
    const routeNameEl = document.getElementById('route-name');
    const shopsListEl = document.getElementById('shops-list');

    try {
        const q = query(collection(db, "routes"), where("assignedSalesmanId", "==", uid));
        const snap = await getDocs(q);

        if (snap.empty) {
            routeNameEl.innerText = "No Route Assigned";
            shopsListEl.innerHTML = "<li>Contact Admin.</li>";
            return;
        }

        const routeDoc = snap.docs[0];
        routeNameEl.innerText = routeDoc.data().name;
        
        loadShops(routeDoc.id);

    } catch (e) { console.error(e); }
}

async function loadShops(routeId) {
    const list = document.getElementById('shops-list');
    
    // Note: Ensure Index exists for route_outlets (routeId ASC, sequence ASC)
    const q = query(collection(db, "route_outlets"), where("routeId", "==", routeId), orderBy("sequence", "asc"));
    const snap = await getDocs(q);

    list.innerHTML = "";
    if(snap.empty) { list.innerHTML = "<li>No shops.</li>"; return; }

    // Fetch details
    for (const docSnap of snap.docs) {
        const routeData = docSnap.data();
        
        // Fetch actual outlet data for GPS
        const outletDoc = await getDoc(doc(db, "outlets", routeData.outletId));
        if(!outletDoc.exists()) continue;
        const outletData = outletDoc.data();

        const li = document.createElement('li');
        li.style.cssText = "background:white; margin:10px 0; padding:15px; border:1px solid #ddd; display:flex; justify-content:space-between; align-items:center;";
        
        li.innerHTML = `
            <div>
                <strong>${routeData.outletName}</strong><br>
                <small>Seq: ${routeData.sequence}</small>
            </div>
            <button class="btn-start" style="background:#007bff; color:white; border:none; padding:8px 15px; border-radius:5px; cursor:pointer;">
                Open 🗺️
            </button>
        `;
        
        li.querySelector('.btn-start').onclick = () => {
            openVisitPanel(routeData.outletId, routeData.outletName, outletData.geo.lat, outletData.geo.lng);
        };
        list.appendChild(li);
    }
}

// --- VISIT & MAP LOGIC ---

window.openVisitPanel = function(outletId, name, shopLat, shopLng) {
    // 1. UI Switch
    document.getElementById('route-view').style.display = 'none';
    document.getElementById('visit-view').style.display = 'block';
    document.getElementById('visit-shop-name').innerText = name;
    
    // Reset Controls
    document.getElementById('btn-geo-checkin').style.display = 'block';
    document.getElementById('in-shop-controls').style.display = 'none';
    document.getElementById('dist-display').innerText = "Locating...";
    
    // 2. Initialize Map
    if(map) { map.remove(); } 
    map = L.map('map').setView([shopLat, shopLng], 18); // Zoom 18 for close view

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(map);

    // Shop Marker
    shopMarker = L.marker([shopLat, shopLng]).addTo(map)
        .bindPopup(`<b>${name}</b><br>Target`).openPopup();

    // User Marker
    userMarker = L.circleMarker([0,0], { radius: 8, color: 'blue' }).addTo(map);

    // 3. Start Watching GPS
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

    if(!navigator.geolocation) { alert("GPS not supported"); return; }

    watchId = navigator.geolocation.watchPosition((pos) => {
        const userLat = pos.coords.latitude;
        const userLng = pos.coords.longitude;
        const accuracy = pos.coords.accuracy; // GPS Accuracy in meters

        // Update User Marker
        userMarker.setLatLng([userLat, userLng]);
        
        // Calculate Distance
        const distMeters = getDistanceFromLatLonInM(userLat, userLng, targetLat, targetLng);
        distDisplay.innerText = `${Math.round(distMeters)}m (GPS Acc: ±${Math.round(accuracy)}m)`;

        // GEO-FENCE LOGIC (Strict 10m)
        if (distMeters <= GEO_FENCE_RADIUS) {
            checkInBtn.disabled = false;
            checkInBtn.innerText = `📍 Check In (${Math.round(distMeters)}m)`;
            checkInBtn.style.background = "#28a745"; // Green
            
            checkInBtn.onclick = () => performCheckIn(outletId, outletName, userLat, userLng);
        } else {
            checkInBtn.disabled = true;
            checkInBtn.innerText = `Move Closer (${Math.round(distMeters)}m)`;
            checkInBtn.style.background = "#6c757d"; // Grey
        }

    }, (err) => {
        console.error(err);
        distDisplay.innerText = "GPS Error";
    }, { 
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 5000 
    });
}


// --- FIRESTORE ACTIONS ---

async function performCheckIn(outletId, outletName, lat, lng) {
    const btn = document.getElementById('btn-geo-checkin');
    const controls = document.getElementById('in-shop-controls');
    
    try {
        btn.innerText = "Signing in...";
        
        // Create Visit Record
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

        // Switch UI
        btn.style.display = 'none';
        controls.style.display = 'block';
        
        startTimer();

        // Bind Actions
        document.getElementById('btn-take-order').onclick = () => {
            alert("Opening Order Form..."); 
            // Implement order logic here
        };

        document.getElementById('btn-end-visit').onclick = () => performEndVisit();

    } catch (error) {
        console.error(error);
        alert("Check-in failed: " + error.message);
    }
}

async function performEndVisit() {
    if(!confirm("End this visit?")) return;
    
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
        console.error(error);
        alert("Error ending visit.");
    }
}

// --- UTILS ---

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

function getDistanceFromLatLonInM(lat1, lon1, lat2, lon2) {
  var R = 6371; 
  var dLat = deg2rad(lat2-lat1); 
  var dLon = deg2rad(lon2-lon1); 
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2); 
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  var d = R * c; 
  return d * 1000; 
}

function deg2rad(deg) {
  return deg * (Math.PI/180)
}
