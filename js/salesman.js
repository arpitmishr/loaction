// js/salesman.js

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, query, where, getDocs, orderBy, addDoc, Timestamp, GeoPoint 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const content = document.getElementById('content');
const loader = document.getElementById('loader');

// --- INIT ---
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'index.html'; return; }

    try {
        // 1. Check Role
        const userDoc = await getDoc(doc(db, "users", user.uid));
        if (!userDoc.exists() || userDoc.data().role !== 'salesman') {
            alert("Access Denied.");
            logoutUser();
            return;
        }

        // 2. Show UI
        if (loader) loader.style.display = 'none';
        content.style.display = 'block';

        // 3. Load Data
        checkTodayAttendance(user);
        loadAssignedRoute(user.uid); // Pass UID to find route

        // 4. Attach Listeners
        const checkInBtn = document.getElementById('checkInBtn');
        if(checkInBtn) checkInBtn.addEventListener('click', () => handleCheckIn(user));

    } catch (error) {
        console.error("Init Error:", error);
        alert("Error: " + error.message);
    }
});

document.getElementById('logoutBtn').addEventListener('click', logoutUser);

// --- ROUTE & OUTLETS ---

async function loadAssignedRoute(uid) {
    const routeNameEl = document.getElementById('route-name');
    const shopsListEl = document.getElementById('shops-list');
    const debugEl = document.getElementById('route-debug');

    // Debug info for you to see on screen
    debugEl.innerText = `Searching for route assigned to User ID: ${uid}`;

    try {
        // Find Route
        const q = query(collection(db, "routes"), where("assignedSalesmanId", "==", uid));
        const routeSnap = await getDocs(q);

        if (routeSnap.empty) {
            routeNameEl.innerText = "No Route Assigned";
            shopsListEl.innerHTML = "<li style='padding:10px;'>Contact Admin to assign a route.</li>";
            debugEl.innerText += " -> No document found in 'routes' collection.";
            return;
        }

        const routeDoc = routeSnap.docs[0];
        const routeId = routeDoc.id;
        routeNameEl.innerText = routeDoc.data().name;
        debugEl.innerText = ""; // Clear debug if found

        // Load Outlets for this Route
        loadRouteOutlets(routeId, uid);

    } catch (error) {
        console.error("Route Error:", error);
        routeNameEl.innerText = "Error Loading Route";
        shopsListEl.innerHTML = `<li style="color:red">Error: ${error.message}</li>`;
    }
}

async function loadRouteOutlets(routeId, uid) {
    const list = document.getElementById('shops-list');
    
    try {
        // Note: This query requires an Index: routeId ASC, sequence ASC
        const q = query(
            collection(db, "route_outlets"), 
            where("routeId", "==", routeId),
            orderBy("sequence", "asc")
        );
        
        const snap = await getDocs(q);
        list.innerHTML = '';

        if (snap.empty) {
            list.innerHTML = '<li style="padding:10px;">No shops added to this route yet.</li>';
            return;
        }

        snap.forEach(doc => {
            const data = doc.data();
            const li = document.createElement('li');
            li.style.background = "white";
            li.style.margin = "10px 0";
            li.style.padding = "15px";
            li.style.borderRadius = "8px";
            li.style.border = "1px solid #ddd";
            li.style.display = "flex";
            li.style.justifyContent = "space-between";
            li.style.alignItems = "center";

            li.innerHTML = `
                <div>
                    <strong style="font-size:1.1rem;">${data.outletName}</strong>
                    <div style="font-size:0.9rem; color:#666;">Sequence: ${data.sequence}</div>
                </div>
                <button class="visit-btn" data-id="${data.outletId}" data-name="${data.outletName}" 
                    style="background:#007bff; color:white; border:none; padding:8px 15px; border-radius:5px; cursor:pointer;">
                    Visit 🚀
                </button>
            `;
            list.appendChild(li);
        });

        // Add Click Listeners to "Visit" buttons
        document.querySelectorAll('.visit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const outletId = e.target.dataset.id;
                const outletName = e.target.dataset.name;
                handleVisit(uid, outletId, outletName, e.target);
            });
        });

    } catch (error) {
        console.error("Outlets Error:", error);
        if(error.message.includes("index")) {
            list.innerHTML = `<li style="color:red; font-weight:bold;">⚠️ Missing Index. Tell Admin to check Console.</li>`;
        } else {
            list.innerHTML = `<li>Error: ${error.message}</li>`;
        }
    }
}

// --- VISIT ACTION ---

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
                // Save Visit to Firestore
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
                btnElement.style.background = "#28a745"; // Green

            } catch (error) {
                console.error("Visit Error:", error);
                alert("Failed to save visit: " + error.message);
                btnElement.disabled = false;
                btnElement.innerText = "Visit 🚀";
            }
        },
        (err) => {
            alert("Location required to visit.");
            btnElement.disabled = false;
            btnElement.innerText = "Visit 🚀";
        }
    );
}

// --- ATTENDANCE (Keep existing logic) ---
function getTodayDateString() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, '0') + "-" + String(d.getDate()).padStart(2, '0');
}

async function checkTodayAttendance(user) {
    const statusEl = document.getElementById('attendance-status');
    const btn = document.getElementById('checkInBtn');
    
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
    } catch (e) { console.error(e); }
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
        } catch (e) { alert("Error: " + e.message); btn.innerText = "Check In"; }
    });
}
